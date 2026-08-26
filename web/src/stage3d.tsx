/**
 * The 3D stage: the rig as it hangs, beams as they burn.
 *
 * three.js against the same truths every other screen uses -- the plan's
 * millimetres (F18 gave them a height), the fixture list's types, and the
 * live DMX frames. Meshes come from the daemon (the .dae files QLC+ 5
 * ships); a type without one gets a primitive, said plainly by looking
 * different rather than by being invisible.
 *
 * The beams speak a GENERIC angle model (pan 0..255 over 360°, tilt leaning
 * up to 90° off straight down) because the definitions' physical degrees are
 * not in the plan payload; the fine calibration arrives when they are. The
 * inverted flags apply here exactly as on the plan's needles.
 *
 * Picking (F22b): a click on the floor aims the chosen moving heads at that
 * point -- the same generic model, inverted, written to the live desk.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { type FixtureState, type PlanFixture, type PlanState, api } from './api'
import { aimOf, colourOf } from './plan'

const MESH_BY_TYPE: Record<string, string> = {
  'Moving Head': 'moving_head.dae',
  Scanner: 'scanner.dae',
  Strobe: 'strobe.dae',
  Smoke: 'smoke.dae',
  Hazer: 'hazer.dae',
  'Color Changer': 'par.dae',
  Dimmer: 'par.dae',
}

interface Rigged {
  fixture: PlanFixture
  steerable: boolean
  root: THREE.Group
  beam: THREE.Mesh
  beamPivot: THREE.Group
}

export function Stage3D({
  universes,
  onError,
}: {
  universes: Record<number, Uint8Array>
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

  useEffect(() => {
    Promise.all([api.plan(), api.fixtures()])
      .then(([planState, fixtureList]) => {
        setPlan(planState)
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
    const cam = new THREE.PerspectiveCamera(55, width / height, 0.1, 200)
    /* High enough that the rig (lamps hang at 1-4 m) is in frame, not just
       the floor: the first framing cut every fixture off the top edge. */
    cam.position.set(0, stageD * 1.05 + 1.5, stageD * 1.5)
    cameraRef.current = cam

    const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high' })
    renderer.setSize(width, height)
    /* Nothing shines through the stage: a 6 m beam from a 3.5 m truss used
       to keep going below the floor as a spike out of the underworld. */
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)]
    element.appendChild(renderer.domElement)

    /* Placing, before orbiting: the drag handler registers FIRST, so a drag
       that starts on a lamp claims the gesture (stopImmediatePropagation)
       and the camera stays put. Plain drag moves the lamp on its own height
       plane; Shift rides it up and down; Alt turns it. A tap still chooses. */
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
      const lamps = [...rig.current.values()].map((n) => n.root)
      const hit = caster.intersectObjects(lamps, true)[0]
      if (hit === undefined) return null
      let node: THREE.Object3D | null = hit.object
      while (node !== null && !node.name.startsWith('fixture-')) node = node.parent
      if (node === null) return null
      return rig.current.get(Number(node.name.replace('fixture-', ''))) ?? null
    }

    let drag: {
      node: Rigged
      mode: 'move' | 'height' | 'rotate'
      moved: boolean
      startClientX: number
      startClientY: number
      startPosition: THREE.Vector3
      startRotation: number
    } | null = null
    let justDragged = false

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const node = lampAt(event)
      if (node === null) return

      event.stopImmediatePropagation()
      renderer.domElement.setPointerCapture(event.pointerId)
      drag = {
        node,
        mode: event.altKey ? 'rotate' : event.shiftKey ? 'height' : 'move',
        moved: false,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPosition: node.root.position.clone(),
        startRotation: node.root.rotation.y,
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (drag === null) return
      const dx = event.clientX - drag.startClientX
      const dy = event.clientY - drag.startClientY
      if (!drag.moved && Math.hypot(dx, dy) < 5) return
      drag.moved = true

      if (drag.mode === 'rotate') {
        /* Half a degree per pixel: a hand's sweep is a full turn. */
        drag.node.root.rotation.y = drag.startRotation - (dx * Math.PI) / 360
        return
      }

      caster.setFromCamera(pointAt(event), cam)
      if (drag.mode === 'move') {
        /* On the lamp's own height plane: placing must never change the
           hang, or dragging across the stage would also drop the rig. */
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -drag.startPosition.y)
        const hit = new THREE.Vector3()
        if (caster.ray.intersectPlane(plane, hit) === null) return
        drag.node.root.position.x = Math.max(-stageW / 2, Math.min(stageW / 2, hit.x))
        drag.node.root.position.z = Math.max(-stageD / 2, Math.min(stageD / 2, hit.z))
      } else {
        /* Height rides a camera-facing wall through the lamp, so the hand
           moves in screen-vertical and the lamp follows. */
        const facing = new THREE.Vector3()
        cam.getWorldDirection(facing)
        facing.y = 0
        if (facing.lengthSq() === 0) return
        facing.normalize()
        const plane = new THREE.Plane(facing, -facing.dot(drag.startPosition))
        const hit = new THREE.Vector3()
        if (caster.ray.intersectPlane(plane, hit) === null) return
        drag.node.root.position.y = Math.max(0, Math.min(10, hit.y))
      }
    }

    const onPointerUp = () => {
      if (drag === null) return
      const { node, moved, mode } = drag
      drag = null

      if (!moved) {
        /* A tap: choosing, exactly as before. */
        const id = node.fixture.id
        setChosen((current) =>
          current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
        )
        return
      }

      justDragged = true

      /* Back to the file's units: plan x/y are stage millimetres, z is the
         hang, rotation is the plan's clockwise degrees. */
      const position = node.root.position
      const patch: { x?: number; y?: number; z?: number; rotation?: number } =
        mode === 'rotate'
          ? { rotation: Math.round((((-node.root.rotation.y * 180) / Math.PI) % 360) * 10) / 10 }
          : mode === 'height'
            ? { z: Math.round(position.y * 1000) }
            : {
                x: Math.round((position.x + stageW / 2) * 1000),
                y: Math.round((position.z + stageD / 2) * 1000),
              }
      api
        .setPlanPosition(node.fixture.id, patch)
        .then(() => {
          if (patch.x !== undefined) node.fixture.x = patch.x
          if (patch.y !== undefined) node.fixture.y = patch.y
          if (patch.z !== undefined) node.fixture.z = patch.z
        })
        .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    const controls = new OrbitControls(cam, renderer.domElement)
    /* Orbit around the middle of the AIR the rig lives in, not the floor's
       origin -- orbiting the floor keeps pushing the lamps off-screen. */
    controls.target.set(0, 1.2, 0)
    controls.update()
    controlsRef.current = controls

    scene.add(new THREE.AmbientLight(0x50535f, 2.4))
    const moon = new THREE.DirectionalLight(0x8888aa, 1)
    moon.position.set(5, 10, 5)
    scene.add(moon)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(stageW, stageD),
      new THREE.MeshStandardMaterial({ color: 0x181a20, roughness: 0.9 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.name = 'floor'
    scene.add(floor)
    scene.add(
      new THREE.GridHelper(Math.max(stageW, stageD), Math.max(stageW, stageD), 0x2a2f38, 0x22252c),
    )

    /* The rig. Meshes load async; a box stands in until each lands. */
    const loader = new ColladaLoader()
    const meshCache = new Map<string, Promise<THREE.Object3D | null>>()
    const meshFor = (type: string | undefined): Promise<THREE.Object3D | null> => {
      const file = type !== undefined ? MESH_BY_TYPE[type] : undefined
      if (file === undefined) return Promise.resolve(null)
      let cached = meshCache.get(file)
      if (cached === undefined) {
        cached = new Promise((resolve) => {
          loader.load(
            `/api/v1/meshes/fixtures/${file}`,
            (collada) => resolve(collada?.scene ?? null),
            undefined,
            () => resolve(null),
          )
        })
        meshCache.set(file, cached)
      }
      return cached.then((object) => (object === null ? null : object.clone(true)))
    }

    const placed = plan.fixtures.filter(
      (f) => f.x !== undefined && f.y !== undefined && f.hidden !== true,
    )
    for (const fixture of placed) {
      const type = fixtures.find((x) => x.id === fixture.id)?.type
      const steerable = fixture.roles.pan !== undefined || fixture.roles.tilt !== undefined

      const root = new THREE.Group()
      root.name = `fixture-${fixture.id}`
      root.position.set(
        (fixture.x ?? 0) / 1000 - stageW / 2,
        (fixture.z ?? 0) / 1000,
        (fixture.y ?? 0) / 1000 - stageD / 2,
      )
      root.rotation.y = (-(fixture.rotation ?? 0) * Math.PI) / 180

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.25, 0.3),
        /* Bright enough to find and click on a dark stage: the point of the
           bodies is being pickable, and 0x30343c on 0x0d0e11 was a rig you
           could not see, let alone choose from. */
        new THREE.MeshStandardMaterial({ color: 0x646c7a, emissive: 0x171a20 }),
      )
      root.add(body)
      void meshFor(type).then((mesh) => {
        if (mesh === null) return
        /* The .dae files declare <unit meter="1"/> and the loader honours
           it: they arrive in metres already. The 0.001 that used to live here
           shrank every body to a third of a millimetre -- a rig you could
           prove existed (the picking worked) but never see. */
        /* One body language for the whole rig: the .dae files arrive with
           their own near-black materials, which on this stage made the mesh
           an invisibility cloak -- the box it replaced could at least be
           seen and clicked. */
        mesh.traverse((part) => {
          if ((part as THREE.Mesh).isMesh) {
            ;(part as THREE.Mesh).material = new THREE.MeshStandardMaterial({
              color: 0x646c7a,
              emissive: 0x171a20,
            })
          }
        })
        root.remove(body)
        root.add(mesh)
      })

      /* The beam: a cone hanging from a pivot so pan spins and tilt leans
         exactly like the generic model says. */
      const beamPivot = new THREE.Group()
      beamPivot.name = `beam-${fixture.id}`
      const length = 6
      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.6, length, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          /* Light ADDS. Under normal blending a white beam was a milky grey
             veil that turned DARK wherever a body sat behind it -- an
             anti-light. Additive can only ever brighten, which is the one
             physical truth a beam has. */
          blending: THREE.AdditiveBlending,
        }),
      )
      /* Cone apex at the fixture, spreading down. The old PI flip put the
         BASE at the lamp: light leaving a lens six metres wide and landing in
         a point is a projector running backwards. */
      beam.position.y = -length / 2
      beamPivot.add(beam)
      root.add(beamPivot)

      scene.add(root)
      rig.current.set(fixture.id, { fixture, steerable, root, beam, beamPivot })
    }

    /* Picking: a click on the floor aims the chosen movers there. Choosing a
       lamp lives on pointerup now (a tap is a drag that never moved), and the
       click that follows a real drag must not aim the rig at wherever the
       hand happened to let go. */
    const onClick = (event: MouseEvent) => {
      if (justDragged) {
        justDragged = false
        return
      }
      if (lampAt(event) !== null) return

      caster.setFromCamera(pointAt(event), cam)
      const hit = caster.intersectObject(floor)[0]
      if (hit !== undefined) aimAt(hit.point.x, hit.point.z)
    }
    renderer.domElement.addEventListener('click', onClick)

    /* The render loop reads the LIVE frames every pass: the beams are the
       DMX, not a copy of it. */
    let alive = true
    const paint = () => {
      if (!alive) return
      for (const node of rig.current.values()) {
        const colour = colourOf(node.fixture, framesRef.current)
        const material = node.beam.material as THREE.MeshBasicMaterial
        if (colour === null) {
          material.opacity = 0
        } else {
          material.color = new THREE.Color(colour)
          material.opacity = 0.35
        }
        const aim = aimOf(node.fixture, framesRef.current)
        if (aim !== null) {
          node.beamPivot.rotation.y = (-aim.angle * Math.PI) / 180
          node.beamPivot.rotation.x = (aim.lean * 90 * Math.PI) / 180
        }
        node.root.traverse((child) => {
          if (child.name === 'chosen-ring')
            child.visible = chosenRef.current.includes(node.fixture.id)
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
        return {
          pan: (-node.beamPivot.rotation.y * 180) / Math.PI,
          tilt: (node.beamPivot.rotation.x * 180) / Math.PI,
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
    }

    return () => {
      alive = false
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      renderer.dispose()
      element.removeChild(renderer.domElement)
      rig.current.clear()
      ;(window as unknown as Record<string, unknown>).__orchidStage = undefined
    }
  }, [plan, fixtures, quality, aimAt, onError])

  /* The four cameras of the reference. */
  useEffect(() => {
    const cam = cameraRef.current
    const controls = controlsRef.current
    if (cam === null || controls === null || plan === null) return
    const stageD = plan.grid.units === 'feet' ? plan.grid.depth * 0.3048 : plan.grid.depth
    const stageW = plan.grid.units === 'feet' ? plan.grid.width * 0.3048 : plan.grid.width
    if (camera === 'top') cam.position.set(0, Math.max(stageW, stageD) * 1.4, 0.01)
    else if (camera === 'front') cam.position.set(0, 1.7, stageD * 1.4)
    else if (camera === 'lado') cam.position.set(stageW * 1.4, 1.7, 0)
    else cam.position.set(0, stageD * 0.9, stageD * 1.2)
    controls.target.set(0, 0, 0)
    controls.update()
  }, [camera, plan])

  return (
    <div className="stage3d">
      <div className="stage3d-bar">
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
        <span className="spacer" />
        <span className="hint">
          {chosen.length > 0
            ? `${chosen.length} elegidas: clic en el suelo para apuntarlas`
            : 'Toca una lámpara para elegirla; arrastra para colocarla (Mayús: altura, Alt: giro)'}
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
      <div ref={mount} className="stage3d-canvas" />
    </div>
  )
}

export default Stage3D
