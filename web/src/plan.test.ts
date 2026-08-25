import { describe, expect, it } from 'vitest'
import type { PlanFixture } from './api'
import { aimOf, colourOf, colourValues, parseHex } from './plan'

/**
 * What colour a lamp is showing, from the frame on the wire.
 *
 * This is the whole of the plan's honesty: the drawing is only as true as this
 * function. Every case below is a fixture that exists on real rigs, and the two
 * that matter most are the ones that must come out *dark* -- a plan that paints
 * an unlit lamp is a plan that sends somebody looking for a fault that is not
 * there.
 */

const fixture = (over: Partial<PlanFixture>): PlanFixture => ({
  id: 0,
  name: 'Test',
  universe: 1,
  address: 0,
  channels: 8,
  resolved: true,
  roles: {},
  ...over,
})

const frame = (values: Record<number, number>) => {
  const bytes = new Uint8Array(512)
  for (const [index, value] of Object.entries(values)) bytes[Number(index)] = value
  return { 1: bytes }
}

describe('colourOf', () => {
  it('mixes RGB', () => {
    const rgb = fixture({ roles: { red: 0, green: 1, blue: 2 } })
    expect(colourOf(rgb, frame({ 0: 255, 1: 128, 2: 0 }))).toBe('rgb(255, 128, 0)')
  })

  it('scales by the dimmer', () => {
    const rgbd = fixture({ roles: { red: 0, green: 1, blue: 2, intensity: 3 } })
    expect(colourOf(rgbd, frame({ 0: 255, 1: 255, 2: 255, 3: 128 }))).toBe('rgb(128, 128, 128)')
  })

  it('treats a dimmer-only lamp as white', () => {
    const dimmer = fixture({ roles: { intensity: 0 } })
    expect(colourOf(dimmer, frame({ 0: 255 }))).toBe('rgb(255, 255, 255)')
  })

  it('reads CMY as the subtractive mix it is', () => {
    // Cyan at full takes the red out; the lamp is cyan, not red.
    const cmy = fixture({ roles: { cyan: 0, magenta: 1, yellow: 2 } })
    expect(colourOf(cmy, frame({ 0: 255, 1: 0, 2: 0 }))).toBe('rgb(0, 255, 255)')
  })

  it('adds white on top of the mix', () => {
    const rgbw = fixture({ roles: { red: 0, green: 1, blue: 2, white: 3 } })
    expect(colourOf(rgbw, frame({ 0: 100, 1: 0, 2: 0, 3: 100 }))).toBe('rgb(200, 100, 100)')
  })

  it('warms with amber instead of whitening', () => {
    // Amber is not white with a different name: it must leave the blues alone,
    // or an amber wash on the plan reads as a cold one.
    const rgba = fixture({ roles: { red: 0, green: 1, blue: 2, amber: 3 } })
    expect(colourOf(rgba, frame({ 3: 200 }))).toBe('rgb(200, 150, 0)')
  })

  it('is dark when the dimmer is down, whatever the colour says', () => {
    // The trap: red at full behind a dimmer at zero is an unlit lamp, and a
    // plan that draws it red sends somebody chasing a fault that is not there.
    const rgbd = fixture({ roles: { red: 0, green: 1, blue: 2, intensity: 3 } })
    expect(colourOf(rgbd, frame({ 0: 255, 1: 0, 2: 0, 3: 0 }))).toBeNull()
  })

  it('is dark when every colour channel is at zero', () => {
    const rgb = fixture({ roles: { red: 0, green: 1, blue: 2 } })
    expect(colourOf(rgb, frame({}))).toBeNull()
  })

  it('is dark when no frame for that universe has arrived', () => {
    // Not the same thing as being off, and drawn differently for that reason.
    const rgb = fixture({ universe: 2, roles: { red: 0, green: 1, blue: 2 } })
    expect(colourOf(rgb, frame({ 0: 255 }))).toBeNull()
  })

  it('reads channels as offsets from the address, not from zero', () => {
    const patched = fixture({ address: 100, roles: { red: 0, green: 1, blue: 2 } })
    expect(colourOf(patched, frame({ 100: 255, 101: 0, 102: 0 }))).toBe('rgb(255, 0, 0)')
    // And is not fooled by whatever is at the bottom of the universe.
    expect(colourOf(patched, frame({ 0: 255, 1: 255, 2: 255 }))).toBeNull()
  })

  it('says nothing about a fixture with no channels it understands', () => {
    expect(colourOf(fixture({}), frame({ 0: 255 }))).toBeNull()
  })
})

/**
 * And the other direction: a colour resolved into the channel values that make
 * it. Same roles, same file, so the two cannot drift apart — which is the whole
 * reason the plan can both paint a lamp and drive it.
 */
describe('colourValues', () => {
  const rgbw = fixture({ roles: { red: 0, green: 1, blue: 2, white: 3, intensity: 4 } })

  it('drives red, green and blue', () => {
    expect(colourValues(rgbw, { r: 255, g: 40, b: 0 })).toContainEqual({ channel: 0, value: 255 })
    expect(colourValues(rgbw, { r: 255, g: 40, b: 0 })).toContainEqual({ channel: 1, value: 40 })
  })

  it('takes the white down with it', () => {
    // Red asked for on a bar whose white is still up is pink, and nobody asked
    // for pink.
    expect(colourValues(rgbw, { r: 255, g: 0, b: 0 })).toContainEqual({ channel: 3, value: 0 })
  })

  it('takes the amber down for the same reason', () => {
    const rgba = fixture({ roles: { red: 0, green: 1, blue: 2, amber: 3 } })
    expect(colourValues(rgba, { r: 0, g: 0, b: 255 })).toContainEqual({ channel: 3, value: 0 })
  })

  it('leaves the dimmer alone: colour and intensity are separate questions', () => {
    expect(colourValues(rgbw, { r: 255, g: 0, b: 0 }).some((v) => v.channel === 4)).toBe(false)
  })

  it('inverts for a subtractive fixture', () => {
    const cmy = fixture({ roles: { cyan: 0, magenta: 1, yellow: 2 } })
    expect(colourValues(cmy, { r: 255, g: 0, b: 0 })).toEqual([
      { channel: 0, value: 0 },
      { channel: 1, value: 255 },
      { channel: 2, value: 255 },
    ])
  })

  it('says nothing at all for a fixture with no colour to mix', () => {
    // A plain dimmer cannot be made red, and pretending otherwise would send
    // values to channels that mean something else.
    expect(colourValues(fixture({ roles: { intensity: 0 } }), { r: 255, g: 0, b: 0 })).toEqual([])
  })

  it('round-trips through the reader it is the inverse of', () => {
    const values = colourValues(rgbw, { r: 200, g: 100, b: 20 })
    const bytes = new Uint8Array(512)
    for (const v of values) bytes[v.channel] = v.value
    bytes[4] = 255 // dimmer at full, so nothing is scaled away
    expect(colourOf(rgbw, { 1: bytes })).toBe('rgb(200, 100, 20)')
  })
})

/**
 * The swatch string, taken apart into the numbers the channels want. Small,
 * but it sits at the top of the whole paint pipeline: every colour an operator
 * picks arrives here as "#rrggbb" before colourValues resolves it per fixture.
 */
describe('parseHex', () => {
  it('splits #rrggbb into its three channels', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 })
  })

  it('does not care about case or the leading hash', () => {
    expect(parseHex('FF8000')).toEqual({ r: 255, g: 128, b: 0 })
  })

  it('turns garbage into black rather than NaN', () => {
    // A broken swatch string must never push NaN at a DMX channel.
    expect(parseHex('not-a-colour')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('feeds colourValues: the paint pipeline end to end', () => {
    const rgb = fixture({ roles: { red: 0, green: 1, blue: 2 } })
    expect(colourValues(rgb, parseHex('#00ff00'))).toContainEqual({ channel: 1, value: 255 })
  })
})

/**
 * Where a moving head points, read off the frame. The needle on the plan is
 * only as true as this: direction from pan, length from how far the beam leans
 * off straight-down, and null for anything that cannot move or is not being
 * received -- a needle on a PAR would send somebody looking for motors that
 * do not exist.
 */
describe('aimOf', () => {
  const head = fixture({ roles: { pan: 0, tilt: 1 } })

  it('says nothing about a lamp with no pan or tilt', () => {
    expect(aimOf(fixture({ roles: { red: 0 } }), frame({ 0: 255 }))).toBeNull()
  })

  it('says nothing when the universe is not being received', () => {
    // Same rule as colourOf: an unknown aim drawn as some aim is a lie.
    const other = fixture({ universe: 2, roles: { pan: 0, tilt: 1 } })
    expect(aimOf(other, frame({ 0: 128 }))).toBeNull()
  })

  it('sweeps the full circle with pan', () => {
    expect(aimOf(head, frame({ 0: 0 }))?.angle).toBe(-180)
    expect(aimOf(head, frame({ 0: 255 }))?.angle).toBe(180)
  })

  it('shows a stub for a beam pointing straight down', () => {
    expect(aimOf(head, frame({ 1: 128 }))?.lean).toBe(0)
  })

  it('stretches to full throw at the end of tilt', () => {
    expect(aimOf(head, frame({ 1: 0 }))?.lean).toBe(1)
  })

  it('flips pan when the fixture is marked inverted', () => {
    // The flags exist for the head hung backwards: the plan must show where
    // the beam goes, not what the raw byte says.
    const inverted = fixture({ roles: { pan: 0, tilt: 1 }, invertPan: true })
    expect(aimOf(inverted, frame({ 0: 0 }))?.angle).toBe(180)
  })

  it('flips tilt when the fixture is marked inverted', () => {
    const inverted = fixture({ roles: { pan: 0, tilt: 1 }, invertTilt: true })
    expect(aimOf(inverted, frame({ 1: 255 }))?.lean).toBe(1)
  })

  it('reads channels as offsets from the address, not from zero', () => {
    const patched = fixture({ address: 100, roles: { pan: 0, tilt: 1 } })
    expect(aimOf(patched, frame({ 100: 255, 101: 0 }))).toEqual({ angle: 180, lean: 1 })
    // And is not fooled by whatever sits at the bottom of the universe.
    expect(aimOf(patched, frame({ 0: 255, 1: 0 }))?.angle).toBe(-180)
  })

  it('still aims a pan-only mover, with the needle long enough to see', () => {
    // No tilt channel means no lean reading; drawing the needle as a stub
    // would hide the one thing this fixture can actually do.
    const panOnly = fixture({ roles: { pan: 0 } })
    const aim = aimOf(panOnly, frame({ 0: 255 }))
    expect(aim?.angle).toBe(180)
    expect(aim?.lean).toBeGreaterThan(0.9)
  })

  it('points a tilt-only mover straight up the plan', () => {
    const tiltOnly = fixture({ roles: { tilt: 0 } })
    const aim = aimOf(tiltOnly, frame({ 0: 0 }))
    expect(aim?.lean).toBe(1)
    expect(Math.abs(aim?.angle ?? 99)).toBeLessThan(1)
  })
})
