import { describe, expect, it } from 'vitest'
import { type VcWidget, groupIntoRows } from './layout'
import { CREATABLE, placeBelow } from './widgets'

function widget(id: number, x: number, y: number, width = 100, height = 50): VcWidget {
  return { type: 'button', id, geometry: { x, y, width, height } }
}

describe('placeBelow', () => {
  it('puts a new widget in a row of its own, below everything else', () => {
    // The property that matters, checked against the rule that actually
    // decides it: a new button must not be spliced into the colour bank the
    // designer built at the top of the console.
    const existing = [widget(1, 0, 10), widget(2, 120, 10), widget(3, 0, 200)]
    const created = { ...widget(4, 0, 0), geometry: placeBelow(existing, 'button') }

    const rows = groupIntoRows([...existing, created])

    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2], [3], [4]])
  })

  it('clears a tall fader rather than landing beside it', () => {
    // A 400 px fader's row starts at its top, so "below the last y" is not
    // enough -- it has to clear the bottom.
    const fader = widget(1, 0, 100, 60, 400)
    const created = { ...widget(2, 0, 0), geometry: placeBelow([fader], 'button') }

    expect(groupIntoRows([fader, created])).toHaveLength(2)
  })

  it('starts at the top of an empty page', () => {
    expect(placeBelow([], 'button').y).toBeGreaterThan(0)
    expect(placeBelow([], 'button').x).toBe(0)
  })

  it('gives each type a size that suits it', () => {
    // A fader is tall and narrow, a label is wide and short. Getting this
    // backwards would not break anything, it would just look wrong on every
    // console anyone builds.
    const fader = placeBelow([], 'slider')
    const label = placeBelow([], 'label')

    expect(fader.height).toBeGreaterThan(fader.width)
    expect(label.width).toBeGreaterThan(label.height)
  })

  it('falls back to a usable size for a type it does not know', () => {
    const unknown = placeBelow([], 'xypad')

    expect(unknown.width).toBeGreaterThan(0)
    expect(unknown.height).toBeGreaterThan(0)
  })

  it('only offers types the console can actually render', () => {
    // Creating a widget the interface draws as a grey box is worse than not
    // offering it: it looks like the feature exists.
    expect(CREATABLE.map((c) => c.type)).toEqual([
      'button',
      'slider',
      'label',
      'cuelist',
      'clock',
      'frame',
    ])
  })
})
