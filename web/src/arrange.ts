/**
 * Rearranging the console.
 *
 * The stored layout is a list of rows of widget ids. Two things have to be true
 * of every operation here, and both are easy to get wrong:
 *
 *  - No widget may be lost. A rearrangement that silently drops a button is a
 *    console missing a cue on the night someone needs it.
 *  - Widgets the layout has never heard of must still appear. A layout saved
 *    before a button was added in QLC+ would otherwise hide it forever.
 */

import { type Row, type VcWidget, groupIntoRows } from './layout'

export type LayoutRows = number[][]

/**
 * Resolve the rows to display: the saved arrangement where there is one, with
 * anything it does not mention appended in its geometric place.
 */
export function resolveRows(children: readonly VcWidget[], stored: LayoutRows | null): Row[] {
  // A widget with no id cannot be named by a layout at all -- QLC+ 4 wrote none
  // -- so it is never "placed" and always falls through to the geometry below.
  const byId = new Map(children.filter((w) => w.id !== undefined).map((w) => [w.id as number, w]))

  if (!stored || stored.length === 0) {
    return groupIntoRows(children)
  }

  const placed = new Set<number>()
  const rows: Row[] = []

  for (const storedRow of stored) {
    const widgets = storedRow
      .map((id) => byId.get(id))
      .filter((w): w is VcWidget => w !== undefined)

    for (const widget of widgets) placed.add(widget.id as number)
    if (widgets.length > 0) rows.push({ top: rows.length, widgets })
  }

  // Whatever the layout never mentioned, in the order the designer left it.
  const missing = children.filter((w) => w.id === undefined || !placed.has(w.id))
  if (missing.length > 0) {
    for (const row of groupIntoRows(missing)) {
      rows.push({ top: rows.length, widgets: row.widgets })
    }
  }

  return rows
}

export function rowsToLayout(rows: readonly Row[]): LayoutRows {
  return rows.map((row) =>
    row.widgets.map((w) => w.id).filter((id): id is number => id !== undefined),
  )
}

/**
 * Move a widget in front of another, or to the end of a row.
 *
 * `beforeId` of null means "append to that row"; a `rowIndex` past the end
 * means "start a new row".
 */
export function moveWidget(
  rows: LayoutRows,
  widgetId: number,
  rowIndex: number,
  beforeId: number | null,
): LayoutRows {
  const next = rows.map((row) => row.filter((id) => id !== widgetId))

  while (next.length <= rowIndex) next.push([])

  const target = next[rowIndex]
  if (!target) return rows

  const at = beforeId === null ? target.length : target.indexOf(beforeId)
  target.splice(at < 0 ? target.length : at, 0, widgetId)

  // A row emptied by the move carries no information and would reopen as a gap
  // on every load.
  return next.filter((row) => row.length > 0)
}
