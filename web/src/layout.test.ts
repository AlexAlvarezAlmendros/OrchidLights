import { describe, expect, it } from 'vitest'
import { type VcWidget, childrenOnPage, groupIntoRows, growFactor, pagesOf } from './layout'

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

  it('does not chain a lower band in through a very tall neighbour', () => {
    // The real console this broke on: buttons at y=30 beside 560 px master
    // faders at y=40, with a frame of looks starting at y=96. Half the fader's
    // height "tolerates" the frame, and the whole console collapsed into one
    // row. 56 px is a band boundary, not hand-drift.
    const rows = groupIntoRows([
      widget(1, 32, 30, 200, 56),
      widget(2, 980, 40, 60, 560),
      widget(3, 32, 96, 940, 268),
    ])

    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2], [3]])
  })

  it('handles an empty console without inventing rows', () => {
    expect(groupIntoRows([])).toEqual([])
  })

  it('caps the tolerance at exactly 24 px: that far is drift, one more is a band', () => {
    // Two 100 px widgets would tolerate 50 px of drift by the fraction alone.
    // Hand alignment is off by single-digit pixels; past 24 the designer meant
    // two rows, so 24 joins and 25 splits, and nothing in between wobbles.
    const joined = groupIntoRows([widget(1, 0, 0, 100, 100), widget(2, 200, 24, 100, 100)])
    expect(joined).toHaveLength(1)

    const split = groupIntoRows([widget(1, 0, 0, 100, 100), widget(2, 200, 25, 100, 100)])
    expect(split.map((r) => r.widgets.map((w) => w.id))).toEqual([[1], [2]])
  })

  it('orders a y-tie strictly left to right, however the widgets arrived', () => {
    const rows = groupIntoRows([widget(2, 300, 50), widget(3, 600, 50), widget(1, 0, 50)])
    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2, 3]])
  })

  it('keeps the arrival order of widgets stacked at the exact same spot', () => {
    // Two widgets at identical x and y give the sort nothing to decide with;
    // the answer must at least be deterministic, and input order is the only
    // order the project file offers.
    const rows = groupIntoRows([widget(1, 100, 50), widget(2, 100, 50)])
    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2]])
  })

  it('requires exact alignment from a zero-height widget', () => {
    // Half of nothing is nothing: a degenerate widget offers no height to
    // measure drift against, so it only joins a row it starts on precisely.
    const together = groupIntoRows([widget(1, 0, 100, 100, 0), widget(2, 200, 100, 100, 50)])
    expect(together).toHaveLength(1)

    const apart = groupIntoRows([widget(1, 0, 100, 100, 0), widget(2, 200, 101, 100, 50)])
    expect(apart).toHaveLength(2)
  })

  it('groups two zero-height widgets on the same line into one row', () => {
    const rows = groupIntoRows([widget(2, 300, 80, 100, 0), widget(1, 0, 80, 100, 0)])
    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2]])
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

  it('gives a widget alone in its row a neutral factor, whatever its width', () => {
    // Alone there are no proportions to keep: the row is simply full.
    for (const width of [1, 100, 5000]) {
      const only = widget(1, 0, 0, width)
      expect(growFactor(only, { top: 0, widgets: [only] })).toBe(1)
    }
  })

  it('treats zero-width widgets as equals instead of dividing by nothing', () => {
    // QLC+ will happily save a widget somebody collapsed to nothing. It still
    // has to be reachable on screen, so it takes an equal share, not NaN.
    const a = widget(1, 0, 0, 0)
    const b = widget(2, 0, 0, 0)
    const row = { top: 0, widgets: [a, b] }

    expect(growFactor(a, row)).toBe(1)
    expect(growFactor(b, row)).toBe(1)
  })

  it('shows a zero-width widget as a sliver beside a real one, not as nothing', () => {
    const sliver = widget(1, 0, 0, 0)
    const wide = widget(2, 0, 0, 300)
    const row = { top: 0, widgets: [sliver, wide] }

    expect(growFactor(sliver, row)).toBe(0.5)
    expect(growFactor(wide, row)).toBeGreaterThan(1)
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

  it('offers the console itself when it has no children at all', () => {
    // A brand-new project has an empty virtual console. It must still open as
    // one (empty) page, not as no pages, or there is nothing to draw at all.
    const root: VcWidget = {
      type: 'virtualconsole',
      id: 0,
      geometry: { x: 0, y: 0, width: 0, height: 0 },
    }

    expect(pagesOf(root)).toEqual([root])
  })

  it('does not count a nested frame among the pages', () => {
    // Only top-level frames are pages; a frame inside a frame is content.
    const inner: VcWidget = {
      type: 'frame',
      id: 2,
      geometry: { x: 0, y: 0, width: 50, height: 50 },
    }
    const root: VcWidget = {
      type: 'virtualconsole',
      id: 0,
      geometry: { x: 0, y: 0, width: 0, height: 0 },
      children: [
        {
          type: 'soloframe',
          id: 1,
          geometry: { x: 0, y: 0, width: 100, height: 100 },
          children: [inner],
        },
      ],
    }

    expect(pagesOf(root).map((p) => p.id)).toEqual([1])
  })
})

describe('childrenOnPage', () => {
  const frame = (over: Partial<VcWidget>): VcWidget => ({
    type: 'frame',
    id: 10,
    geometry: { x: 0, y: 0, width: 500, height: 500 },
    ...over,
  })

  it('filters a multipage frame down to the page it is showing', () => {
    const children = [
      widget(1, 0, 0),
      { ...widget(2, 0, 100), page: 1 },
      { ...widget(3, 0, 200), page: 2 },
    ]
    const multi = frame({ pages: 3, children })

    expect(childrenOnPage(multi, 2).map((w) => w.id)).toEqual([3])
  })

  it('puts a child with no @Page tag on the first page', () => {
    // QLC+ omits the attribute for page zero, so an untagged child is not
    // "pageless": it lives on page 0 and must vanish when you page away.
    const multi = frame({
      pages: 2,
      children: [widget(1, 0, 0), { ...widget(2, 0, 100), page: 1 }],
    })

    expect(childrenOnPage(multi, 0).map((w) => w.id)).toEqual([1])
    expect(childrenOnPage(multi, 1).map((w) => w.id)).toEqual([2])
  })

  it('shows everything in a frame that is not multipage, inherited @Page tags included', () => {
    // A design that once had pages may leave @Page on children of a frame that
    // no longer pages. Hiding them would make widgets vanish for a reason
    // nobody can see on screen.
    const children = [widget(1, 0, 0), { ...widget(2, 0, 100), page: 3 }]

    expect(childrenOnPage(frame({ children }), 0).map((w) => w.id)).toEqual([1, 2])
    expect(childrenOnPage(frame({ pages: 1, children }), 0).map((w) => w.id)).toEqual([1, 2])
  })

  it('yields an empty page rather than failing on a frame with no children', () => {
    expect(childrenOnPage(frame({}), 0)).toEqual([])
    expect(childrenOnPage(frame({ pages: 4 }), 2)).toEqual([])
  })

  it('yields an empty page for a page number nothing lives on', () => {
    const multi = frame({ pages: 5, children: [{ ...widget(1, 0, 0), page: 0 }] })

    expect(childrenOnPage(multi, 4)).toEqual([])
  })
})
