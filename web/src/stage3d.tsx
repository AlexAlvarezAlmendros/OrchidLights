/**
 * The 3D stage: the rig as it hangs, beams as they burn.
 *
 * three.js against the same truths every other screen uses -- the plan's
 * millimetres (F18 gave them a height), the fixture list's types, and the
 * live DMX frames. The bodies are modelled in code, one per kind of fixture
 * (fixtures3d.ts): a moving head whose yoke really pans and whose head
 * really tilts, and a PAR that does not look like a strobe.
 *
 * The beams speak a GENERIC angle model (pan 0..255 over 360°, tilt leaning
 * up to 90° off straight down) because the definitions' physical degrees are
 * not in the plan payload; the fine calibration arrives when they are. The
 * inverted flags apply here exactly as on the plan's needles. A lamp left on
 * the floor stands on its base and throws UP: the same model, upside down.
 *
 * Two hands, told apart by a button. RUNNING the show: a tap chooses movers,
 * a click on the floor aims them. EDITING the rig (the Editar toggle): a
 * click selects one element, a Blender-style gizmo moves or turns it, Supr
 * takes it off the stage, the tray puts fixtures on. Every edit goes through
 * the daemon's plan routes, so the global undo (Ctrl+Z) already knows them
 * -- an arrow that moved a lamp the file will not remember never moved it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { type FixtureState, type PlanFixture, type PlanState, api } from './api'
import {
  type BeamUniforms,
  type FixtureModel,
  buildBeam,
  buildFixture,
  glowTexture,
} from './fixtures3d'
import { t } from './i18n'
import { aimOf, colourOf } from './plan'

/** How far a beam that meets no floor is drawn before the haze gives up. */
const FREE_THROW = 7
/** Below this height (mm) a lamp with no hang of its own is standing on the
 *  boards, not hanging a hand above them. */
const FLOOR_HEIGHT = 150

interface Rigged {
  fixture: PlanFixture
  steerable: boolean
  root: THREE.Group
  /** Between the placement and the body: turns the lamp over when it
   *  stands on the floor instead of hanging. */
  mount: THREE.Group
  grounded: boolean
  model: FixtureModel
  beam: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  /** The bloom around a lamp you are looking into. */
  halo: THREE.Sprite
  /** The colour it gives right now, kept so no frame allocates one. */
  colour: THREE.Color
  /** The light landing on the floor, placed each frame from the beam. */
  pool: THREE.Mesh
  /** The run-mode mark under a fixture chosen for aiming. */
  ring: THREE.Mesh
  /** The edit-mode plumb line from the lamp to the floor. */
  dropLine: THREE.Line
}

/** The scene's handles, installed by the build effect for everyone else:
 *  React state changes must reach a world that lives outside React. */
interface StageOps {
  select: (id: number | null) => void
  setMode: (mode: 'translate' | 'rotate') => void
  sync: (planState: PlanState) => void
  place: (fixture: PlanFixture) => void
  /** Blender's Ctrl: snap the gizmo to honest increments while held. */
  setSnap: (on: boolean) => void
  /** Blender's F: bring the orbit centre to the selected element. */
  frameSelected: () => void
}

export function Stage3D({
  universes,
  revision,
  onError,
}: {
  universes: Record<number, Uint8Array>
  /** Bumped by the feed when the project changed under us: an undo, another
   *  client's edit. The scene follows without rebuilding (the camera stays). */
  revision: number
  onError: (message: string | null) => void
}) {
  const mount = useRef<HTMLDivElement | null>(null)
  const rig = useRef<Map<number, Rigged>>(new Map())
  const framesRef = useRef(universes)
  framesRef.current = universes
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [fixtures, setFixtures] = useState<FixtureState[]>([])
  const [quality, setQuality] = useState(() => window.localStorage.getItem('orchid.3d') ?? 'high')
  const [camera, setCamera] = useState('libre')
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const [chosen, setChosen] = useState<number[]>([])
  const chosenRef = useRef(chosen)
  chosenRef.current = chosen

  /* The editing hand. Mirrored into refs because the pointer handlers live
     inside the scene effect and must read the CURRENT mode, not the one the
     closure was born with. */
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate')
  const [selected, setSelected] = useState<number | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const [hover, setHover] = useState<{ id: number; name: string; x: number; y: number } | null>(
    null,
  )
  /* The live numbers while a transform is in flight: precision spoken. */
  const [readout, setReadout] = useState<string | null>(null)
  /* The plan as last read, for the tray of fixtures not yet on the stage. */
  const [planList, setPlanList] = useState<PlanFixture[]>([])
  const [toPlace, setToPlace] = useState('')

  const ops = useRef<StageOps | null>(null)

  useEffect(() => {
    Promise.all([api.plan(), api.fixtures()])
      .then(([planState, fixtureList]) => {
        setPlan(planState)
        setPlanList(planState.fixtures)
        setFixtures(fixtureList)
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }, [onError])

  /** The picking half, exposed for the chapter as well as the pointer: aim
   *  every chosen mover (or all of them) at stage point (x, z) in metres. */
  const aimAt = useCallback(
    (xMeters: number, zMeters: number) => {
      const values: { fixture: number; channel: number; value: number }[] = []
      for (const [id, node] of rig.current) {
        if (!node.steerable) continue
        if (chosenRef.current.length > 0 && !chosenRef.current.includes(id)) continue

        const from = node.root.position
        const dx = xMeters - from.x
        const dz = zMeters - from.z
        const dy = -from.y // down to the floor

        let panDeg = (Math.atan2(dx, dz) * 180) / Math.PI
        const horizontal = Math.sqrt(dx * dx + dz * dz)
        const vertical = (Math.atan2(horizontal, -dy) * 180) / Math.PI

        const roles = node.fixture.roles
        if (node.fixture.invertPan === true) panDeg = -panDeg
        let pan = Math.round(((panDeg + 180) / 360) * 255)
        let tilt = Math.round(128 + (Math.min(90, vertical) / 90) * 127)
        if (node.fixture.invertTilt === true) tilt = 255 - tilt
        pan = Math.max(0, Math.min(255, pan))
        tilt = Math.max(0, Math.min(255, tilt))

        if (roles.pan !== undefined) values.push({ fixture: id, channel: roles.pan, value: pan })
        if (roles.tilt !== undefined) values.push({ fixture: id, channel: roles.tilt, value: tilt })
      }
      if (values.length === 0) return false
      api.setLive(values).catch((e: unknown) => onError(String(e)))
      return true
    },
    [onError],
  )

  useEffect(() => {
    const element = mount.current
    if (element === null || plan === null) return

    const width = element.clientWidth || 800
    const height = element.clientHeight || 500
    const stageW = plan.grid.units === 'feet' ? plan.grid.width * 0.3048 : plan.grid.width
    const stageD = plan.grid.units === 'feet' ? plan.grid.depth * 0.3048 : plan.grid.depth

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d0e11)
    /* A breath of haze: depth cues for free. The beams and floor light are
       exempted (fog: false) -- they ARE the haze catching light. */
    scene.fog = new THREE.FogExp2(0x0d0e11, 0.022)
    const cam = new THREE.PerspectiveCamera(55, width / height, 0.1, 200)
    /* High enough that the rig (lamps hang at 1-4 m) is in frame, not just
       the floor: the first framing cut every fixture off the top edge. */
    cam.position.set(0, stageD * 1.05 + 1.5, stageD * 1.5)
    cameraRef.current = cam

    const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high' })
    /* Sharp on HiDPI glass; Ligera stays at 1 -- that is what it is for. */
    renderer.setPixelRatio(quality === 'high' ? window.devicePixelRatio : 1)
    renderer.setSize(width, height)
    /* Nothing shines through the stage: a 6 m beam from a 3.5 m truss used
       to keep going below the floor as a spike out of the underworld. */
    /* A hair BELOW the boards: a plane at exactly zero cut the floor itself
       along its own rounding errors, a static of pinholes that only showed
       once the floor had light enough to differ from the void behind it. */
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.02)]
    element.appendChild(renderer.domElement)

    /* Something for metal and glass to reflect. A black body on a black
       stage is only ever seen by its highlights; without a room around it
       the truss clamps and lenses are holes. Ligera does without. */
    const reflections = quality === 'high'
    let roomLight: THREE.WebGLRenderTarget | null = null
    if (reflections) {
      const pmrem = new THREE.PMREMGenerator(renderer)
      roomLight = pmrem.fromScene(new RoomEnvironment(), 0.04)
      scene.environment = roomLight.texture
      scene.environmentIntensity = 0.55
      pmrem.dispose()
    }

    /* The canvas follows its container: a resized window used to keep the
       first frame's size forever. */
    const resizer = new ResizeObserver(() => {
      const w = element.clientWidth
      const h = element.clientHeight
      if (w === 0 || h === 0) return
      cam.aspect = w / h
      cam.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    resizer.observe(element)

    const caster = new THREE.Raycaster()
    const pointAt = (event: PointerEvent | MouseEvent) => {
      const box = renderer.domElement.getBoundingClientRect()
      return new THREE.Vector2(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        -(((event.clientY - box.top) / box.height) * 2 - 1),
      )
    }
    const lampAt = (event: PointerEvent | MouseEvent): Rigged | null => {
      caster.setFromCamera(pointAt(event), cam)
      const bodies = [...rig.current.values()]
        .map((n) => n.root.getObjectByName('body'))
        .filter((b): b is THREE.Object3D => b !== undefined)
      const hit = caster.intersectObjects(bodies, true)[0]
      if (hit === undefined) return null
      let node: THREE.Object3D | null = hit.object
      while (node !== null && !node.name.startsWith('fixture-')) node = node.parent
      if (node === null) return null
      return rig.current.get(Number(node.name.replace('fixture-', ''))) ?? null
    }

    const controls = new OrbitControls(cam, renderer.domElement)
    /* Orbit around the middle of the AIR the rig lives in, not the floor's
       origin -- orbiting the floor keeps pushing the lamps off-screen. */
    controls.target.set(0, 1.2, 0)
    /* The camera stays in the venue: never under the stage (a black void
       that reads as a crash), never inside a lamp, never lost in orbit. */
    controls.maxPolarAngle = Math.PI * 0.495
    /* Close enough to read a lamp's back panel, now that it has one. */
    controls.minDistance = 0.7
    controls.maxDistance = Math.max(stageW, stageD) * 6
    controls.update()
    controlsRef.current = controls

    scene.add(new THREE.AmbientLight(0x50535f, 2.4))
    const moon = new THREE.DirectionalLight(0x8888aa, 1)
    moon.position.set(5, 10, 5)
    scene.add(moon)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(stageW, stageD),
      /* The boards stay dark: the room that gives the lamps their
         highlights must not turn a stage into a car park. */
      new THREE.MeshStandardMaterial({ color: 0x181a20, roughness: 0.9, envMapIntensity: 0.2 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.name = 'floor'
    scene.add(floor)
    {
      /* A metre grid the SIZE OF THE FLOOR: GridHelper only knows squares,
         and on a rectangular stage its overhang read as a second, phantom
         stage. */
      const lines: number[] = []
      for (let x = Math.ceil(-stageW / 2); x <= stageW / 2; x++) {
        lines.push(x, 0, -stageD / 2, x, 0, stageD / 2)
      }
      for (let z = Math.ceil(-stageD / 2); z <= stageD / 2; z++) {
        lines.push(-stageW / 2, 0, z, stageW / 2, 0, z)
      }
      const gridGeometry = new THREE.BufferGeometry()
      gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
      scene.add(
        new THREE.LineSegments(
          gridGeometry,
          new THREE.LineBasicMaterial({ color: 0x2f3540, transparent: true, opacity: 0.9 }),
        ),
      )
    }
    /* The stage's own edge, drawn: where the floor ends stops being a
       guess in the dark. */
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(stageW, stageD)),
      new THREE.LineBasicMaterial({ color: 0x4a5262, transparent: true, opacity: 0.9 }),
    )
    edge.rotation.x = -Math.PI / 2
    edge.position.y = 0.005
    scene.add(edge)

    /* The pool's soft heart: a radial falloff, so the light lands as light
       and not as a grey dinner plate with a machined edge. */
    const poolCanvas = document.createElement('canvas')
    poolCanvas.width = 64
    poolCanvas.height = 64
    const poolCtx = poolCanvas.getContext('2d')
    if (poolCtx !== null) {
      poolCtx.fillStyle = 'rgb(0,0,0)'
      poolCtx.fillRect(0, 0, 64, 64)
      const radial = poolCtx.createRadialGradient(32, 32, 2, 32, 32, 32)
      radial.addColorStop(0, 'rgb(255,255,255)')
      radial.addColorStop(0.3, 'rgb(115,115,115)')
      radial.addColorStop(0.7, 'rgb(30,30,30)')
      radial.addColorStop(1, 'rgb(0,0,0)')
      poolCtx.fillStyle = radial
      poolCtx.fillRect(0, 0, 64, 64)
    }
    const poolFade = new THREE.CanvasTexture(poolCanvas)

    /* Hanging or standing. A lamp at floor height with no hang of its own
       is turned over onto its base, and the machines that never hang (smoke,
       haze, fans) are simply set down on their feet. */
    const applyMount = (node: Rigged) => {
      const fixture = node.fixture
      const blueprint = node.model.blueprint
      const onFloor =
        (fixture.z ?? 0) < FLOOR_HEIGHT &&
        (fixture.rotationX ?? 0) === 0 &&
        (fixture.rotationZ ?? 0) === 0
      node.grounded = onFloor && blueprint.gain > 0
      node.mount.rotation.x = node.grounded ? Math.PI : 0
      node.mount.position.y = !onFloor
        ? 0
        : node.grounded
          ? blueprint.top * node.model.scale
          : -blueprint.bottom * node.model.scale
    }

    const applyPlacement = (node: Rigged) => {
      const fixture = node.fixture
      node.root.position.set(
        (fixture.x ?? 0) / 1000 - stageW / 2,
        (fixture.z ?? 0) / 1000,
        (fixture.y ?? 0) / 1000 - stageD / 2,
      )
      node.root.rotation.set(
        ((fixture.rotationX ?? 0) * Math.PI) / 180,
        (-(fixture.rotation ?? 0) * Math.PI) / 180,
        ((fixture.rotationZ ?? 0) * Math.PI) / 180,
      )
      applyMount(node)
    }

    const haloMap = glowTexture()

    const rigOne = (fixture: PlanFixture) => {
      const state = fixtures.find((x) => x.id === fixture.id)
      const steerable = fixture.roles.pan !== undefined || fixture.roles.tilt !== undefined

      const root = new THREE.Group()
      root.name = `fixture-${fixture.id}`
      const mount = new THREE.Group()
      root.add(mount)

      /* The body is the click's one honest target (its group is named
         'body'); the beam and the halo hang inside it and refuse raycasts,
         so lit air never answers for a lamp. */
      const model = buildFixture(
        {
          type: state?.type,
          roles: fixture.roles,
          heads: state?.heads ?? fixture.heads,
          physical: state?.physical,
        },
        { reflections },
      )
      mount.add(model.body)

      /* The beam hangs from the HEAD, so pan and tilt carry it exactly as
         they carry the lens. */
      const beam = buildBeam(model)
      model.head.add(beam)

      /* The hot lens: light SOURCES, and looking into one blooms. */
      const reach = Math.max(model.blueprint.emitRadius[0], model.blueprint.emitRadius[1])
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: haloMap,
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      )
      halo.scale.setScalar(Math.max(0.22, Math.min(0.9, reach * model.scale * 4.5)))
      halo.position.y = -(model.blueprint.emitY * model.scale + 0.015)
      halo.raycast = () => undefined
      halo.visible = false
      model.head.add(halo)

      /* Where the light lands: a disc the paint loop drops on the floor at
         the beam's intersection, sized by throw distance. */
      const pool = new THREE.Mesh(
        new THREE.CircleGeometry(1, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          alphaMap: poolFade,
        }),
      )
      pool.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
      pool.position.y = 0.01
      scene.add(pool)

      /* The run-mode mark: an accent ring on the floor under a fixture
         chosen for aiming -- the hint used to COUNT them while the stage
         showed nothing. */
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.28, 0.36, 32),
        new THREE.MeshBasicMaterial({
          color: 0x7c5cff,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
          depthWrite: false,
          fog: false,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.02
      ring.visible = false
      scene.add(ring)

      /* The plumb line, for reading heights while editing: a lamp floating
         in dark air gives no clue how high it hangs. */
      const dropLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, -1, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x7f8aa3, transparent: true, opacity: 0.9 }),
      )
      dropLine.visible = false
      root.add(dropLine)

      const node: Rigged = {
        fixture,
        steerable,
        root,
        mount,
        grounded: false,
        model,
        beam,
        halo,
        colour: new THREE.Color(0xffffff),
        pool,
        ring,
        dropLine,
      }
      applyPlacement(node)
      scene.add(root)
      rig.current.set(fixture.id, node)
      return node
    }

    for (const fixture of plan.fixtures) {
      if (fixture.x !== undefined && fixture.y !== undefined && fixture.hidden !== true) {
        rigOne(fixture)
      }
    }

    /* The Blender hand: one gizmo, attached to whatever is selected while
       the Editar toggle is on. Its drags never orbit the camera. */
    const gizmo = new TransformControls(cam, renderer.domElement)
    gizmo.setSize(0.9)
    scene.add(gizmo.getHelper())
    let transforming = false
    gizmo.addEventListener('dragging-changed', (event) => {
      transforming = event.value === true
      controls.enabled = !transforming
    })
    /* The stage has edges and a floor; the file has no basement. Clamped
       while dragging, so the gizmo never even shows an illegal spot. */
    gizmo.addEventListener('objectChange', () => {
      const object = gizmo.object
      if (object === undefined) return
      object.position.x = Math.max(-stageW / 2, Math.min(stageW / 2, object.position.x))
      object.position.z = Math.max(-stageD / 2, Math.min(stageD / 2, object.position.z))
      object.position.y = Math.max(0, Math.min(10, object.position.y))
      /* Say the numbers while the hand moves: rounded, so React only hears
         about changes a human can read. */
      if (gizmo.mode === 'rotate') {
        const toDeg = (radians: number) => Math.round((radians * 180) / Math.PI)
        setReadout(
          `${toDeg(-object.rotation.y)}° · x ${toDeg(object.rotation.x)}° · z ${toDeg(object.rotation.z)}°`,
        )
      } else {
        setReadout(
          `x ${(object.position.x + stageW / 2).toFixed(2)} · y ${(object.position.z + stageD / 2).toFixed(2)} · alt ${object.position.y.toFixed(2)} m`,
        )
      }
    })
    /* Let go = written down. The daemon's plan is the truth every other
       screen reads, and its undo ring is what Ctrl+Z talks to. */
    gizmo.addEventListener('mouseUp', () => {
      setReadout(null)
      const id = selectedRef.current
      const node = id === null ? undefined : rig.current.get(id)
      if (node === undefined) return
      const position = node.root.position
      const rotation = node.root.rotation
      const patch =
        gizmo.mode === 'rotate'
          ? {
              rotation: Math.round(((-rotation.y * 180) / Math.PI) * 10) / 10,
              rotationX: Math.round(((rotation.x * 180) / Math.PI) * 10) / 10,
              rotationZ: Math.round(((rotation.z * 180) / Math.PI) * 10) / 10,
            }
          : {
              x: Math.round((position.x + stageW / 2) * 1000),
              y: Math.round((position.z + stageD / 2) * 1000),
              z: Math.round(position.y * 1000),
            }
      api
        .setPlanPosition(node.fixture.id, patch)
        .then(() => {
          Object.assign(node.fixture, patch)
          applyMount(node)
        })
        .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
    })

    /* One hand or the other, decided by the toggle. Running: a tap chooses,
       the floor aims. Editing: a click selects for the gizmo; empty space
       lets go. Never right after a gizmo drag, and never on its handles. */
    const onClick = (event: MouseEvent) => {
      if (transforming || gizmo.axis !== null) return

      const lamp = lampAt(event)
      if (editingRef.current) {
        setSelected(lamp === null ? null : lamp.fixture.id)
        return
      }
      if (lamp !== null) {
        const id = lamp.fixture.id
        setChosen((current) =>
          current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
        )
        return
      }
      caster.setFromCamera(pointAt(event), cam)
      const hit = caster.intersectObject(floor)[0]
      if (hit !== undefined) aimAt(hit.point.x, hit.point.z)
    }
    renderer.domElement.addEventListener('click', onClick)

    /* Hover: the name of what the hand is over, read once per frame rather
       than once per pointer event -- raycasting at pointer rate stutters. */
    let hoverEvent: PointerEvent | null = null
    const onPointerMove = (event: PointerEvent) => {
      hoverEvent = event
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    const onPointerLeave = () => {
      hoverEvent = null
      setHover(null)
    }
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)

    /* Everyone outside this closure edits the scene through these. */
    ops.current = {
      select: (id) => {
        const node = id === null ? undefined : rig.current.get(id)
        if (node === undefined) gizmo.detach()
        else gizmo.attach(node.root)
      },
      setMode: (next) => gizmo.setMode(next),
      sync: (planState) => {
        /* Never while a hand is on the gizmo: our own last write echoing
           back must not yank the object out of it. */
        if (transforming) return
        const seen = new Set<number>()
        for (const fixture of planState.fixtures) {
          if (fixture.x === undefined || fixture.y === undefined || fixture.hidden === true)
            continue
          seen.add(fixture.id)
          const node = rig.current.get(fixture.id)
          if (node === undefined) {
            rigOne(fixture)
          } else {
            node.fixture = fixture
            applyPlacement(node)
          }
        }
        for (const [id, node] of [...rig.current]) {
          if (seen.has(id)) continue
          if (selectedRef.current === id) {
            gizmo.detach()
            setSelected(null)
          }
          scene.remove(node.root)
          scene.remove(node.pool)
          scene.remove(node.ring)
          node.model.dispose()
          node.beam.material.dispose()
          node.halo.material.dispose()
          rig.current.delete(id)
        }
      },
      setSnap: (on) => {
        gizmo.setTranslationSnap(on ? 0.25 : null)
        gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null)
      },
      frameSelected: () => {
        const id = selectedRef.current
        const node = id === null ? undefined : rig.current.get(id)
        if (node === undefined) return
        /* Keep the eye where it is; bring the centre of the world to the
           element. The camera slides in along its own line of sight. */
        node.root.getWorldPosition(lampWorld)
        const offset = cam.position.clone().sub(controls.target)
        if (offset.length() > 6) offset.setLength(6)
        controls.target.copy(lampWorld)
        cam.position.copy(lampWorld).add(offset)
        controls.update()
      },
      place: (fixture) => {
        /* Onto the middle of the stage at head height: visible, grabbable,
           and obviously waiting to be put somewhere real. */
        api
          .setPlanPosition(fixture.id, {
            x: Math.round((stageW / 2) * 1000),
            y: Math.round((stageD / 2) * 1000),
            z: 2000,
          })
          .then(() => api.plan())
          .then((planState) => {
            setPlanList(planState.fixtures)
            ops.current?.sync(planState)
            setSelected(fixture.id)
          })
          .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      },
    }

    /* The render loop reads the LIVE frames every pass: the beams are the
       DMX, not a copy of it. */
    let alive = true
    const down = new THREE.Vector3()
    const lampWorld = new THREE.Vector3()
    const eye = new THREE.Vector3()
    const beamQuat = new THREE.Quaternion()
    const warmth = new THREE.Color(1, 0.93, 0.82)
    const worldUp = new THREE.Vector3(0, 1, 0)
    const poolQuatY = new THREE.Quaternion()
    const poolQuatFlat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI / 2,
    )
    const paint = () => {
      if (!alive) return
      for (const node of rig.current.values()) {
        const { model, beam, halo } = node
        const blueprint = model.blueprint
        const uniforms = beam.material.uniforms as unknown as BeamUniforms
        const poolMaterial = node.pool.material as THREE.MeshBasicMaterial
        const haloMaterial = halo.material

        const colour = colourOf(node.fixture, framesRef.current)
        const lit = colour !== null && blueprint.gain > 0
        if (colour !== null) {
          node.colour.set(colour)
          /* An intensity-only fixture is a halogen lamp, and halogen is not
             studio white: a touch of warmth, like the planta's halo is not. */
          const roles = node.fixture.roles
          if (roles.red === undefined && roles.cyan === undefined && roles.white === undefined) {
            node.colour.multiply(warmth)
          }
        }

        /* The generic model, worn by real joints: the yoke pans about the
           vertical, the head tilts inside it. A lamp standing on the floor
           is the same lamp turned over, so its pan runs the other way. */
        const aim = aimOf(node.fixture, framesRef.current)
        if (aim !== null) {
          const pan = (aim.angle * Math.PI) / 180
          model.yoke.rotation.y = node.grounded ? Math.PI - pan : pan
          model.head.rotation.x = (-aim.lean * 90 * Math.PI) / 180
        }

        beam.visible = lit
        halo.visible = lit
        if (model.lens !== null) {
          if (lit) model.lens.emissive.copy(node.colour)
          else model.lens.emissive.setHex(0x000000)
        }
        if (!lit) {
          poolMaterial.opacity = 0
        } else {
          /* Where the light lands. The beam's own axis, from the lens,
             intersected with the floor: the pool sits there, stretched into
             an ellipse by an oblique throw, and the beam ENDS at the floor. */
          model.head.getWorldQuaternion(beamQuat)
          down.set(0, -1, 0).applyQuaternion(beamQuat)
          const emit = blueprint.emitY * model.scale
          model.head.getWorldPosition(lampWorld).addScaledVector(down, emit)

          let throwLength = FREE_THROW
          if (down.y < -0.15 && lampWorld.y > 0.05) {
            throwLength = Math.min(14, lampWorld.y / -down.y)
            node.pool.position.set(
              lampWorld.x + down.x * throwLength,
              0.01,
              lampWorld.z + down.z * throwLength,
            )
            /* The pool is as wide as the beam that made it. */
            const across = uniforms.uTop.value.x + uniforms.uSlope.value.x * throwLength
            const along = uniforms.uTop.value.y + uniforms.uSlope.value.y * throwLength
            const radius = Math.max(0.2, Math.sqrt(across * along) * 1.15)
            const stretch = Math.min(2.5, 1 / Math.max(0.3, -down.y))
            node.pool.scale.set(radius, radius * stretch, 1)
            poolQuatY.setFromAxisAngle(worldUp, Math.atan2(down.x, down.z))
            node.pool.quaternion.copy(poolQuatY).multiply(poolQuatFlat)
            poolMaterial.color.copy(node.colour)
            poolMaterial.opacity = Math.max(0.22, 0.5 - throwLength * 0.03)
            uniforms.uEnd.value = 0.12
          } else {
            /* Thrown at the sky or along the boards: it dies in the air. */
            poolMaterial.opacity = 0
            uniforms.uEnd.value = 0
          }
          uniforms.uLength.value = throwLength
          uniforms.uColor.value.copy(node.colour)

          /* From inside a beam there is no near wall to see, only the far
             one: the same single layer of light, from the other side. */
          model.head.worldToLocal(eye.copy(cam.position))
          const depth = -eye.y - emit
          const across = uniforms.uTop.value.x + uniforms.uSlope.value.x * depth
          const along = uniforms.uTop.value.y + uniforms.uSlope.value.y * depth
          const inside =
            depth > 0 && depth < throwLength && (eye.x / across) ** 2 + (eye.z / along) ** 2 < 1
          beam.material.side = inside ? THREE.BackSide : THREE.FrontSide

          /* The bloom belongs to whoever the lamp is pointed at: full when
             you look down its barrel, a rim of spill from the side, nothing
             from behind. */
          eye.copy(cam.position).sub(lampWorld).normalize()
          const facing = Math.max(0, down.dot(eye))
          haloMaterial.color.copy(node.colour)
          haloMaterial.opacity = 0.03 + 0.9 * facing * facing
        }

        /* The chosen wear the accent; the selected element wears it too.
           Through emissive, so the body's own surfaces stay readable
           underneath; a lit lamp spills a breath of its colour on itself. */
        const isSelected = editingRef.current && selectedRef.current === node.fixture.id
        const isChosen = !editingRef.current && chosenRef.current.includes(node.fixture.id)
        if (isSelected || isChosen) {
          model.shell.emissive.setHex(0x4a3a99)
        } else if (lit) {
          model.shell.emissive.copy(node.colour).multiplyScalar(0.012)
        } else {
          model.shell.emissive.setHex(0x06070a)
        }
        node.ring.visible = isChosen
        if (isChosen) {
          node.root.getWorldPosition(lampWorld)
          node.ring.position.set(lampWorld.x, 0.02, lampWorld.z)
        }
        node.dropLine.visible = editingRef.current
        if (editingRef.current) node.dropLine.scale.y = Math.max(0.001, node.root.position.y)
      }
      if (hoverEvent !== null && !transforming) {
        const lamp = gizmo.axis === null ? lampAt(hoverEvent) : null
        const box = element.getBoundingClientRect()
        const x = (hoverEvent?.clientX ?? 0) - box.left
        const y = (hoverEvent?.clientY ?? 0) - box.top
        setHover((current) => {
          if (lamp === null) return current === null ? current : null
          /* The hint already names the selected element; a tip on top of its
             own gizmo was furniture over the controls. */
          if (editingRef.current && selectedRef.current === lamp.fixture.id) {
            return current === null ? current : null
          }
          const base = fixtures.find((f) => f.id === lamp.fixture.id)?.name ?? `#${lamp.fixture.id}`
          const name = `${base} · U${lamp.fixture.universe} @ ${lamp.fixture.address + 1} · ${lamp.root.position.y.toFixed(2)} m`
          if (
            current !== null &&
            current.id === lamp.fixture.id &&
            current.x === x &&
            current.y === y
          ) {
            return current
          }
          return { id: lamp.fixture.id, name, x, y }
        })
      }
      controls.update()
      renderer.render(scene, cam)
      requestAnimationFrame(paint)
    }
    paint()

    /* The chapter's honest window into the matrices. */
    ;(window as unknown as Record<string, unknown>).__orchidStage = {
      beamAngles: (id: number) => {
        const node = rig.current.get(id)
        if (node === undefined) return null
        const turned = (node.model.yoke.rotation.y * 180) / Math.PI
        return {
          pan: node.grounded ? 180 - turned : turned,
          tilt: (-node.model.head.rotation.x * 180) / Math.PI,
        }
      },
      aimAt,
      fixtures: () => [...rig.current.keys()],
      /** Where a lamp sits on the canvas, in client pixels: the honest way
       *  for the browser chapter to aim a synthetic pointer at it. */
      screenOf: (id: number) => {
        const node = rig.current.get(id)
        if (node === undefined) return null
        const projected = node.root.position.clone().project(cam)
        const box = renderer.domElement.getBoundingClientRect()
        return {
          x: box.left + ((projected.x + 1) / 2) * box.width,
          y: box.top + ((1 - projected.y) / 2) * box.height,
        }
      },
      positionOf: (id: number) => {
        const node = rig.current.get(id)
        return node === undefined ? null : node.root.position.toArray()
      },
      selectedId: () => selectedRef.current,
      orbitTarget: () => controls.target.toArray(),
      gizmoAxis: () => gizmo.axis,
      gizmoDragging: () => gizmo.dragging,
      /** A live gizmo handle's place on screen, so the chapter can grab the
       *  real arrow instead of teleporting the object behind the UI's back.
       *  Computed along the axis's projected direction: the named groups all
       *  sit AT the gizmo's centre, which is the free-move handle -- exactly
       *  the one an axis test must not grab. */
      gizmoHandleScreen: (axis: string) => {
        const object = gizmo.object
        if (object === undefined) return null
        const axes: Record<string, THREE.Vector3> = {
          X: new THREE.Vector3(1, 0, 0),
          Y: new THREE.Vector3(0, 1, 0),
          Z: new THREE.Vector3(0, 0, 1),
        }
        const direction = axes[axis]
        if (direction === undefined) return null
        const box = renderer.domElement.getBoundingClientRect()
        const toScreen = (world: THREE.Vector3) => {
          const projected = world.clone().project(cam)
          return {
            x: box.left + ((projected.x + 1) / 2) * box.width,
            y: box.top + ((1 - projected.y) / 2) * box.height,
          }
        }
        const centre = new THREE.Vector3()
        object.getWorldPosition(centre)
        const origin = toScreen(centre)
        const tip = toScreen(centre.clone().add(direction))
        const dx = tip.x - origin.x
        const dy = tip.y - origin.y
        const length = Math.hypot(dx, dy)
        if (length === 0) return null
        return { x: origin.x + (dx / length) * 70, y: origin.y + (dy / length) * 70 }
      },
    }

    return () => {
      alive = false
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      resizer.disconnect()
      gizmo.detach()
      gizmo.dispose()
      controls.dispose()
      for (const node of rig.current.values()) {
        node.model.dispose()
        node.beam.material.dispose()
        node.halo.material.dispose()
      }
      roomLight?.dispose()
      renderer.dispose()
      element.removeChild(renderer.domElement)
      rig.current.clear()
      ops.current = null
      ;(window as unknown as Record<string, unknown>).__orchidStage = undefined
    }
  }, [plan, fixtures, quality, aimAt, onError])

  /* Selection and mode reach the gizmo; leaving edit mode lets go. */
  useEffect(() => {
    ops.current?.select(editing ? selected : null)
  }, [selected, editing])
  useEffect(() => {
    ops.current?.setMode(mode)
  }, [mode])

  /* The four cameras of the reference. Dropped in a rewrite once: buttons
     that name views and move nothing are exactly the dishonesty this desk
     is organized against. They keep the free view's orbit centre, so the
     rig never walks off the top of the frame. */
  useEffect(() => {
    const cam = cameraRef.current
    const controls = controlsRef.current
    if (cam === null || controls === null || plan === null) return
    const stageD = plan.grid.units === 'feet' ? plan.grid.depth * 0.3048 : plan.grid.depth
    const stageW = plan.grid.units === 'feet' ? plan.grid.width * 0.3048 : plan.grid.width
    /* Framed on the RIG, not on the venue's origin: a rig hung on one side
       of the stage left the lateral view staring at empty boards. */
    let cx = 0
    let cz = 0
    let count = 0
    for (const node of rig.current.values()) {
      cx += node.root.position.x
      cz += node.root.position.z
      count++
    }
    if (count > 0) {
      cx /= count
      cz /= count
    }
    if (camera === 'top') {
      /* High enough that perspective stops lying about positions (at 1.4x
         the blinders arrived as clipped giants), and centred on the STAGE:
         a plan view answers "where on the boards", so the boards rule the
         frame even when the rig hangs to one side. */
      cam.position.set(0, Math.max(stageW, stageD) * 2.6, 0.01)
      controls.target.set(0, 0, 0)
    } else if (camera === 'front') {
      cam.position.set(cx, 1.7, stageD * 1.4)
      controls.target.set(cx, 1.2, cz)
    } else if (camera === 'lado') {
      cam.position.set(stageW * 1.4, 1.7, cz)
      controls.target.set(cx, 1.2, cz)
    } else {
      cam.position.set(0, stageD * 1.05 + 1.5, stageD * 1.5)
      controls.target.set(0, 1.2, 0)
    }
    controls.update()
  }, [camera, plan])

  /* The project changed under us -- an undo, another client, our own edit
     echoed back. Follow it without rebuilding: the camera must not jump. */
  useEffect(() => {
    if (revision === 0) return
    api
      .plan()
      .then((planState) => {
        setPlanList(planState.fixtures)
        ops.current?.sync(planState)
      })
      .catch(() => undefined)
  }, [revision])

  const removeSelected = useCallback(() => {
    if (selectedRef.current === null) return
    const id = selectedRef.current
    setSelected(null)
    api
      .clearPlanPosition(id)
      .then(() => api.plan())
      .then((planState) => {
        setPlanList(planState.fixtures)
        ops.current?.sync(planState)
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }, [onError])

  /* The editing keyboard: Blender's letters, the desk's keys. Only while
     the toggle is on, and never over a form control. Ctrl combinations pass
     through untouched: Ctrl+Z belongs to the app's global undo. */
  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Control') {
        ops.current?.setSnap(true)
        return
      }
      if (event.ctrlKey || event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === 'g') setMode('translate')
      else if (key === 'r') setMode('rotate')
      else if (key === 'f') ops.current?.frameSelected()
      else if (key === 'escape') setSelected(null)
      else if ((key === 'delete' || key === 'backspace') && selectedRef.current !== null) {
        removeSelected()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') ops.current?.setSnap(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [editing, removeSelected])

  const unplaced = planList.filter((f) => f.x === undefined || f.y === undefined)
  const selectedName =
    selected === null ? null : (fixtures.find((f) => f.id === selected)?.name ?? `#${selected}`)

  return (
    <div className="stage3d">
      <div className="stage3d-bar">
        {/* The four cameras are one choice, drawn as one control. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset cannot be a flex track */}
        <div className="segmented" role="group" aria-label="Cámara">
          {['libre', 'top', 'front', 'lado'].map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={camera === view}
              onClick={() => setCamera(view)}
            >
              {view === 'libre'
                ? 'Libre'
                : view === 'top'
                  ? 'Cenital'
                  : view === 'front'
                    ? 'Frontal'
                    : 'Lateral'}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={editing ? 'stage3d-edit primary' : 'stage3d-edit'}
          aria-pressed={editing}
          onClick={() => {
            setEditing((on) => !on)
            setSelected(null)
          }}
        >
          {editing ? t('Listo') : t('Editar')}
        </button>

        {editing && (
          <>
            <button
              type="button"
              aria-pressed={mode === 'translate'}
              title={t('Mover el elemento elegido (G)')}
              onClick={() => setMode('translate')}
            >
              {t('Mover')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'rotate'}
              title={t('Girar el elemento elegido (R)')}
              onClick={() => setMode('rotate')}
            >
              {t('Girar')}
            </button>
            <button
              type="button"
              className="danger"
              disabled={selected === null}
              title={t('Quitar del escenario (Supr) — la fixture sigue en el patch')}
              onClick={removeSelected}
            >
              {t('Quitar')}
            </button>
            {unplaced.length > 0 && (
              <span className="stage3d-add">
                <select
                  aria-label={t('Fixture que añadir al escenario')}
                  value={toPlace}
                  onChange={(e) => setToPlace(e.target.value)}
                >
                  <option value="">{t('Añadir…')}</option>
                  {unplaced.map((f) => (
                    <option key={f.id} value={f.id}>
                      {fixtures.find((x) => x.id === f.id)?.name ?? `#${f.id}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={toPlace === ''}
                  onClick={() => {
                    const fixture = unplaced.find((f) => f.id === Number(toPlace))
                    if (fixture !== undefined) ops.current?.place(fixture)
                    setToPlace('')
                  }}
                >
                  {t('Colocar')}
                </button>
              </span>
            )}
          </>
        )}

        <span className="spacer" />
        <span className="hint">
          {editing
            ? readout !== null
              ? `${selectedName} · ${readout}`
              : selected === null
                ? t('Clic en un elemento para elegirlo; Ctrl+Z deshace · Ctrl: imán · F: encuadrar')
                : `${selectedName} · ${mode === 'translate' ? t('moviendo (R: girar)') : t('girando (G: mover)')}`
            : chosen.length > 0
              ? `${chosen.length} elegidas: clic en el suelo para apuntarlas`
              : t('Toca una lámpara para elegirla; en el suelo, apuntan todas las móviles')}
        </span>
        <label className="field">
          <span>Calidad</span>
          <select
            value={quality}
            onChange={(e) => {
              setQuality(e.target.value)
              window.localStorage.setItem('orchid.3d', e.target.value)
            }}
          >
            <option value="low">Ligera</option>
            <option value="high">Alta</option>
          </select>
        </label>
      </div>
      <div ref={mount} className="stage3d-canvas">
        {hover !== null && (
          <span
            className="stage3d-tip"
            style={{ left: `${hover.x + 14}px`, top: `${hover.y + 10}px` }}
          >
            {hover.name}
          </span>
        )}
      </div>
    </div>
  )
}

export default Stage3D
