import { describe, expect, it } from 'vitest'
import { type FixtureKind, blueprintFor, kindOf, scaleFor } from './fixtures3d'

const KINDS: FixtureKind[] = [
  'spot',
  'wash',
  'scanner',
  'ledpar',
  'parcan',
  'strobe',
  'bar',
  'pixelbar',
  'laser',
  'flower',
  'smoke',
  'hazer',
  'fan',
  'generic',
]

describe('kindOf', () => {
  it('reads every QLC+ type into a body of its own', () => {
    expect(kindOf('Moving Head')).toBe('spot')
    expect(kindOf('Moving Head', { red: 3 })).toBe('wash')
    expect(kindOf('Color Changer')).toBe('ledpar')
    expect(kindOf('Dimmer')).toBe('parcan')
    expect(kindOf('LED Bar (Beams)')).toBe('bar')
    expect(kindOf('LED Bar (Pixels)')).toBe('pixelbar')
    expect(kindOf('Effect')).toBe('flower')
    expect(kindOf('Fan')).toBe('fan')
  })

  it('gives an unknown type a lamp rather than nothing', () => {
    expect(kindOf(undefined)).toBe('generic')
    expect(kindOf('Other')).toBe('generic')
  })
})

describe('blueprints', () => {
  it.each(KINDS)('%s is modelled, textured inside the atlas, and cheap', (kind) => {
    const blueprint = blueprintFor(kind)
    expect(blueprint.shells.base).toBeDefined()
    /* Detailed but light: a rig of a hundred must stay a trivial load. */
    expect(blueprint.triangles).toBeGreaterThan(150)
    expect(blueprint.triangles).toBeLessThan(5000)
    /* The origin is where the plan puts the lamp and where a click on it
       lands: the body has to be around it. */
    expect(blueprint.top).toBeGreaterThan(0)
    expect(blueprint.bottom).toBeLessThan(0)
    for (const geometry of Object.values(blueprint.shells)) {
      const uv = geometry.getAttribute('uv')
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0)
        expect(uv.getX(i)).toBeLessThanOrEqual(1)
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0)
        expect(uv.getY(i)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is built once per kind and shared', () => {
    expect(blueprintFor('ledpar')).toBe(blueprintFor('ledpar'))
  })

  it('gives light to the lamps and none to the machines', () => {
    for (const kind of KINDS) {
      const blueprint = blueprintFor(kind)
      const machine = kind === 'smoke' || kind === 'hazer' || kind === 'fan'
      expect(blueprint.gain > 0).toBe(!machine)
      expect(Object.keys(blueprint.lenses).length > 0).toBe(!machine)
    }
  })

  it('articulates only what moves', () => {
    expect(blueprintFor('spot').shells.yoke).toBeDefined()
    expect(blueprintFor('spot').shells.head).toBeDefined()
    expect(blueprintFor('ledpar').shells.yoke).toBeUndefined()
    expect(blueprintFor('scanner').shells.head).toBeDefined()
  })

  it('cuts a bar to its heads and its length', () => {
    const short = blueprintFor('bar', 4, 0.5)
    const long = blueprintFor('bar', 12, 1.2)
    expect(long.size).toBeGreaterThan(short.size)
    expect(long.triangles).toBeGreaterThan(short.triangles)
    expect(blueprintFor('bar', 12, 1.21)).toBe(long)
  })
})

describe('scaleFor', () => {
  it('follows the definition and refuses the absurd', () => {
    const par = blueprintFor('ledpar')
    expect(scaleFor(par, undefined)).toBe(1)
    expect(scaleFor(par, { width: 0, height: 0, depth: 0 })).toBe(1)
    expect(scaleFor(par, { height: par.size * 1500 })).toBeCloseTo(1.5)
    expect(scaleFor(par, { height: 90000 })).toBe(2.2)
    expect(scaleFor(par, { height: 5 })).toBe(0.6)
  })
})
