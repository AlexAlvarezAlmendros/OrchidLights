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

  it('stacks repeated additions into successive rows', () => {
    // Adding three widgets one after another must read as three additions,
    // not as one row that grew sideways: each lands below the previous.
    const page: VcWidget[] = []
    for (const type of ['button', 'slider', 'label']) {
      page.push({ ...widget(page.length + 1, 0, 0), type, geometry: placeBelow(page, type) })
    }

    expect(groupIntoRows(page).map((r) => r.widgets.map((w) => w.id))).toEqual([[1], [2], [3]])
  })

  it('clears the lowest edge, not the last listed widget', () => {
    // Children carry no promised order in the .qxw: the bottom-most widget
    // may well be listed first. Placement must clear all of them.
    const siblings = [widget(1, 0, 500), widget(2, 0, 10)]
    const created = { ...widget(3, 0, 0), geometry: placeBelow(siblings, 'button') }

    const rows = groupIntoRows([...siblings, created])

    expect(rows.at(-1)?.widgets.map((w) => w.id)).toEqual([3])
  })

  it('still places a type the palette does not know below everything', () => {
    // A .qxw from a newer build can name a widget type this palette has never
    // heard of. The size falls back; the placement rule must not.
    const created = { ...widget(2, 0, 0), geometry: placeBelow([widget(1, 0, 10)], 'holo-panel') }

    expect(created.geometry.width).toBeGreaterThan(0)
    expect(created.geometry.height).toBeGreaterThan(0)
    expect(groupIntoRows([widget(1, 0, 10), created])).toHaveLength(2)
  })

  it('only offers types the console can actually render', () => {
    // Creating a widget the interface draws as a grey box is worse than not
    // offering it: it looks like the feature exists. F14a taught the console
    // to draw and operate every remaining type, so the palette carries them
    // all -- plus the knob, which is a slider wearing WidgetStyle="Knob".
    expect(CREATABLE.map((c) => c.type)).toEqual([
      'button',
      'slider',
      'label',
      'cuelist',
      'clock',
      'frame',
      'soloframe',
      'speeddial',
      'xypad',
      'audiotriggers',
      'matrix',
      'knob',
    ])
  })
})

describe('CREATABLE', () => {
  it('gives every palette entry a label an operator can tell apart', () => {
    // The palette is a menu. Two entries sharing a name -- or an entry with
    // none -- are indistinguishable in the dark at the back of a venue.
    const labels = CREATABLE.map((c) => c.label)

    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) {
      expect(label.trim()).not.toBe('')
    }
  })

  it('shapes a knob like a knob, not like the fader it secretly is', () => {
    // In the file a knob IS a slider (WidgetStyle="Knob"), but on screen it
    // must arrive compact, not as a second 220 px fader.
    const knob = placeBelow([], 'knob')
    const fader = placeBelow([], 'slider')

    expect(knob.height).toBeLessThan(fader.height)
  })
})
