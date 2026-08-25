import { describe, expect, it } from 'vitest'
import { formatTime } from './show'

/**
 * The clock the timeline speaks in. Everything on a show is millisecond
 * arithmetic underneath, but nobody places a cue at "4200": below the minute a
 * time reads as seconds with one decimal, above it as m:ss, and the switch has
 * to happen exactly at the minute or the ruler contradicts itself. These labels
 * are what the operator navigates by -- on the ruler, on every bar, on the
 * play button -- so a wrong one here is a cue fired at the wrong moment.
 */
describe('formatTime', () => {
  it('reads sub-minute times as seconds with one decimal', () => {
    expect(formatTime(4200)).toBe('4.2 s')
    expect(formatTime(500)).toBe('0.5 s')
  })

  it('shows zero as a time, not as nothing', () => {
    // The first tick of the ruler is a place too.
    expect(formatTime(0)).toBe('0.0 s')
  })

  it('switches to m:ss exactly at the minute', () => {
    expect(formatTime(59_900)).toBe('59.9 s')
    expect(formatTime(60_000)).toBe('1:00')
  })

  it('pads the seconds so 2:05 cannot be misread as 2:50', () => {
    expect(formatTime(125_000)).toBe('2:05')
  })

  it('floors the seconds rather than rounding a label into the future', () => {
    // 1:29.9 is still during second 29; showing 1:30 would name a moment that
    // has not happened yet.
    expect(formatTime(89_900)).toBe('1:29')
  })

  it('keeps counting minutes past the hour rather than changing unit', () => {
    // A ruler that flipped to h:mm:ss at sixty minutes would change what every
    // tick means partway along; a long show is long, not a different thing.
    expect(formatTime(3_600_000)).toBe('60:00')
  })
})
