/**
 * The video surface: a page that owns nothing and obeys the feed.
 *
 * `./live` is mocked down to its constructor so the tests can play daemon:
 * each dispatched VideoEvent must turn into (or take down) a <video> aimed at
 * the function's media route, stacked and framed by the event's own numbers.
 *
 * Honesty about jsdom: there is no layout, no decoding and no real playback
 * here. What CAN be asserted is the element the page builds -- src, inline
 * style, the play()/pause()/currentTime calls -- which is exactly the part
 * this module owns; whether a browser then paints pixels is the browser's
 * side of the contract. jsdom's HTMLMediaElement stubs nothing of playback,
 * so play/pause/currentTime are stubbed by hand below.
 */
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveHandlers, VideoEvent } from './live'
import { Surface } from './surface'

const seam = vi.hoisted(() => ({
  handlers: null as import('./live').LiveHandlers | null,
  connects: 0,
  closes: 0,
}))

vi.mock('./live', () => ({
  Live: class {
    constructor(handlers: LiveHandlers) {
      seam.handlers = handlers
    }
    connect(): void {
      seam.connects += 1
    }
    close(): void {
      seam.closes += 1
    }
  },
}))

/* jsdom's media element implements none of playback: play() rejects with
   "not implemented" and currentTime has no backing store. Stub the three
   things the surface touches, per element where it matters. */
const played = vi.fn(async () => {})
const paused = vi.fn(() => {})
const times = new WeakMap<HTMLMediaElement, number>()

beforeEach(() => {
  seam.handlers = null
  seam.connects = 0
  seam.closes = 0
  played.mockClear()
  paused.mockClear()
  window.HTMLMediaElement.prototype.play = played
  window.HTMLMediaElement.prototype.pause = paused
  Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return times.get(this) ?? 0
    },
    set(this: HTMLMediaElement, value: number) {
      times.set(this, value)
    },
  })
  window.location.hash = ''
})

/** The daemon speaks: dispatch one feed event into the mounted surface. */
function arrives(event: VideoEvent): void {
  act(() => {
    seam.handlers?.onVideo?.(event)
  })
}

const started = (id: number, over: Partial<VideoEvent> = {}): VideoEvent => ({
  type: 'video',
  id,
  action: 'started',
  ...over,
})

const videos = (): HTMLVideoElement[] => [...document.querySelectorAll('video')]

describe('what the surface plays', () => {
  it('stays black until the daemon directs something', () => {
    render(<Surface />)

    expect(seam.connects).toBe(1)
    expect(videos()).toHaveLength(0)
  })

  it("plays a started event's film from the tokenless media route", () => {
    render(<Surface />)

    arrives(started(7))

    const [video] = videos()
    expect(video).toBeDefined()
    expect(video?.getAttribute('src')).toBe('/api/v1/functions/7/media')
    // A TV taped behind the stage has no operator: it must start by itself.
    expect(video?.hasAttribute('autoplay')).toBe(true)
  })

  it('fills the whole screen when the event carries no geometry', () => {
    render(<Surface />)

    arrives(started(7))

    const [video] = videos()
    expect(video?.style.width).toBe('100%')
    expect(video?.style.height).toBe('100%')
    expect(video?.style.inset).toBe('0px')
  })

  it('frames the film by the geometry and stacks it on its layer', () => {
    render(<Surface />)

    arrives(started(7, { layer: 3, geometry: { x: 10, y: 20, width: 640, height: 360 } }))

    const [video] = videos()
    expect(video?.style.zIndex).toBe('3')
    expect(video?.style.left).toBe('10px')
    expect(video?.style.top).toBe('20px')
    expect(video?.style.width).toBe('640px')
    expect(video?.style.height).toBe('360px')
  })

  it('applies the declared rotation', () => {
    render(<Surface />)

    arrives(started(7, { rotation: { x: 0, y: 0, z: 90 } }))

    expect(videos()[0]?.style.transform).toBe('rotateX(0deg) rotateY(0deg) rotateZ(90deg)')
  })

  it('stacks several films at once, each on its own layer', () => {
    render(<Surface />)

    arrives(started(1, { layer: 1 }))
    arrives(started(2, { layer: 5 }))

    const layers = videos().map((v) => v.style.zIndex)
    expect(layers).toHaveLength(2)
    expect(layers).toContain('1')
    expect(layers).toContain('5')
  })

  it('takes down exactly the film a stopped event names', () => {
    render(<Surface />)
    arrives(started(1))
    arrives(started(2))

    arrives({ type: 'video', id: 1, action: 'stopped' })

    const remaining = videos()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.getAttribute('src')).toBe('/api/v1/functions/2/media')
  })

  it('closes the feed when the surface unmounts', () => {
    const { unmount } = render(<Surface />)

    unmount()

    expect(seam.closes).toBe(1)
  })
})

describe('the ?screen filter', () => {
  it('a surface declared screen 2 ignores films aimed elsewhere', () => {
    window.location.hash = '#/surface?screen=2'
    render(<Surface />)

    arrives(started(1, { screen: 0 }))
    expect(videos()).toHaveLength(0)

    arrives(started(2, { screen: 2 }))
    expect(videos()).toHaveLength(1)
  })

  it('without the parameter it plays everything, whatever the screen', () => {
    render(<Surface />)

    arrives(started(1, { screen: 0 }))
    arrives(started(2, { screen: 3 }))

    expect(videos()).toHaveLength(2)
  })

  it('stop still lands on a filtered surface', () => {
    // The stop must not care which screen it was aimed at: a surface that
    // keeps playing a stopped film because the stop lacked a screen field
    // is a projector nobody can turn off.
    window.location.hash = '#/surface?screen=2'
    render(<Surface />)
    arrives(started(1, { screen: 2 }))

    arrives({ type: 'video', id: 1, action: 'stopped' })

    expect(videos()).toHaveLength(0)
  })

  // Regression: the filter once compared the raw field (undefined !== 0)
  // while the store defaulted it, so ?screen=0 dropped screenless films the
  // same client stored as screen 0.
  it('treats a film without a screen field as aimed at screen 0', () => {
    window.location.hash = '#/surface?screen=0'
    render(<Surface />)

    arrives(started(1))

    expect(videos()).toHaveLength(1)
  })
})

describe("the engine's clock", () => {
  it('snaps to the engine clock when it has drifted past the window', () => {
    render(<Surface />)
    arrives(started(7))
    const [video] = videos()
    expect(video).toBeDefined()
    if (video === undefined) throw new Error('unreachable')

    // The film sits at 0; the engine says 10 s. That is drift, not jitter.
    arrives({ type: 'video', id: 7, action: 'sync', elapsed: 10_000, serverTime: Date.now() })

    expect(video.currentTime).toBeGreaterThan(9.9)
    expect(video.currentTime).toBeLessThan(10.5)
    expect(played).toHaveBeenCalled()
  })

  it('leaves the clock alone inside the drift window', () => {
    // Nudging currentTime on every sync would stutter the film; small
    // disagreement is the network's noise, not drift.
    render(<Surface />)
    arrives(started(7))
    const [video] = videos()
    if (video === undefined) throw new Error('unreachable')
    video.currentTime = 10

    arrives({ type: 'video', id: 7, action: 'sync', elapsed: 10_100, serverTime: Date.now() })

    expect(video.currentTime).toBe(10)
  })

  it('pauses and resumes with the engine', () => {
    render(<Surface />)
    arrives(started(7))
    const [video] = videos()
    if (video === undefined) throw new Error('unreachable')

    arrives({
      type: 'video',
      id: 7,
      action: 'paused',
      paused: true,
      elapsed: 5_000,
      serverTime: Date.now(),
    })
    expect(paused).toHaveBeenCalled()

    played.mockClear()
    arrives({
      type: 'video',
      id: 7,
      action: 'resumed',
      paused: false,
      elapsed: 5_000,
      serverTime: Date.now(),
    })
    expect(played).toHaveBeenCalled()
  })
})
