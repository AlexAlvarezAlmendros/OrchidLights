/**
 * Dragging: where a thing would land, worked out before it lands there.
 *
 * The interactions in this interface are dragged far more often than clicked,
 * and on a phone at that. What separates one that feels solid from one that
 * feels approximate is not the drag itself -- it is whether the answer to
 * "where will this go if I let go now?" is on screen while the finger is still
 * down.
 *
 * The arithmetic for that answer lives here, apart from the components, because
 * it is the part that can be wrong in ways nobody notices: an insertion point
 * off by one puts a cue in the wrong place, and it looks like the operator's
 * mistake.
 */

/** A widget on screen, as measured. Rows are indexed top to bottom. */
export interface DropTarget {
  id: number | null
  rowIndex: number
  left: number
  right: number
}

/** Where a drop would go: before `beforeId` in `rowIndex`, or at its end. */
export interface Insertion {
  rowIndex: number
  beforeId: number | null
}

/**
 * The insertion point for a pointer sitting over `target`.
 *
 * The midpoint decides: past the middle of a widget means after it, which is
 * how every list that has ever been dragged behaves and what a hand expects
 * without being told.
 *
 * `next` is the widget after the one under the pointer, in the same row, so
 * "after this one" can be expressed as "before that one" -- the only form the
 * layout understands.
 */
export function insertionAt(target: DropTarget, x: number, next: DropTarget | null): Insertion {
  const past = x > (target.left + target.right) / 2

  if (!past) return { rowIndex: target.rowIndex, beforeId: target.id }

  return {
    rowIndex: target.rowIndex,
    beforeId: next && next.rowIndex === target.rowIndex ? next.id : null,
  }
}

/** Two insertion points that mean the same thing, so a drag can avoid
 *  re-rendering the console on every pointer event that changes nothing. */
export function sameInsertion(a: Insertion | null, b: Insertion | null): boolean {
  if (a === null || b === null) return a === b
  return a.rowIndex === b.rowIndex && a.beforeId === b.beforeId
}

/**
 * Whether a move is a move at all.
 *
 * Dropping a widget back where it already was is not an edit, and treating it
 * as one marks the show modified and asks to be saved for nothing.
 */
export function isNoop(rows: readonly (readonly number[])[], id: number, to: Insertion): boolean {
  const row = rows[to.rowIndex]
  if (row === undefined) return false

  const at = row.indexOf(id)
  if (at < 0) return false

  const target = to.beforeId === null ? row.length : row.indexOf(to.beforeId)
  if (target < 0) return false

  // Landing on itself, or immediately after itself, changes nothing.
  return target === at || target === at + 1
}

/** One thing placed on a timeline. */
export interface Span {
  id: number
  start: number
  duration: number
}

/**
 * The span a move would land on top of, or null.
 *
 * The daemon refuses overlaps and is the authority; this exists so the refusal
 * is visible while the finger is still down. Being told "that would land on
 * Verde" before letting go is a different experience from being told "that
 * overlapped Verde" after the bar has jumped back.
 */
export function collision(
  spans: readonly Span[],
  id: number,
  start: number,
  duration: number,
): Span | null {
  const end = start + duration

  for (const other of spans) {
    if (other.id === id) continue
    if (start < other.start + other.duration && other.start < end) return other
  }

  return null
}
