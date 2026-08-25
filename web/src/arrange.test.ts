import { describe, expect, it } from 'vitest'
import { type LayoutRows, moveWidget, resolveRows, rowsToLayout } from './arrange'
import type { VcWidget } from './layout'

function widget(id: number, x: number, y: number): VcWidget {
  return { type: 'button', id, geometry: { x, y, width: 100, height: 50 } }
}

describe('resolveRows', () => {
  const children = [widget(1, 0, 0), widget(2, 200, 0), widget(3, 0, 200)]

  it('falls back to the geometry when nothing has been arranged', () => {
    const rows = resolveRows(children, null)
    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2], [3]])
  })

  it('honours a saved arrangement', () => {
    const rows = resolveRows(children, [[3], [2, 1]])
    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[3], [2, 1]])
  })

  it('still shows a widget the saved layout never heard of', () => {
    // Added in QLC+ after the layout was saved. Hiding it forever would be the
    // worst possible failure: the operator cannot even find what is missing.
    const rows = resolveRows(children, [[1, 2]])
    const shown = rows.flatMap((r) => r.widgets.map((w) => w.id))
    expect(shown).toContain(3)
  })

  it('ignores ids for widgets that no longer exist', () => {
    const rows = resolveRows(children, [
      [1, 999],
      [2, 3],
    ])
    const shown = rows.flatMap((r) => r.widgets.map((w) => w.id))
    expect(shown.sort()).toEqual([1, 2, 3])
  })

  it('never drops a widget, whatever the layout says', () => {
    for (const stored of [[], [[2]], [[3], []], [[9, 9, 9]]] as LayoutRows[]) {
      const shown = resolveRows(children, stored).flatMap((r) => r.widgets.map((w) => w.id))
      expect(shown.slice().sort()).toEqual([1, 2, 3])
    }
  })

  it('collapses a stored row whose widgets all vanished instead of leaving a gap', () => {
    // Every widget of a saved row was since deleted in QLC+. An empty row
    // drawn for it would be a permanent blank stripe nobody can remove.
    const rows = resolveRows(children, [
      [998, 999],
      [1, 2, 3],
    ])

    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[1, 2, 3]])
  })

  it('still shows a widget that has no id, though no layout can name it', () => {
    // QLC+ 4 wrote no ID attributes. Such a widget can never be arranged, but
    // it must never be invisible either -- it falls through to geometry.
    const anonymous: VcWidget = {
      type: 'button',
      geometry: { x: 0, y: 200, width: 100, height: 50 },
    }
    const rows = resolveRows([widget(1, 0, 0), anonymous], [[1]])
    const shown = rows.flatMap((r) => r.widgets)

    expect(shown).toContain(anonymous)
  })

  it('resolves an empty page to no rows, whatever the layout remembers', () => {
    expect(resolveRows([], null)).toEqual([])
    expect(resolveRows([], [[1, 2], [3]])).toEqual([])
  })

  it('appends unmentioned widgets in their geometric rows, after the arranged ones', () => {
    // The saved half keeps its saved order; the unsaved half keeps the
    // designer's: side-by-side widgets stay one row, a lower band stays below.
    const late = [widget(4, 0, 400), widget(5, 200, 400), widget(6, 0, 600)]
    const rows = resolveRows([...children, ...late], [[3, 1, 2]])

    expect(rows.map((r) => r.widgets.map((w) => w.id))).toEqual([[3, 1, 2], [4, 5], [6]])
  })
})

describe('moveWidget', () => {
  it('moves a widget in front of another', () => {
    expect(moveWidget([[1, 2, 3]], 3, 0, 1)).toEqual([[3, 1, 2]])
  })

  it('appends when there is nothing to go before', () => {
    expect(moveWidget([[1, 2], [3]], 1, 1, null)).toEqual([[2], [3, 1]])
  })

  it('starts a new row past the end', () => {
    expect(moveWidget([[1, 2]], 2, 1, null)).toEqual([[1], [2]])
  })

  it('drops a row the move emptied', () => {
    expect(moveWidget([[1], [2]], 1, 1, 2)).toEqual([[1, 2]])
  })

  it('keeps every widget through any single move', () => {
    const before: LayoutRows = [
      [1, 2],
      [3, 4],
    ]
    for (const id of [1, 2, 3, 4]) {
      for (const row of [0, 1, 2]) {
        const after = moveWidget(before, id, row, null).flat().sort()
        expect(after).toEqual([1, 2, 3, 4])
      }
    }
  })

  it('creates a single new row when dropped far past the end', () => {
    // A drop zone below the console means "last row plus one" however the
    // index arrives; five phantom empty rows in between would reload as gaps.
    expect(moveWidget([[1, 2]], 2, 5, null)).toEqual([[1], [2]])
  })

  it('appends when asked to land before a widget the row does not hold', () => {
    // The widget under the pointer can vanish mid-drag (another operator, a
    // reload). Losing the dragged widget over it is not an option; the end of
    // the row is the least surprising place left.
    expect(moveWidget([[1, 2], [3]], 1, 1, 99)).toEqual([[2], [3, 1]])
  })

  it('collapses an emptied middle row so the rows below move up', () => {
    expect(moveWidget([[1], [2], [3]], 2, 0, 1)).toEqual([[2, 1], [3]])
  })

  it('hands back the same arrangement when a widget lands on its own position', () => {
    expect(moveWidget([[1, 2, 3]], 2, 0, 3)).toEqual([[1, 2, 3]])
    expect(moveWidget([[1, 2, 3]], 3, 0, null)).toEqual([[1, 2, 3]])
  })

  // Regression: "before itself" once fired the vanished-anchor fallback (the
  // anchor was stripped with the dragged id before indexOf looked for it) and
  // sent the widget to the end of the row.
  it('treats "before itself" as staying exactly where it is', () => {
    expect(moveWidget([[1, 2, 3]], 2, 0, 2)).toEqual([[1, 2, 3]])
  })

  it('leaves the rows it was given untouched', () => {
    // The caller keeps these in React state; mutating them in place makes the
    // console skip the re-render that would show the move.
    const before: LayoutRows = [
      [1, 2],
      [3, 4],
    ]
    moveWidget(before, 1, 1, 4)

    expect(before).toEqual([
      [1, 2],
      [3, 4],
    ])
  })
})

describe('rowsToLayout', () => {
  it('round-trips through resolveRows', () => {
    const children = [widget(1, 0, 0), widget(2, 200, 0), widget(3, 0, 200)]
    const stored: LayoutRows = [[3], [2, 1]]
    expect(rowsToLayout(resolveRows(children, stored))).toEqual(stored)
  })

  it('omits widgets that have no id while keeping their row-mates', () => {
    // An id-less widget cannot be named by a layout, so saving one would write
    // garbage; its neighbours must still come out in order.
    const anonymous: VcWidget = { type: 'button', geometry: { x: 0, y: 0, width: 100, height: 50 } }
    const layout = rowsToLayout([
      { top: 0, widgets: [widget(5, 0, 0), anonymous, widget(6, 200, 0)] },
    ])

    expect(layout).toEqual([[5, 6]])
  })

  it('names nothing for a row made only of id-less widgets', () => {
    // Nothing to store is fine: on the next load the widget falls through to
    // geometry, exactly as it displays today. Nothing is lost either way.
    const anonymous: VcWidget = { type: 'button', geometry: { x: 0, y: 0, width: 100, height: 50 } }
    const layout = rowsToLayout([{ top: 0, widgets: [anonymous] }])

    expect(layout.flat()).toEqual([])
  })
})
