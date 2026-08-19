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
})
