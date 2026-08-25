import { describe, expect, it } from 'vitest'
import { type Span, collision, insertionAt, isNoop, sameInsertion } from './drag'

const target = (id: number | null, left: number, right: number, rowIndex = 0) => ({
  id,
  rowIndex,
  left,
  right,
})

describe('insertionAt', () => {
  it('puts a drop before the widget when the pointer is on its left half', () => {
    expect(insertionAt(target(7, 100, 200), 120, null)).toEqual({ rowIndex: 0, beforeId: 7 })
  })

  it('and after it when the pointer is past the middle', () => {
    expect(insertionAt(target(7, 100, 200), 180, target(9, 200, 300))).toEqual({
      rowIndex: 0,
      beforeId: 9,
    })
  })

  it('appends when there is nothing after it', () => {
    expect(insertionAt(target(7, 100, 200), 180, null)).toEqual({ rowIndex: 0, beforeId: null })
  })

  it('appends when the next widget is on another row', () => {
    // "after the last widget of row 0" is not "before the first of row 1":
    // the layout addresses rows separately, and the wrong one moves the widget
    // to a row the operator never pointed at.
    expect(insertionAt(target(7, 100, 200), 180, target(9, 0, 100, 1))).toEqual({
      rowIndex: 0,
      beforeId: null,
    })
  })

  it('is exactly at the midpoint on the "after" side', () => {
    expect(insertionAt(target(7, 100, 200), 150, null).beforeId).toBe(7)
    expect(insertionAt(target(7, 100, 200), 151, null).beforeId).toBe(null)
  })

  it('reads a pointer short of the widget as before it, and one past it as after', () => {
    // Hit-testing can hand over a target the pointer has already left by a few
    // pixels; the midpoint rule must still give a sane answer outside the box.
    expect(insertionAt(target(7, 100, 200), 40, null)).toEqual({ rowIndex: 0, beforeId: 7 })
    expect(insertionAt(target(7, 100, 200), 260, target(9, 200, 300))).toEqual({
      rowIndex: 0,
      beforeId: 9,
    })
  })

  it('appends to the row over a placeholder with no widget, whichever half', () => {
    // An empty row is dropped onto through a target with no id. There is no
    // before or after where there is nothing: both halves mean "into this row".
    expect(insertionAt(target(null, 100, 200), 120, null)).toEqual({ rowIndex: 0, beforeId: null })
    expect(insertionAt(target(null, 100, 200), 180, null)).toEqual({ rowIndex: 0, beforeId: null })
  })

  it('keeps the row of the target, not of the widget that comes next', () => {
    expect(insertionAt(target(7, 100, 200, 2), 120, target(9, 0, 100, 3)).rowIndex).toBe(2)
  })
})

describe('sameInsertion', () => {
  it('tells identical insertion points apart from different ones', () => {
    expect(sameInsertion({ rowIndex: 1, beforeId: 3 }, { rowIndex: 1, beforeId: 3 })).toBe(true)
    expect(sameInsertion({ rowIndex: 1, beforeId: 3 }, { rowIndex: 1, beforeId: 4 })).toBe(false)
    expect(sameInsertion({ rowIndex: 1, beforeId: null }, { rowIndex: 2, beforeId: null })).toBe(
      false,
    )
  })

  it('handles nothing on either side', () => {
    expect(sameInsertion(null, null)).toBe(true)
    expect(sameInsertion(null, { rowIndex: 0, beforeId: null })).toBe(false)
  })
})

describe('isNoop', () => {
  const rows = [
    [1, 2, 3],
    [4, 5],
  ]

  it('knows a drop onto itself changes nothing', () => {
    expect(isNoop(rows, 2, { rowIndex: 0, beforeId: 2 })).toBe(true)
  })

  it('and a drop just after itself, which is the same gap', () => {
    // Widget 2 sits between 1 and 3, so "before 3" is where it already is.
    expect(isNoop(rows, 2, { rowIndex: 0, beforeId: 3 })).toBe(true)
  })

  it('but not a real move', () => {
    expect(isNoop(rows, 2, { rowIndex: 0, beforeId: 1 })).toBe(false)
    expect(isNoop(rows, 2, { rowIndex: 1, beforeId: 5 })).toBe(false)
  })

  it('treats appending an already-last widget as no move', () => {
    expect(isNoop(rows, 3, { rowIndex: 0, beforeId: null })).toBe(true)
  })

  it('says nothing about a widget that is not in that row', () => {
    expect(isNoop(rows, 9, { rowIndex: 0, beforeId: null })).toBe(false)
    expect(isNoop(rows, 1, { rowIndex: 5, beforeId: null })).toBe(false)
  })

  it('knows the first widget dropped before its own successor has not moved', () => {
    // The same-gap rule at the start of the row: 1 already sits before 2.
    expect(isNoop(rows, 1, { rowIndex: 0, beforeId: 2 })).toBe(true)
  })

  it('treats a beforeId the row does not hold as a real move', () => {
    // Better to apply a move that turns out to change nothing than to swallow
    // one that would have: the daemon settles what an unknown anchor means.
    expect(isNoop(rows, 2, { rowIndex: 0, beforeId: 99 })).toBe(false)
  })

  it('appending a widget that is not already last is a real move', () => {
    expect(isNoop(rows, 1, { rowIndex: 0, beforeId: null })).toBe(false)
    expect(isNoop(rows, 4, { rowIndex: 1, beforeId: null })).toBe(false)
  })
})

describe('collision', () => {
  const spans: Span[] = [
    { id: 1, start: 0, duration: 800 },
    { id: 2, start: 800, duration: 800 },
  ]

  it('finds what a move would land on', () => {
    expect(collision(spans, 3, 400, 200)?.id).toBe(1)
  })

  it('ignores the span being moved', () => {
    expect(collision(spans, 1, 0, 800)).toBeNull()
  })

  it('lets things touch end to start', () => {
    // 1 ends at 800 and 2 begins at 800: back to back is the normal way to
    // build a show, and refusing it would make the timeline unusable.
    expect(collision(spans, 3, 1600, 400)).toBeNull()
    expect(collision([spans[0] as Span], 3, 800, 400)).toBeNull()
  })

  it('catches a span that swallows another whole', () => {
    expect(collision(spans, 3, 0, 5000)?.id).toBe(1)
  })

  it('catches one that starts inside another', () => {
    expect(collision(spans, 3, 700, 50)?.id).toBe(1)
  })

  it('catches one that ends inside another', () => {
    // Starts on free ground, reaches into occupied: still a collision. The
    // overlap test must hold from both directions, not just "starts inside".
    expect(collision([spans[1] as Span], 3, 600, 400)?.id).toBe(2)
  })

  it('still warns when a span dragged before zero reaches back into the show', () => {
    expect(collision(spans, 3, -100, 200)?.id).toBe(1)
  })

  it('lets a zero-length item sit at the seam between two spans', () => {
    // 800 is where 1 ends and 2 begins. A marker there is on neither; the
    // touch rule holds from both sides at once.
    expect(collision(spans, 3, 800, 0)).toBeNull()
  })

  it('finds nothing on an empty timeline', () => {
    expect(collision([], 1, 0, 1000)).toBeNull()
  })
})
