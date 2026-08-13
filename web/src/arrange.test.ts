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
})

describe('rowsToLayout', () => {
  it('round-trips through resolveRows', () => {
    const children = [widget(1, 0, 0), widget(2, 200, 0), widget(3, 0, 200)]
    const stored: LayoutRows = [[3], [2, 1]]
    expect(rowsToLayout(resolveRows(children, stored))).toEqual(stored)
  })
})
