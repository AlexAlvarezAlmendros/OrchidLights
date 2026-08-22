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
    cam.position.set(0, stageD * 0.9, stageD * 1.2)
    cameraRef.current = cam

    const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high' })
    renderer.setSize(width, height)
    element.appendChild(renderer.domElement)

    const controls = new OrbitControls(cam, renderer.domElement)
    controlsRef.current = controls

    scene.add(new THREE.AmbientLight(0x404050, 2))
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
        new THREE.MeshStandardMaterial({ color: 0x30343c }),
      )
      root.add(body)
      void meshFor(type).then((mesh) => {
        if (mesh === null) return
        mesh.scale.setScalar(0.001) // the .dae files are in millimetres
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
        }),
      )
      /* Cone apex at the fixture, spreading down. */
      beam.position.y = -length / 2
      beam.rotation.x = Math.PI
      beamPivot.add(beam)
      root.add(beamPivot)

      scene.add(root)
      rig.current.set(fixture.id, { fixture, steerable, root, beam, beamPivot })
    }

    /* Picking: a click on the floor aims the chosen movers there. */
    const caster = new THREE.Raycaster()
    const onClick = (event: MouseEvent) => {
      const box = renderer.domElement.getBoundingClientRect()
      const at = new THREE.Vector2(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        -(((event.clientY - box.top) / box.height) * 2 - 1),
      )
      caster.setFromCamera(at, cam)

      const lamps = [...rig.current.values()].map((n) => n.root)
      const hitLamp = caster.intersectObjects(lamps, true)[0]
      if (hitLamp !== undefined) {
        let node: THREE.Object3D | null = hitLamp.object
        while (node !== null && !node.name.startsWith('fixture-')) node = node.parent
        if (node !== null) {
          const id = Number(node.name.replace('fixture-', ''))
          setChosen((current) =>
            current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
          )
          return
        }
      }

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
    }

    return () => {
      alive = false
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      element.removeChild(renderer.domElement)
      rig.current.clear()
      ;(window as unknown as Record<string, unknown>).__orchidStage = undefined
    }
  }, [plan, fixtures, quality, aimAt])

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
            : 'Clic en una lámpara para elegirla; en el suelo, apuntan todas las móviles'}
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
