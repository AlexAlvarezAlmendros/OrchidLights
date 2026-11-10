/**
 * The rig's bodies: one modelled lamp per kind of fixture, built in code.
 *
 * QLC+ ships six meshes for fourteen fixture types, and all six arrived here
 * repainted a flat grey. This file replaces them with procedural models --
 * a moving head that has a base, a yoke that pans and a head that tilts; a
 * PAR can that is not an LED PAR; a strobe, a bar with one cell per head, a
 * laser, a flower, the smoke machines and the fan.
 *
 * Detailed, and cheap on purpose:
 *
 *  - Every part of a model that moves together is MERGED into one geometry,
 *    so a moving head is four draw calls (base, yoke, head, lens) however
 *    many screws it has.
 *  - The merged geometries are a BLUEPRINT, built once per kind and shared by
 *    every fixture of that kind: forty PARs upload one PAR.
 *  - All the body's surfaces -- painted shell, vents, bare metal, the back
 *    panel with its display and connectors -- live in ONE texture atlas, so
 *    one material paints the whole body.
 *  - No asset is downloaded: textures are drawn on a canvas at first use.
 *
 * Conventions every model keeps: metres; the fixture hangs, so its clamp is
 * up (+Y) and it emits straight down (-Y); the origin is the head's pivot,
 * where pan and tilt cross, so the three slots (base, yoke, head) all turn
 * about (0,0,0).
 */

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type FixtureKind =
  | 'spot'
  | 'wash'
  | 'scanner'
  | 'ledpar'
  | 'parcan'
  | 'strobe'
  | 'bar'
  | 'pixelbar'
  | 'laser'
  | 'flower'
  | 'smoke'
  | 'hazer'
  | 'fan'
  | 'generic'

/** What turns with what: the base never moves, the yoke pans, the head
 *  pans and tilts. */
export type Slot = 'base' | 'yoke' | 'head'
type Tile = 'plastic' | 'vent' | 'metal' | 'panel'
type LensSkin = 'glass' | 'led' | 'fresnel' | 'cells'

export interface Blueprint {
  kind: FixtureKind
  shells: Partial<Record<Slot, THREE.BufferGeometry>>
  lenses: Partial<Record<Slot, THREE.BufferGeometry>>
  lensSkin: LensSkin
  /** How far below the pivot the light leaves the head. */
  emitY: number
  /** The aperture's half-size, across (x) and along (z). */
  emitRadius: [number, number]
  /** How fast the beam widens per metre thrown, across and along. */
  slope: [number, number]
  /** The beam's strength in haze; 0 means this kind throws no beam. */
  gain: number
  /** Extents of the rest pose, for standing it on the floor. */
  top: number
  bottom: number
  /** The largest dimension, to scale against the definition's physical one. */
  size: number
  triangles: number
}

/**
 * QLC+'s type string, read into a body. A moving head with colour mixing in
 * its own LEDs is a wash; one without is a spot, lens and all.
 */
export function kindOf(type: string | undefined, roles: { red?: number } = {}): FixtureKind {
  switch (type) {
    case 'Moving Head':
      return roles.red !== undefined ? 'wash' : 'spot'
    case 'Scanner':
      return 'scanner'
    case 'Color Changer':
      return 'ledpar'
    case 'Dimmer':
      return 'parcan'
    case 'Strobe':
      return 'strobe'
    case 'LED Bar (Beams)':
      return 'bar'
    case 'LED Bar (Pixels)':
      return 'pixelbar'
    case 'Laser':
      return 'laser'
    case 'Flower':
    case 'Effect':
      return 'flower'
    case 'Smoke':
      return 'smoke'
    case 'Hazer':
      return 'hazer'
    case 'Fan':
      return 'fan'
    default:
      return 'generic'
  }
}

/* ------------------------------------------------------------------ */
/* The atlas: four surfaces in one texture, two tiles by two.          */

const TILE_AT: Record<Tile, [number, number]> = {
  plastic: [0, 0],
  vent: [1, 0],
  metal: [0, 1],
  panel: [1, 1],
}
/** Kept clear at every tile's edge, so mipmaps do not bleed a neighbour in. */
const TILE_INSET = 0.04

/** Squeeze a primitive's 0..1 UVs into its tile of the atlas. */
function skin(geometry: THREE.BufferGeometry, tile: Tile) {
  const uv = geometry.getAttribute('uv')
  const [column, row] = TILE_AT[tile]
  const span = 1 - TILE_INSET * 2
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i)))
    const v = Math.min(1, Math.max(0, uv.getY(i)))
    /* Canvas rows run down, texture v runs up: row 0 is the TOP half. */
    uv.setXY(i, (column + TILE_INSET + u * span) / 2, (1 - row + TILE_INSET + v * span) / 2)
  }
}

/** A small deterministic noise source: the same grain on every machine. */
function grain(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvasOf(size: number) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

interface Atlas {
  colour: THREE.CanvasTexture
  bump: THREE.CanvasTexture
  /** Roughness in green, metalness in blue: three.js's own packing. */
  surface: THREE.CanvasTexture
}
let atlas: Atlas | null = null

function bodyAtlas(): Atlas {
  if (atlas !== null) return atlas
  const T = 256
  const colour = canvasOf(T * 2)
  const bump = canvasOf(T * 2)
  const surface = canvasOf(T * 2)
  const c = colour.getContext('2d')
  const b = bump.getContext('2d')
  const s = surface.getContext('2d')
  if (c !== null && b !== null && s !== null) {
    const random = grain(7)
    const surfaceOf = (roughness: number, metalness: number) =>
      `rgb(0,${Math.round(roughness * 255)},${Math.round(metalness * 255)})`
    b.fillStyle = 'rgb(128,128,128)'
    b.fillRect(0, 0, T * 2, T * 2)

    /* Painted shell: charcoal powder coat with a fine orange-peel grain. */
    c.fillStyle = '#212329'
    c.fillRect(0, 0, T, T)
    s.fillStyle = surfaceOf(0.7, 0.12)
    s.fillRect(0, 0, T, T)
    for (let i = 0; i < 9000; i++) {
      const x = random() * T
      const y = random() * T
      const light = random() > 0.5
      c.fillStyle = light ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.09)'
      c.fillRect(x, y, 1.5, 1.5)
      b.fillStyle = light ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'
      b.fillRect(x, y, 1.5, 1.5)
    }

    /* Vents: dark slats with a lit lower lip each. */
    c.fillStyle = '#1b1d21'
    c.fillRect(T, 0, T, T)
    s.fillStyle = surfaceOf(0.8, 0.1)
    s.fillRect(T, 0, T, T)
    for (let y = 10; y < T - 8; y += 18) {
      c.fillStyle = '#08090b'
      c.fillRect(T + 14, y, T - 28, 9)
      c.fillStyle = '#4b515c'
      c.fillRect(T + 14, y + 9, T - 28, 1.5)
      b.fillStyle = 'rgb(0,0,0)'
      b.fillRect(T + 14, y, T - 28, 9)
      b.fillStyle = 'rgb(220,220,220)'
      b.fillRect(T + 14, y + 9, T - 28, 2)
    }

    /* Bare metal: brushed aluminium, streaked along the brush. */
    c.fillStyle = '#9da3ab'
    c.fillRect(0, T, T, T)
    s.fillStyle = surfaceOf(0.36, 1)
    s.fillRect(0, T, T, T)
    for (let i = 0; i < 520; i++) {
      const y = T + random() * T
      const x = random() * T
      const length = 30 + random() * 160
      const light = random() > 0.5
      c.fillStyle = light ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'
      c.fillRect(x, y, length, 1)
      b.fillStyle = light ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'
      b.fillRect(x, y, length, 1)
      s.fillStyle = `rgba(0,${light ? 60 : 140},255,0.18)`
      s.fillRect(x, y, length, 1)
    }

    /* The back panel: display, menu keys, DMX in and out, power, label. */
    const px = T
    const py = T
    c.fillStyle = '#1b1d22'
    c.fillRect(px, py, T, T)
    s.fillStyle = surfaceOf(0.5, 0.2)
    s.fillRect(px, py, T, T)
    c.strokeStyle = '#3d424c'
    c.lineWidth = 2
    c.strokeRect(px + 12, py + 12, T - 24, T - 24)
    c.fillStyle = '#123c72'
    c.fillRect(px + 28, py + 30, 112, 56)
    c.fillStyle = '#8fc3ff'
    c.fillRect(px + 36, py + 40, 64, 6)
    c.fillRect(px + 36, py + 54, 88, 6)
    c.fillRect(px + 36, py + 68, 40, 6)
    c.fillStyle = '#d9dce1'
    c.fillRect(px + 160, py + 30, 68, 34)
    c.fillStyle = '#2a2d33'
    c.fillRect(px + 166, py + 38, 56, 3)
    c.fillRect(px + 166, py + 46, 40, 3)
    c.fillRect(px + 166, py + 54, 48, 3)
    for (let i = 0; i < 4; i++) {
      const x = px + 44 + i * 30
      c.fillStyle = '#4a505b'
      c.beginPath()
      c.arc(x, py + 112, 9, 0, Math.PI * 2)
      c.fill()
      b.fillStyle = 'rgb(230,230,230)'
      b.beginPath()
      b.arc(x, py + 112, 9, 0, Math.PI * 2)
      b.fill()
    }
    const socket = (x: number, pins: number, body: string) => {
      c.fillStyle = '#7b828d'
      c.beginPath()
      c.arc(x, py + 186, 30, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = body
      c.beginPath()
      c.arc(x, py + 186, 23, 0, Math.PI * 2)
      c.fill()
      b.fillStyle = 'rgb(30,30,30)'
      b.beginPath()
      b.arc(x, py + 186, 23, 0, Math.PI * 2)
      b.fill()
      c.fillStyle = '#c9a54a'
      for (let i = 0; i < pins; i++) {
        const angle = Math.PI * (0.15 + (0.7 * i) / Math.max(1, pins - 1))
        c.beginPath()
        c.arc(x + Math.cos(angle) * 11, py + 186 + Math.sin(angle) * 11, 3, 0, Math.PI * 2)
        c.fill()
      }
    }
    socket(px + 52, 3, '#07080a')
    socket(px + 126, 3, '#07080a')
    socket(px + 202, 0, '#1c56a3')
  }

  const colourTexture = new THREE.CanvasTexture(colour)
  colourTexture.colorSpace = THREE.SRGBColorSpace
  colourTexture.anisotropy = 4
  atlas = {
    colour: colourTexture,
    bump: new THREE.CanvasTexture(bump),
    surface: new THREE.CanvasTexture(surface),
  }
  return atlas
}

/* ------------------------------------------------------------------ */
/* Lens faces: what each kind of lamp looks like when you look into it. */

const lensTextures = new Map<LensSkin, THREE.CanvasTexture>()

function lensTexture(kind: LensSkin): THREE.CanvasTexture {
  const cached = lensTextures.get(kind)
  if (cached !== undefined) return cached
  const S = 256
  const canvas = canvasOf(S)
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    ctx.fillStyle = '#050506'
    ctx.fillRect(0, 0, S, S)
    const mid = S / 2
    if (kind === 'glass') {
      /* One big front element: a hot core, a dimmer rim, two coatings. */
      const core = ctx.createRadialGradient(mid, mid, 4, mid, mid, mid)
      core.addColorStop(0, 'rgb(255,255,255)')
      core.addColorStop(0.45, 'rgb(215,215,215)')
      core.addColorStop(0.8, 'rgb(120,120,120)')
      core.addColorStop(1, 'rgb(40,40,40)')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(mid, mid, mid - 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 3
      for (const radius of [0.62, 0.84]) {
        ctx.beginPath()
        ctx.arc(mid, mid, mid * radius, 0, Math.PI * 2)
        ctx.stroke()
      }
    } else if (kind === 'fresnel') {
      /* Stepped glass: concentric rings, each catching the lamp its way. */
      for (let radius = mid - 2; radius > 0; radius -= 9) {
        const ring = Math.round(radius / 9)
        const level = (ring % 2 === 0 ? 235 : 150) - (radius / mid) * 60
        ctx.fillStyle = `rgb(${level},${level},${level})`
        ctx.beginPath()
        ctx.arc(mid, mid, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    } else if (kind === 'led') {
      /* A plate of emitters, packed like honeycomb, each under its own lens. */
      const pitch = 34
      for (let row = -5; row <= 5; row++) {
        for (let column = -5; column <= 5; column++) {
          const x = mid + column * pitch + (row % 2 === 0 ? 0 : pitch / 2)
          const y = mid + row * pitch * 0.866
          if (Math.hypot(x - mid, y - mid) > mid - 16) continue
          const dot = ctx.createRadialGradient(x, y, 1, x, y, 13)
          dot.addColorStop(0, 'rgb(255,255,255)')
          dot.addColorStop(0.55, 'rgb(190,190,190)')
          dot.addColorStop(1, 'rgb(28,28,28)')
          ctx.fillStyle = dot
          ctx.beginPath()
          ctx.arc(x, y, 13, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    } else {
      /* A tileable field of emitters: strobes and pixel cells repeat it. */
      const pitch = S / 4
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
          const x = column * pitch + pitch / 2
          const y = row * pitch + pitch / 2
          const dot = ctx.createRadialGradient(x, y, 2, x, y, pitch * 0.42)
          dot.addColorStop(0, 'rgb(255,255,255)')
          dot.addColorStop(0.6, 'rgb(170,170,170)')
          dot.addColorStop(1, 'rgb(24,24,24)')
          ctx.fillStyle = dot
          ctx.beginPath()
          ctx.arc(x, y, pitch * 0.42, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 4
  lensTextures.set(kind, texture)
  return texture
}

let glow: THREE.CanvasTexture | null = null
/** The halation around a lamp you are looking into: a soft radial bloom. */
export function glowTexture(): THREE.CanvasTexture {
  if (glow !== null) return glow
  const canvas = canvasOf(128)
  const ctx = canvas.getContext('2d')
  if (ctx !== null) {
    const radial = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    radial.addColorStop(0, 'rgba(255,255,255,1)')
    radial.addColorStop(0.12, 'rgba(255,255,255,0.75)')
    radial.addColorStop(0.35, 'rgba(255,255,255,0.2)')
    radial.addColorStop(0.7, 'rgba(255,255,255,0.05)')
    radial.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = radial
    ctx.fillRect(0, 0, 128, 128)
  }
  glow = new THREE.CanvasTexture(canvas)
  glow.colorSpace = THREE.SRGBColorSpace
  return glow
}

/* ------------------------------------------------------------------ */
/* The kit: primitives go in, one merged geometry per slot comes out.  */

type Vec = [number, number, number]

class Kit {
  private shells: Record<Slot, THREE.BufferGeometry[]> = { base: [], yoke: [], head: [] }
  private lenses: Record<Slot, THREE.BufferGeometry[]> = { base: [], yoke: [], head: [] }

  private place(geometry: THREE.BufferGeometry, at: Vec, turn: Vec) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...at),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn)),
      new THREE.Vector3(1, 1, 1),
    )
    geometry.applyMatrix4(matrix)
    /* Rounded boxes come unindexed and the rest indexed; a merge wants one
       kind, and unindexed is the one both can become. */
    return geometry.index === null ? geometry : geometry.toNonIndexed()
  }

  /** A part of the body, painted with one of the atlas's surfaces. */
  put(
    slot: Slot,
    tile: Tile,
    geometry: THREE.BufferGeometry,
    at: Vec = [0, 0, 0],
    turn: Vec = [0, 0, 0],
  ) {
    skin(geometry, tile)
    this.shells[slot].push(this.place(geometry, at, turn))
  }

  /** A light-emitting face; its UVs address the lens texture untouched. */
  glass(slot: Slot, geometry: THREE.BufferGeometry, at: Vec = [0, 0, 0], turn: Vec = [0, 0, 0]) {
    this.lenses[slot].push(this.place(geometry, at, turn))
  }

  finish(
    kind: FixtureKind,
    optics: Pick<Blueprint, 'lensSkin' | 'emitY' | 'emitRadius' | 'slope' | 'gain'>,
  ): Blueprint {
    const shells: Blueprint['shells'] = {}
    const lenses: Blueprint['lenses'] = {}
    const bounds = new THREE.Box3()
    let triangles = 0
    for (const slot of ['base', 'yoke', 'head'] as const) {
      for (const [parts, into] of [
        [this.shells[slot], shells],
        [this.lenses[slot], lenses],
      ] as const) {
        if (parts.length === 0) continue
        const merged = mergeGeometries(parts)
        for (const part of parts) part.dispose()
        merged.computeBoundingBox()
        merged.computeBoundingSphere()
        if (merged.boundingBox !== null) bounds.union(merged.boundingBox)
        triangles += merged.getAttribute('position').count / 3
        into[slot] = merged
      }
    }
    const size = bounds.getSize(new THREE.Vector3())
    return {
      kind,
      shells,
      lenses,
      ...optics,
      top: bounds.max.y,
      bottom: bounds.min.y,
      size: Math.max(size.x, size.y, size.z),
      triangles,
    }
  }
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d)
const shell = (w: number, h: number, d: number, radius: number) =>
  new RoundedBoxGeometry(w, h, d, 2, radius)
/** A cylinder along Y; turn it with the part's rotation to lay it down. */
const tube = (top: number, bottom: number, height: number, segments = 20) =>
  new THREE.CylinderGeometry(top, bottom, height, segments)
const ring = (radius: number, thickness: number) =>
  new THREE.TorusGeometry(radius, thickness, 6, 24).rotateX(Math.PI / 2)
/** A flat round face looking down, textured edge to edge. */
const disc = (radius: number) => new THREE.CircleGeometry(radius, 24).rotateX(Math.PI / 2)
/** A flat rectangular face looking down; the texture repeats `u` by `v`. */
function pane(width: number, depth: number, u = 1, v = 1) {
  const geometry = new THREE.PlaneGeometry(width, depth).rotateX(Math.PI / 2)
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v)
  return geometry
}
/** A domed front element bulging down, textured as seen from below. */
function dome(radius: number, depth: number) {
  const geometry = new THREE.SphereGeometry(radius, 20, 5, 0, Math.PI * 2, 0, Math.PI / 2)
  geometry.scale(1, depth / radius, 1).rotateX(Math.PI)
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, position.getX(i) / (radius * 2) + 0.5, position.getZ(i) / (radius * 2) + 0.5)
  }
  return geometry
}

/** A flat face looking up: where a panel is printed on one side only. */
const label = (width: number, depth: number) =>
  new THREE.PlaneGeometry(width, depth).rotateX(-Math.PI / 2)

const LAID_X: Vec = [0, 0, Math.PI / 2]
const LAID_Z: Vec = [Math.PI / 2, 0, 0]

/** The hook that bites the truss: a block and an open jaw above it. */
function clamp(kit: Kit, x: number, y: number) {
  kit.put('base', 'metal', box(0.05, 0.035, 0.05), [x, y, 0])
  kit.put(
    'base',
    'metal',
    new THREE.TorusGeometry(0.032, 0.009, 6, 12, Math.PI * 1.5),
    [x, y + 0.046, 0],
    [0, 0, -Math.PI * 0.25],
  )
}

/** The strap a fixed lamp hangs in: a bar over the top and two arms down to
 *  the pivot, with the locking knobs outside. */
function bracket(kit: Kit, half: number, top: number, depth = 0.04) {
  kit.put('base', 'metal', box(half * 2 + 0.012, 0.012, depth), [0, top, 0])
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, top + 0.03, depth), [side * half, (top - 0.03) / 2, 0])
    kit.put('base', 'plastic', tube(0.026, 0.026, 0.024, 12), [side * (half + 0.018), 0, 0], LAID_X)
  }
  clamp(kit, 0, top + 0.024)
}

function movingHead(wash: boolean): Blueprint {
  const kit = new Kit()
  /* The base: electronics, display, and the bearing the yoke hangs from. */
  kit.put('base', 'plastic', shell(0.3, 0.11, 0.26, 0.02), [0, 0.345, 0])
  kit.put('base', 'panel', box(0.17, 0.08, 0.004), [0, 0.345, 0.131])
  kit.put('base', 'vent', box(0.004, 0.07, 0.17), [0.151, 0.345, 0])
  kit.put('base', 'vent', box(0.004, 0.07, 0.17), [-0.151, 0.345, 0])
  kit.put('base', 'metal', tube(0.09, 0.09, 0.02), [0, 0.282, 0])
  clamp(kit, -0.09, 0.418)
  clamp(kit, 0.09, 0.418)

  /* The yoke: it pans, and carries the head between its arms. */
  kit.put('yoke', 'plastic', shell(0.345, 0.055, 0.12, 0.02), [0, 0.245, 0])
  for (const side of [-1, 1]) {
    kit.put('yoke', 'plastic', shell(0.046, 0.3, 0.11, 0.018), [side * 0.1575, 0.105, 0])
    kit.put('yoke', 'vent', box(0.003, 0.11, 0.07), [side * 0.181, 0.14, 0])
    kit.put('yoke', 'metal', tube(0.036, 0.036, 0.01, 16), [side * 0.184, 0, 0], LAID_X)
  }

  /* The head: it tilts on the axle through the origin. */
  kit.put('head', 'metal', tube(0.026, 0.026, 0.275, 12), [0, 0, 0], LAID_X)
  if (wash) {
    kit.put('head', 'plastic', tube(0.122, 0.128, 0.15, 24), [0, -0.01, 0])
    /* A wash runs hot at the back: a stack of cooling fins. */
    for (let i = 0; i < 5; i++) {
      kit.put('head', 'metal', tube(0.108 - i * 0.006, 0.108 - i * 0.006, 0.007), [
        0,
        0.076 + i * 0.015,
        0,
      ])
    }
    kit.put('head', 'plastic', tube(0.07, 0.07, 0.08), [0, 0.1, 0])
    kit.put('head', 'plastic', ring(0.12, 0.012), [0, -0.086, 0])
    kit.glass('head', disc(0.116), [0, -0.0865, 0])
    return kit.finish('wash', {
      lensSkin: 'led',
      emitY: 0.09,
      emitRadius: [0.11, 0.11],
      slope: [0.19, 0.19],
      gain: 0.34,
    })
  }
  kit.put('head', 'plastic', tube(0.104, 0.114, 0.25, 24), [0, 0, 0])
  kit.put('head', 'vent', tube(0.108, 0.111, 0.07, 24), [0, 0.07, 0])
  kit.put(
    'head',
    'plastic',
    new THREE.SphereGeometry(0.104, 20, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.45, 1),
    [0, 0.125, 0],
  )
  kit.put('head', 'plastic', tube(0.114, 0.1, 0.03, 24), [0, -0.14, 0])
  kit.put('head', 'metal', ring(0.088, 0.008), [0, -0.155, 0])
  kit.glass('head', dome(0.086, 0.03), [0, -0.154, 0])
  return kit.finish('spot', {
    lensSkin: 'glass',
    emitY: 0.17,
    emitRadius: [0.08, 0.08],
    slope: [0.06, 0.06],
    gain: 0.62,
  })
}

function scanner(): Blueprint {
  const kit = new Kit()
  /* The lamp house lies behind the mirror and fires forward into it; the
     origin is the mirror, which is the only part that moves. */
  kit.put('base', 'plastic', shell(0.2, 0.17, 0.52, 0.02), [0, 0.02, -0.4])
  kit.put('base', 'vent', box(0.004, 0.1, 0.3), [0.101, 0.02, -0.42])
  kit.put('base', 'vent', box(0.004, 0.1, 0.3), [-0.101, 0.02, -0.42])
  kit.put('base', 'panel', box(0.15, 0.12, 0.004), [0, 0.02, -0.661])
  kit.put('base', 'metal', tube(0.055, 0.062, 0.05), [0, 0.02, -0.12], LAID_Z)
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.008, 0.02, 0.16), [side * 0.092, 0.05, -0.07])
  }
  kit.put('base', 'metal', box(0.24, 0.012, 0.05), [0, 0.19, -0.4])
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, 0.19, 0.05), [side * 0.114, 0.1, -0.4])
  }
  clamp(kit, 0, 0.214)
  kit.put('base', 'metal', box(0.05, 0.035, 0.05), [0, 0.214, -0.4])

  /* The mirror: a silvered plate on a two-axis motor block. */
  kit.put('head', 'plastic', tube(0.03, 0.03, 0.05, 12), [0, 0.03, 0])
  kit.put('head', 'metal', box(0.15, 0.006, 0.2), [0, 0, 0], [Math.PI / 4, 0, 0])
  kit.glass('head', pane(0.14, 0.19), [0, -0.005, 0.005], [Math.PI / 4, 0, 0])
  return kit.finish('scanner', {
    lensSkin: 'glass',
    emitY: 0.01,
    emitRadius: [0.06, 0.06],
    slope: [0.055, 0.055],
    gain: 0.6,
  })
}

function ledPar(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.136, 0.15)
  kit.put('base', 'plastic', tube(0.116, 0.106, 0.09, 24), [0, 0, 0])
  kit.put('base', 'vent', tube(0.1, 0.108, 0.022, 24), [0, 0.056, 0])
  kit.put('base', 'plastic', box(0.15, 0.03, 0.1), [0, 0.08, 0])
  kit.put('base', 'panel', label(0.14, 0.09), [0, 0.0955, 0])
  kit.put('base', 'plastic', ring(0.108, 0.011), [0, -0.045, 0])
  kit.glass('base', disc(0.104), [0, -0.0465, 0])
  return kit.finish('ledpar', {
    lensSkin: 'led',
    emitY: 0.05,
    emitRadius: [0.1, 0.1],
    slope: [0.2, 0.2],
    gain: 0.3,
  })
}

function parCan(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.126, 0.27)
  /* The can: spun aluminium, a ribbed cap at the back, a rolled lip, and
     the clips that hold the gel frame. */
  kit.put('base', 'plastic', tube(0.1, 0.1, 0.27, 24), [0, 0.025, 0])
  kit.put('base', 'vent', tube(0.062, 0.1, 0.07, 24), [0, 0.195, 0])
  kit.put('base', 'metal', tube(0.03, 0.03, 0.02, 12), [0, 0.238, 0])
  kit.put('base', 'metal', ring(0.1, 0.007), [0, -0.11, 0])
  kit.put('base', 'metal', ring(0.1, 0.004), [0, 0.09, 0])
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4
    kit.put('base', 'metal', box(0.02, 0.03, 0.006), [
      Math.cos(angle) * 0.104,
      -0.1,
      Math.sin(angle) * 0.104,
    ])
  }
  kit.glass('base', disc(0.093), [0, -0.1115, 0])
  return kit.finish('parcan', {
    lensSkin: 'fresnel',
    emitY: 0.115,
    emitRadius: [0.09, 0.09],
    slope: [0.17, 0.17],
    gain: 0.3,
  })
}

function strobe(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.232, 0.15, 0.05)
  kit.put('base', 'plastic', shell(0.43, 0.12, 0.21, 0.015), [0, 0.01, 0])
  kit.put('base', 'vent', box(0.36, 0.004, 0.15), [0, 0.071, 0])
  kit.put('base', 'panel', box(0.2, 0.07, 0.004), [0, 0.012, -0.106])
  /* The reflector's rim, standing proud of the face. */
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.4, 0.008, 0.008), [0, -0.052, side * 0.086])
    kit.put('base', 'metal', box(0.008, 0.008, 0.18), [side * 0.196, -0.052, 0])
  }
  kit.glass('base', pane(0.384, 0.164, 4.5, 2), [0, -0.0505, 0])
  return kit.finish('strobe', {
    lensSkin: 'cells',
    emitY: 0.055,
    emitRadius: [0.19, 0.08],
    slope: [0.3, 0.26],
    gain: 0.24,
  })
}

function bar(pixels: boolean, cells: number, length: number): Blueprint {
  const kit = new Kit()
  kit.put('base', 'plastic', shell(length, 0.075, 0.085, 0.01), [0, 0.03, 0])
  kit.put('base', 'vent', box(length * 0.8, 0.004, 0.05), [0, 0.068, 0])
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, 0.08, 0.09), [side * (length / 2), 0.03, 0])
    /* One hanging bracket a quarter in from each end. */
    kit.put('base', 'metal', box(0.045, 0.07, 0.006), [side * length * 0.3, 0.1, 0])
    clamp(kit, side * length * 0.3, 0.145)
  }
  kit.put('base', 'panel', box(0.11, 0.05, 0.004), [length / 2 - 0.09, 0.03, -0.0435])

  /* One emitter per head: the bar is as many lamps as its mode says. */
  const pitch = (length - 0.04) / cells
  const radius = Math.min(0.032, pitch * 0.44)
  for (let i = 0; i < cells; i++) {
    const x = -length / 2 + 0.02 + pitch * (i + 0.5)
    if (pixels) {
      kit.glass('base', pane(pitch * 0.9, 0.066, 0.5, 0.5), [x, -0.0085, 0])
    } else {
      kit.put('base', 'plastic', ring(radius, 0.004), [x, -0.008, 0])
      kit.glass('base', disc(radius), [x, -0.0085, 0])
    }
  }
  return kit.finish(pixels ? 'pixelbar' : 'bar', {
    lensSkin: pixels ? 'cells' : 'glass',
    emitY: 0.012,
    emitRadius: [length / 2 - 0.02, 0.03],
    slope: pixels ? [0.22, 0.24] : [0.06, 0.1],
    gain: pixels ? 0.22 : 0.3,
  })
}

function laser(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.118, 0.13)
  kit.put('base', 'plastic', shell(0.21, 0.1, 0.27, 0.012), [0, 0.01, 0])
  /* Lasers are all heat sink: fins down both flanks. */
  for (let i = 0; i < 7; i++) {
    const z = -0.1 + i * 0.033
    kit.put('base', 'metal', box(0.222, 0.07, 0.006), [0, 0.012, z])
  }
  kit.put('base', 'panel', box(0.16, 0.07, 0.004), [0, 0.01, -0.136])
  kit.put('base', 'metal', tube(0.034, 0.034, 0.012, 16), [0, -0.044, 0.06])
  kit.glass('base', disc(0.022), [0, -0.0505, 0.06])
  return kit.finish('laser', {
    lensSkin: 'glass',
    emitY: 0.052,
    emitRadius: [0.006, 0.006],
    /* A scanned fan, not a cone: wide across, a blade along. */
    slope: [0.32, 0.004],
    gain: 0.85,
  })
}

function flower(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.146, 0.17)
  kit.put('base', 'plastic', shell(0.27, 0.16, 0.27, 0.022), [0, 0.03, 0])
  kit.put('base', 'vent', box(0.004, 0.09, 0.17), [0.136, 0.04, 0])
  kit.put('base', 'vent', box(0.004, 0.09, 0.17), [-0.136, 0.04, 0])
  kit.put('base', 'panel', box(0.17, 0.09, 0.004), [0, 0.035, -0.136])
  /* The face: a ring of small lenses around one in the middle, each
     throwing its own slice of the pattern. */
  kit.put('base', 'metal', tube(0.118, 0.118, 0.008, 24), [0, -0.052, 0])
  kit.glass('base', dome(0.03, 0.012), [0, -0.056, 0])
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3
    kit.glass('base', dome(0.027, 0.011), [
      Math.cos(angle) * 0.076,
      -0.056,
      Math.sin(angle) * 0.076,
    ])
  }
  return kit.finish('flower', {
    lensSkin: 'glass',
    emitY: 0.06,
    emitRadius: [0.1, 0.1],
    slope: [0.34, 0.34],
    gain: 0.2,
  })
}

function smoke(): Blueprint {
  const kit = new Kit()
  /* Floor furniture: a long heater block, the nozzle out the front, the
     fluid tank riding on the back and a handle to carry it by. */
  kit.put('base', 'plastic', shell(0.22, 0.15, 0.42, 0.02), [0, 0, 0])
  kit.put('base', 'vent', box(0.004, 0.08, 0.26), [0.111, 0, 0.02])
  kit.put('base', 'vent', box(0.004, 0.08, 0.26), [-0.111, 0, 0.02])
  kit.put('base', 'metal', tube(0.03, 0.03, 0.05, 16), [0, 0.01, 0.23], LAID_Z)
  kit.put('base', 'metal', tube(0.016, 0.03, 0.03, 16), [0, 0.01, 0.268], LAID_Z)
  kit.put('base', 'metal', shell(0.13, 0.11, 0.13, 0.02), [0, 0.125, -0.12])
  kit.put('base', 'plastic', tube(0.026, 0.026, 0.02, 12), [0, 0.19, -0.12])
  kit.put('base', 'panel', box(0.16, 0.1, 0.004), [0, 0, -0.211])
  for (const end of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, 0.05, 0.012), [0, 0.095, 0.06 + end * 0.08])
  }
  kit.put('base', 'metal', box(0.016, 0.014, 0.19), [0, 0.125, 0.06])
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.02, 0.02, 0.4), [side * 0.08, -0.084, 0])
  }
  return kit.finish('smoke', {
    lensSkin: 'glass',
    emitY: 0,
    emitRadius: [0.03, 0.03],
    slope: [0, 0],
    gain: 0,
  })
}

function hazer(): Blueprint {
  const kit = new Kit()
  /* A cube that breathes: intake grille, a raked outlet on top, handle. */
  kit.put('base', 'plastic', shell(0.3, 0.2, 0.3, 0.022), [0, 0, 0])
  kit.put('base', 'vent', box(0.2, 0.12, 0.004), [0, 0, 0.151])
  kit.put('base', 'panel', box(0.2, 0.12, 0.004), [0, 0, -0.151])
  kit.put('base', 'metal', tube(0.05, 0.05, 0.09, 20), [0, 0.11, 0.07], [Math.PI / 4, 0, 0])
  kit.put('base', 'plastic', ring(0.05, 0.008), [0, 0.142, 0.102], [Math.PI / 4, 0, 0])
  for (const end of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, 0.05, 0.012), [end * 0.09, 0.125, -0.07])
  }
  kit.put('base', 'metal', box(0.2, 0.014, 0.016), [0, 0.155, -0.07])
  for (const x of [-0.11, 0.11]) {
    for (const z of [-0.11, 0.11]) {
      kit.put('base', 'plastic', tube(0.02, 0.02, 0.016, 10), [x, -0.108, z])
    }
  }
  return kit.finish('hazer', {
    lensSkin: 'glass',
    emitY: 0,
    emitRadius: [0.05, 0.05],
    slope: [0, 0],
    gain: 0,
  })
}

function fan(): Blueprint {
  const kit = new Kit()
  /* A drum on a floor stand, grilles both ends, the motor hub showing. */
  kit.put('base', 'plastic', tube(0.2, 0.2, 0.14, 28), [0, 0.03, 0], LAID_Z)
  kit.put('base', 'vent', tube(0.185, 0.185, 0.004, 28), [0, 0.03, 0.071], LAID_Z)
  kit.put('base', 'vent', tube(0.185, 0.185, 0.004, 28), [0, 0.03, -0.071], LAID_Z)
  kit.put('base', 'metal', tube(0.045, 0.045, 0.012, 16), [0, 0.03, 0.076], LAID_Z)
  kit.put('base', 'metal', ring(0.2, 0.008), [0, 0.03, 0.07], LAID_Z)
  kit.put('base', 'metal', ring(0.2, 0.008), [0, 0.03, -0.07], LAID_Z)
  for (const side of [-1, 1]) {
    kit.put('base', 'metal', box(0.012, 0.26, 0.04), [side * 0.212, -0.09, 0])
    kit.put('base', 'plastic', tube(0.028, 0.028, 0.024, 12), [side * 0.226, 0.03, 0], LAID_X)
    kit.put('base', 'metal', box(0.03, 0.016, 0.3), [side * 0.212, -0.222, 0])
  }
  kit.put('base', 'metal', box(0.44, 0.012, 0.04), [0, -0.216, 0])
  return kit.finish('fan', {
    lensSkin: 'glass',
    emitY: 0,
    emitRadius: [0.1, 0.1],
    slope: [0, 0],
    gain: 0,
  })
}

function generic(): Blueprint {
  const kit = new Kit()
  bracket(kit, 0.112, 0.13)
  kit.put('base', 'plastic', shell(0.2, 0.14, 0.2, 0.02), [0, 0.01, 0])
  kit.put('base', 'vent', box(0.13, 0.004, 0.13), [0, 0.081, 0])
  kit.put('base', 'panel', box(0.14, 0.08, 0.004), [0, 0.015, -0.101])
  kit.put('base', 'metal', ring(0.072, 0.008), [0, -0.06, 0])
  kit.glass('base', dome(0.07, 0.018), [0, -0.06, 0])
  return kit.finish('generic', {
    lensSkin: 'glass',
    emitY: 0.075,
    emitRadius: [0.065, 0.065],
    slope: [0.14, 0.14],
    gain: 0.3,
  })
}

const blueprints = new Map<string, Blueprint>()

/**
 * The shared geometry for a kind. Bars are the one family with a shape of
 * their own per fixture: as many cells as the mode has heads, as long as the
 * definition says.
 */
export function blueprintFor(kind: FixtureKind, heads = 1, length = 1): Blueprint {
  const isBar = kind === 'bar' || kind === 'pixelbar'
  const cells = isBar ? Math.max(1, Math.min(32, heads > 1 ? heads : 8)) : 1
  const span = isBar ? Math.round(Math.max(0.3, Math.min(2.4, length)) * 20) / 20 : 1
  const key = isBar ? `${kind}:${cells}:${span}` : kind
  const cached = blueprints.get(key)
  if (cached !== undefined) return cached

  let built: Blueprint
  if (kind === 'spot' || kind === 'wash') built = movingHead(kind === 'wash')
  else if (kind === 'scanner') built = scanner()
  else if (kind === 'ledpar') built = ledPar()
  else if (kind === 'parcan') built = parCan()
  else if (kind === 'strobe') built = strobe()
  else if (isBar) built = bar(kind === 'pixelbar', cells, span)
  else if (kind === 'laser') built = laser()
  else if (kind === 'flower') built = flower()
  else if (kind === 'smoke') built = smoke()
  else if (kind === 'hazer') built = hazer()
  else if (kind === 'fan') built = fan()
  else built = generic()
  blueprints.set(key, built)
  return built
}

/* ------------------------------------------------------------------ */
/* A fixture on the stage: the blueprint, worn by one lamp.            */

export interface FixtureSpec {
  type?: string | undefined
  roles: { red?: number }
  heads?: number | undefined
  /** The definition's physical block, in millimetres. */
  physical?: { width?: number; height?: number; depth?: number } | undefined
}

export interface FixtureModel {
  blueprint: Blueprint
  /** Everything a click may land on: the base and, inside it, the rest. */
  body: THREE.Group
  /** Turns about Y: pan. */
  yoke: THREE.Group
  /** Turns about X inside the yoke: tilt. Beams hang from here. */
  head: THREE.Group
  shell: THREE.MeshStandardMaterial
  /** Absent on the kinds that give no light. */
  lens: THREE.MeshStandardMaterial | null
  /** Model metres per blueprint metre: the definition's real size. */
  scale: number
  dispose: () => void
}

/**
 * How much bigger or smaller than the blueprint this particular fixture is.
 * Only what the definition actually says, and never absurd: a profile with a
 * typo in its physical block must not put a two-storey PAR on the stage.
 */
export function scaleFor(blueprint: Blueprint, physical: FixtureSpec['physical']): number {
  if (blueprint.kind === 'bar' || blueprint.kind === 'pixelbar') return 1
  const largest = Math.max(physical?.width ?? 0, physical?.height ?? 0, physical?.depth ?? 0)
  if (largest <= 0) return 1
  return Math.max(0.6, Math.min(2.2, largest / 1000 / blueprint.size))
}

export function buildFixture(spec: FixtureSpec, options: { reflections: boolean }): FixtureModel {
  const kind = kindOf(spec.type, spec.roles)
  const longest = Math.max(
    spec.physical?.width ?? 0,
    spec.physical?.height ?? 0,
    spec.physical?.depth ?? 0,
  )
  const blueprint = blueprintFor(kind, spec.heads ?? 1, longest > 0 ? longest / 1000 : 1)
  const scale = scaleFor(blueprint, spec.physical)

  const textures = bodyAtlas()
  const shellMaterial = new THREE.MeshStandardMaterial({
    map: textures.colour,
    bumpMap: textures.bump,
    bumpScale: 1.2,
    roughnessMap: textures.surface,
    metalnessMap: textures.surface,
    roughness: 1,
    /* Bare metal with nothing to reflect is a black hole: without an
       environment the atlas's metal is turned down to painted steel. */
    metalness: options.reflections ? 1 : 0.2,
  })
  const lensMaterial =
    blueprint.gain > 0
      ? new THREE.MeshStandardMaterial({
          color: 0x4a505c,
          map: lensTexture(blueprint.lensSkin),
          emissive: 0x000000,
          emissiveMap: lensTexture(blueprint.lensSkin),
          emissiveIntensity: 1.5,
          roughness: 0.18,
          metalness: 0,
        })
      : null

  const body = new THREE.Group()
  body.name = 'body'
  const yoke = new THREE.Group()
  const head = new THREE.Group()
  yoke.add(head)
  body.add(yoke)

  const groups: Record<Slot, THREE.Group> = { base: body, yoke, head }
  for (const slot of ['base', 'yoke', 'head'] as const) {
    const shellGeometry = blueprint.shells[slot]
    if (shellGeometry !== undefined) {
      const mesh = new THREE.Mesh(shellGeometry, shellMaterial)
      /* The scale lives on the meshes, not the groups: every slot pivots
         about the origin, so the beam hung from the head stays in metres. */
      mesh.scale.setScalar(scale)
      groups[slot].add(mesh)
    }
    const lensGeometry = blueprint.lenses[slot]
    if (lensGeometry !== undefined && lensMaterial !== null) {
      const mesh = new THREE.Mesh(lensGeometry, lensMaterial)
      mesh.scale.setScalar(scale)
      groups[slot].add(mesh)
    }
  }

  return {
    blueprint,
    body,
    yoke,
    head,
    shell: shellMaterial,
    lens: lensMaterial,
    scale,
    /* The geometries and textures are shared and stay; the materials are
       this lamp's own. */
    dispose: () => {
      shellMaterial.dispose()
      lensMaterial?.dispose()
    },
  }
}

/* ------------------------------------------------------------------ */
/* The beam: light in haze, as a volume and not a painted cone.        */

let beamShape: THREE.BufferGeometry | null = null
/** One unit frustum for every beam on the stage; the shader gives each its
 *  own aperture, spread and length. */
function beamGeometry(): THREE.BufferGeometry {
  if (beamShape !== null) return beamShape
  const segments = 40
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    positions.push(Math.cos(angle), 0, Math.sin(angle), Math.cos(angle), -1, Math.sin(angle))
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  beamShape = new THREE.BufferGeometry()
  beamShape.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  beamShape.setIndex(indices)
  return beamShape
}

const BEAM_VERTEX = /* glsl */ `
uniform vec2 uTop;
uniform vec2 uSlope;
uniform float uLength;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float along = -position.y;
  vec2 radius = uTop + uSlope * (along * uLength);
  vec3 placed = vec3(position.x * radius.x, -along * uLength, position.z * radius.y);
  vec2 outward = normalize(vec2(position.x * radius.y, position.z * radius.x) + 1e-6);
  vec3 normal = normalize(vec3(outward.x, 0.5 * (uSlope.x + uSlope.y), outward.y));
  vec4 eye = modelViewMatrix * vec4(placed, 1.0);
  vAlong = along;
  vNormal = normalMatrix * normal;
  vView = -eye.xyz;
  gl_Position = projectionMatrix * eye;
}`

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uEnd;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  /* Looked at through its middle a beam is thick with lit haze; at its
     grazing edge there is almost none. That is the whole difference between
     a volume and a cone of coloured glass. */
  float through = abs(dot(normalize(vNormal), normalize(vView)));
  float body = pow(through, 1.4);
  /* Brightest where it leaves the lens, thinning as it spreads. */
  float reach = uEnd + (1.0 - uEnd) * pow(1.0 - vAlong, 1.7);
  gl_FragColor = vec4(uColor, uOpacity * body * reach);
  #include <colorspace_fragment>
}`

export interface BeamUniforms {
  uColor: { value: THREE.Color }
  uOpacity: { value: number }
  uEnd: { value: number }
  uLength: { value: number }
  uTop: { value: THREE.Vector2 }
  uSlope: { value: THREE.Vector2 }
}

/** A beam for one lamp, hung from its head and thrown down -Y. */
export function buildBeam(
  model: FixtureModel,
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const { blueprint, scale } = model
  const uniforms: BeamUniforms = {
    uColor: { value: new THREE.Color(0xffffff) },
    uOpacity: { value: blueprint.gain },
    uEnd: { value: 0 },
    uLength: { value: 6 },
    uTop: {
      value: new THREE.Vector2(blueprint.emitRadius[0] * scale, blueprint.emitRadius[1] * scale),
    },
    uSlope: { value: new THREE.Vector2(blueprint.slope[0], blueprint.slope[1]) },
  }
  const beam = new THREE.Mesh(
    beamGeometry(),
    new THREE.ShaderMaterial({
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: BEAM_VERTEX,
      fragmentShader: BEAM_FRAGMENT,
      transparent: true,
      /* Light ADDS: additive can only ever brighten, which is the one
         physical truth a beam has. */
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      /* The near wall only. With both walls drawn, a body standing inside
         the beam hid the far one and read as a dark hole punched in the
         light; one wall is the same over a body as over empty air, and a
         body in FRONT of the beam now hides it like a body should. */
      side: THREE.FrontSide,
    }),
  )
  beam.position.y = -blueprint.emitY * scale
  /* The shader moves the vertices; the unit geometry's bounds know nothing
     of where the beam really is. */
  beam.frustumCulled = false
  /* Light is not a thing to click on: a six-metre volume used to steal its
     neighbours' clicks. */
  beam.raycast = () => undefined
  beam.visible = false
  return beam
}
