import { describe, expect, it } from 'vitest'
import { type VcWidget, groupIntoRows, growFactor, pagesOf } from './layout'

function widget(id: number, x: number, y: number, width = 100, height = 50): VcWidget {
  return { type: 'button', id, geometry: { x, y, width, height } }
}

describe('groupIntoRows', () => {
  it('puts widgets that sit side by side in one row, left to right', () => {
    const rows = groupIntoRows([widget(3, 400, 10), widget(1, 0, 10), widget(2, 200, 10)])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.widgets.map((w) => w.id)).toEqual([1, 2, 3])
  })

  it('keeps separate bands apart, ordered top to bottom', () => {
    const rows = groupIntoRows([widget(2, 0, 200), widget(1, 0, 10)])

    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1], [2]])
  })

  it('tolerates a label that sits slightly proud of the buttons it titles', () => {
    // Hand-placed layouts are never pixel aligned; 6 px of drift is not a row.
    const rows = groupIntoRows([widget(1, 0, 100, 100, 50), widget(2, 120, 106, 100, 50)])

    expect(rows).toHaveLength(1)
  })

  it('does not let a tall widget swallow the rows beside it', () => {
    // A 400 px fader spans several bands of buttons. It belongs to the first
    // one it overlaps, and the rest must stay their own rows.
    const rows = groupIntoRows([
      widget(1, 900, 40, 55, 400),
      widget(2, 0, 40, 100, 50),
      widget(3, 0, 300, 100, 50),
    ])

    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]?.widgets.map((w) => w.id)).toContain(2)
    expect(rows.at(-1)?.widgets.map((w) => w.id)).toContain(3)
  })

  it('handles an empty console without inventing rows', () => {
    expect(groupIntoRows([])).toEqual([])
  })
})

describe('growFactor', () => {
  it('keeps the designer’s proportions between neighbours', () => {
    const wide = widget(1, 0, 0, 300)
    const narrow = widget(2, 300, 0, 100)
    const row = { top: 0, widgets: [wide, narrow] }

    expect(growFactor(wide, row)).toBeGreaterThan(growFactor(narrow, row))
  })

  it('never lets one widget squeeze the others out', () => {
    const huge = widget(1, 0, 0, 100000)
    const tiny = widget(2, 0, 0, 1)
    const row = { top: 0, widgets: [huge, tiny] }

    expect(growFactor(huge, row)).toBeLessThanOrEqual(4)
    expect(growFactor(tiny, row)).toBeGreaterThanOrEqual(0.5)
  })
})

describe('pagesOf', () => {
  it('treats top-level frames as pages', () => {
    const root: VcWidget = {
      type: 'virtualconsole',
      id: 0,
      geometry: { x: 0, y: 0, width: 0, height: 0 },
      children: [
        { type: 'frame', id: 1, geometry: { x: 0, y: 0, width: 100, height: 100 } },
        { type: 'frame', id: 2, geometry: { x: 0, y: 0, width: 100, height: 100 } },
      ],
    }

    expect(pagesOf(root).map((p) => p.id)).toEqual([1, 2])
  })

  it('falls back to the console itself when it has no frames', () => {
    const root: VcWidget = {
      type: 'virtualconsole',
      id: 0,
      geometry: { x: 0, y: 0, width: 0, height: 0 },
      children: [widget(1, 0, 0)],
    }

    expect(pagesOf(root)).toEqual([root])
  })
})
