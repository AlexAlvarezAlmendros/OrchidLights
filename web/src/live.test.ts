import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FunctionState } from './api'
import { Live, type LiveHandlers } from './live'

/**
 * A WebSocket the tests control.
 *
 * Live touches the socket through exactly four surfaces: the constructor, the
 * two listeners it registers, send() and close(). Faking those lets a test
 * play daemon: push frames in, read commands out, cut the line.
 */
type FrameListener = (event: { data: unknown }) => void

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every socket opened since the last reset, oldest first. Reconnection
   *  tests watch this list to see Live dialling again. */
  static instances: FakeWebSocket[] = []

  readonly url: string
  binaryType = 'blob'
  readyState: number = FakeWebSocket.OPEN
  /** Raw strings Live sent towards the daemon. */
  readonly sent: string[] = []
  /** What a listener threw during dispatch. Browser event dispatch reports
   *  such exceptions to the console and carries on; the fake mirrors that,
   *  and a test that expects clean handling asserts this stayed empty. */
  readonly reported: unknown[] = []

  private readonly listeners = new Map<string, FrameListener[]>()

  constructor(url: unknown) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: FrameListener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    /* The real close() fires the close event later and asynchronously; tests
       call dropConnection() themselves so the ordering stays explicit. */
  }

  /** Deliver one frame the way event dispatch does: a listener that throws is
   *  reported, not propagated, and later frames are unaffected. */
  message(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      try {
        listener({ data })
      } catch (error) {
        this.reported.push(error)
      }
    }
  }

  /** The connection dies underneath us: network cut, daemon restarted. */
  dropConnection(): void {
    this.readyState = FakeWebSocket.CLOSED
    for (const listener of this.listeners.get('close') ?? []) {
      listener({ data: undefined })
    }
  }
}

/** Every handler mocked, so any dispatch whatsoever is observable. */
function allHandlers() {
  return {
    onFunctions: vi.fn(),
    onConnection: vi.fn(),
    onSlider: vi.fn(),
    onChannelGroup: vi.fn(),
    onPad: vi.fn(),
    onShow: vi.fn(),
    onInput: vi.fn(),
    onBeat: vi.fn(),
    onAccess: vi.fn(),
    onVideo: vi.fn(),
    onFramePage: vi.fn(),
    onChanged: vi.fn(),
    onSpectrum: vi.fn(),
    onAudioTriggers: vi.fn(),
    onUniverse: vi.fn(),
    onBlackout: vi.fn(),
    onDump: vi.fn(),
    onSimpleDesk: vi.fn(),
    onGrandMaster: vi.fn(),
    onProject: vi.fn(),
    onError: vi.fn(),
    onRemote: vi.fn(),
  } satisfies LiveHandlers
}

type Handlers = ReturnType<typeof allHandlers>

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no socket was opened')
  return socket
}

/** Deliver a JSON frame from the daemon. */
function json(socket: FakeWebSocket, message: Record<string, unknown>): void {
  socket.message(JSON.stringify(message))
}

function lastSent(socket: FakeWebSocket): unknown {
  const raw = socket.sent.at(-1)
  if (raw === undefined) throw new Error('nothing was sent')
  return JSON.parse(raw)
}

function connectionStates(handlers: Handlers): string[] {
  return handlers.onConnection.mock.calls.map((call) => call[0])
}

/** Connect and complete the no-auth handshake, the way most tests start. */
function openLive(token?: string): { live: Live; handlers: Handlers; socket: FakeWebSocket } {
  const handlers = allHandlers()
  const live = new Live(handlers)
  live.connect(token)
  const socket = lastSocket()
  json(socket, { type: 'hello', authRequired: false })
  return { live, handlers, socket }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('window', { location: { href: 'http://desk.local/' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('connection and auth', () => {
  it('announces connecting straight away, and open on a hello that needs no auth', () => {
    const handlers = allHandlers()
    const live = new Live(handlers)
    live.connect()

    expect(connectionStates(handlers)).toEqual(['connecting'])

    json(lastSocket(), { type: 'hello', authRequired: false })
    expect(connectionStates(handlers)).toEqual(['connecting', 'open'])
  })

  it('answers an auth-required hello with the token, and opens once accepted', () => {
    const handlers = allHandlers()
    const live = new Live(handlers)
    live.connect('secreto')
    const socket = lastSocket()

    json(socket, { type: 'hello', authRequired: true })
    expect(connectionStates(handlers)).toEqual(['connecting', 'auth'])
    expect(lastSent(socket)).toEqual({ type: 'auth', token: 'secreto' })

    json(socket, { type: 'authenticated' })
    expect(connectionStates(handlers)).toEqual(['connecting', 'auth', 'open'])
  })

  it('sends an empty token rather than none when connect was given no token', () => {
    // The daemon still gets a well-formed auth message to reject: a missing
    // field would be a protocol error, not a wrong password.
    const live = new Live(allHandlers())
    live.connect()
    const socket = lastSocket()

    json(socket, { type: 'hello', authRequired: true })
    expect(lastSent(socket)).toEqual({ type: 'auth', token: '' })
  })

  it('dials ws:// on the page origin when the page is plain http', () => {
    const live = new Live(allHandlers())
    live.connect()

    expect(lastSocket().url).toBe('ws://desk.local/ws')
  })

  it('dials wss:// when the page came over https', () => {
    // Mixed content: a browser on an https page silently blocks ws:.
    vi.stubGlobal('window', { location: { href: 'https://desk.local/panel' } })
    const live = new Live(allHandlers())
    live.connect()

    expect(lastSocket().url).toBe('wss://desk.local/ws')
  })
})

describe('incoming messages', () => {
  it('hands the functions list to onFunctions untouched', () => {
    const { handlers, socket } = openLive()
    const functions: FunctionState[] = [
      { id: 3, name: 'Chase rojo', type: 'Chaser', running: true, step: 2, steps: 8 },
    ]

    json(socket, { type: 'functions', functions })
    expect(handlers.onFunctions).toHaveBeenCalledWith(functions)
  })

  it('routes slider and speeddial moves to the same fader handler', () => {
    // A speed dial is a fader wearing time units: the widget underneath
    // follows the same id/value contract.
    const { handlers, socket } = openLive()

    json(socket, { type: 'slider', id: 7, value: 128 })
    json(socket, { type: 'speeddial', id: 9, value: 450 })

    expect(handlers.onSlider).toHaveBeenNthCalledWith(1, 7, 128)
    expect(handlers.onSlider).toHaveBeenNthCalledWith(2, 9, 450)
  })

  it('keeps channel group moves out of the slider id space', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'channelgroup', id: 2, value: 200 })

    expect(handlers.onChannelGroup).toHaveBeenCalledWith(2, 200)
    expect(handlers.onSlider).not.toHaveBeenCalled()
  })

  it('reports show progress, reading a missing paused flag as not paused', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'show', id: 4, elapsed: 1500, running: true })
    expect(handlers.onShow).toHaveBeenCalledWith(4, 1500, true, false)

    json(socket, { type: 'show', id: 4, elapsed: 2000, running: true, paused: true })
    expect(handlers.onShow).toHaveBeenLastCalledWith(4, 2000, true, true)
  })

  it('delivers frame page turns', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'framepage', id: 5, page: 2 })
    expect(handlers.onFramePage).toHaveBeenCalledWith(5, 2)
  })

  it('passes an external input move through as universe, channel and value', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'input', universe: 0, channel: 15, value: 255 })
    expect(handlers.onInput).toHaveBeenCalledWith(0, 15, 255)
  })

  it('delivers beats with their bpm', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'beat', bpm: 120 })
    expect(handlers.onBeat).toHaveBeenCalledWith(120)
  })

  it('signals an access change with no payload', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'access' })
    expect(handlers.onAccess).toHaveBeenCalledTimes(1)
  })

  it('hands the whole video event over, extras and all', () => {
    // The video handler gets the raw event: which fields matter depends on
    // the action, and the player is the one that knows.
    const { handlers, socket } = openLive()
    const event = {
      type: 'video',
      id: 3,
      action: 'started',
      elapsed: 0,
      screen: 1,
      fullscreen: true,
      geometry: { x: 0, y: 0, width: 1920, height: 1080 },
    }

    json(socket, event)
    expect(handlers.onVideo).toHaveBeenCalledWith(event)
  })

  it('delivers XY pad aims', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'xypad', id: 6, x: 0.25, y: 0.75 })
    expect(handlers.onPad).toHaveBeenCalledWith(6, 0.25, 0.75)
  })

  it('delivers a spectrum with its bands and volume', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'spectrum', bands: [0, 128, 255], volume: 42 })
    expect(handlers.onSpectrum).toHaveBeenCalledWith([0, 128, 255], 42)
  })

  it('packs audio trigger state into one object, unavailable only when given', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'audiotriggers', id: 4, enabled: true, capturing: true })
    expect(handlers.onAudioTriggers).toHaveBeenCalledWith(4, { enabled: true, capturing: true })

    json(socket, {
      type: 'audiotriggers',
      id: 4,
      enabled: false,
      capturing: false,
      unavailable: 'sin micrófono',
    })
    expect(handlers.onAudioTriggers).toHaveBeenLastCalledWith(4, {
      enabled: false,
      capturing: false,
      unavailable: 'sin micrófono',
    })
  })

  it('defaults a bare changed message to the whole project', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'changed', what: ['fixtures'] })
    expect(handlers.onChanged).toHaveBeenCalledWith(['fixtures'])

    json(socket, { type: 'changed' })
    expect(handlers.onChanged).toHaveBeenLastCalledWith(['project'])
  })

  it('treats blackout as engaged only when the daemon says exactly true', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'blackout', on: true })
    expect(handlers.onBlackout).toHaveBeenCalledWith(true)

    json(socket, { type: 'blackout' })
    expect(handlers.onBlackout).toHaveBeenLastCalledWith(false)
  })

  it('reports the dump counters, zero when absent', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'dump', count: 12, bare: 3 })
    expect(handlers.onDump).toHaveBeenCalledWith(12, 3)

    json(socket, { type: 'dump' })
    expect(handlers.onDump).toHaveBeenLastCalledWith(0, 0)
  })

  it('reports what the simple desk holds, an empty hold when it holds nothing', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'simpledesk', universe: 1, held: { '5': 255 } })
    expect(handlers.onSimpleDesk).toHaveBeenCalledWith(1, { '5': 255 })

    json(socket, { type: 'simpledesk', universe: 2 })
    expect(handlers.onSimpleDesk).toHaveBeenLastCalledWith(2, {})
  })

  it('fills grand master defaults so a sparse message still paints a whole state', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'grandmaster' })
    expect(handlers.onGrandMaster).toHaveBeenCalledWith({
      value: 255,
      channelMode: 'Intensity',
      valueMode: 'Reduce',
      visible: true,
    })

    json(socket, {
      type: 'grandmaster',
      value: 128,
      channelMode: 'All',
      valueMode: 'Limit',
      visible: false,
    })
    expect(handlers.onGrandMaster).toHaveBeenLastCalledWith({
      value: 128,
      channelMode: 'All',
      valueMode: 'Limit',
      visible: false,
    })
  })

  it('flips the dirty flag both ways and carries the project name', () => {
    // Both edges matter: a "sin guardar" banner that survives the desktop
    // saving reads as a desk that lost the edits.
    const { handlers, socket } = openLive()

    json(socket, { type: 'project', dirty: true, name: 'bolo.qxw' })
    expect(handlers.onProject).toHaveBeenCalledWith(true, 'bolo.qxw')

    json(socket, { type: 'project' })
    expect(handlers.onProject).toHaveBeenLastCalledWith(false, '')
  })

  it('surfaces a daemon refusal, with a stock message when none came', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'error', message: 'sin permiso' })
    expect(handlers.onError).toHaveBeenCalledWith('sin permiso')

    json(socket, { type: 'error' })
    expect(handlers.onError).toHaveBeenLastCalledWith('La mesa rechazó la orden')
  })

  it('reports how many clients are connected, zero when the count is missing', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'remote', clients: 3 })
    expect(handlers.onRemote).toHaveBeenCalledWith(3)

    json(socket, { type: 'remote' })
    expect(handlers.onRemote).toHaveBeenLastCalledWith(0)
  })

  it('treats matrix and subscribed as acknowledgements: nothing dispatched', () => {
    const { handlers, socket } = openLive()

    json(socket, { type: 'matrix', id: 1, preset: 2 })
    json(socket, { type: 'subscribed', universes: [1] })

    for (const [name, handler] of Object.entries(handlers)) {
      if (name === 'onConnection') continue
      expect(handler).not.toHaveBeenCalled()
    }
    expect(socket.reported).toEqual([])
  })

  it('ignores a message type it has never heard of and keeps listening', () => {
    // A newer daemon will grow message types this client does not know.
    const { handlers, socket } = openLive()

    json(socket, { type: 'holographics', id: 1 })
    expect(socket.reported).toEqual([])

    json(socket, { type: 'beat', bpm: 120 })
    expect(handlers.onBeat).toHaveBeenCalledWith(120)
  })

  it('copes when the app registered only the required handlers', () => {
    // Every optional handler is optional for real: a minimal client must be
    // able to watch the connection without subscribing to everything.
    const handlers = { onFunctions: vi.fn(), onConnection: vi.fn() } satisfies LiveHandlers
    const live = new Live(handlers)
    live.connect()
    const socket = lastSocket()

    json(socket, { type: 'hello', authRequired: false })
    json(socket, { type: 'slider', id: 1, value: 2 })
    json(socket, { type: 'grandmaster', value: 10 })
    socket.message(new Uint8Array([1, 0, 9]).buffer)

    expect(socket.reported).toEqual([])
  })

  it('keeps the feed alive after a frame that is not JSON', () => {
    // Event dispatch contains the parse error (the fake mirrors that), so a
    // corrupt frame costs one console report, never the connection.
    const { handlers, socket } = openLive()

    socket.message('{"type": "beat", "bpm":')
    json(socket, { type: 'beat', bpm: 121 })

    expect(handlers.onBeat).toHaveBeenCalledWith(121)
    expect(connectionStates(handlers)).toEqual(['connecting', 'open'])
  })
})

describe('binary universe frames', () => {
  it('reads the two-byte little-endian header and hands over the channels', () => {
    const { handlers, socket } = openLive()

    socket.message(new Uint8Array([0x34, 0x12, 10, 20, 30]).buffer)

    expect(handlers.onUniverse).toHaveBeenCalledWith(0x1234, new Uint8Array([10, 20, 30]))
  })

  it('does not read the header big-endian', () => {
    // Universe 1 travels as 01 00; a big-endian read would call it 256 and
    // paint the wrong universe's monitor.
    const { handlers, socket } = openLive()

    socket.message(new Uint8Array([1, 0, 255]).buffer)

    expect(handlers.onUniverse).toHaveBeenCalledWith(1, new Uint8Array([255]))
  })

  it('survives a header-only frame, and even an empty one', () => {
    const { handlers, socket } = openLive()

    socket.message(new Uint8Array([2, 0]).buffer)
    expect(handlers.onUniverse).toHaveBeenLastCalledWith(2, new Uint8Array([]))

    socket.message(new ArrayBuffer(0))
    expect(handlers.onUniverse).toHaveBeenLastCalledWith(0, new Uint8Array([]))

    expect(socket.reported).toEqual([])
  })
})

describe('outgoing commands', () => {
  it('starts a stopped function and stops a running one', () => {
    const { live, socket } = openLive()

    live.toggle(5, false)
    expect(lastSent(socket)).toEqual({ type: 'function', id: 5, action: 'start' })

    live.toggle(5, true)
    expect(lastSent(socket)).toEqual({ type: 'function', id: 5, action: 'stop' })
  })

  it('flashes with explicit flags, defaulting both off, and unflashes bare', () => {
    const { live, socket } = openLive()

    live.flash(8, true)
    expect(lastSent(socket)).toEqual({
      type: 'function',
      id: 8,
      action: 'flash',
      override: false,
      forceLTP: false,
    })

    live.flash(8, true, { override: true, forceLTP: true })
    expect(lastSent(socket)).toEqual({
      type: 'function',
      id: 8,
      action: 'flash',
      override: true,
      forceLTP: true,
    })

    live.flash(8, false)
    expect(lastSent(socket)).toEqual({ type: 'function', id: 8, action: 'unflash' })
  })

  it('shapes every setter into the id-and-payload message the daemon expects', () => {
    const { live, socket } = openLive()

    live.setSlider(7, 128)
    expect(lastSent(socket)).toEqual({ type: 'slider', id: 7, value: 128 })

    live.setSpeedDial(3, 450)
    expect(lastSent(socket)).toEqual({ type: 'speeddial', id: 3, value: 450 })

    live.setChannelGroup(2, 64)
    expect(lastSent(socket)).toEqual({ type: 'channelgroup', id: 2, value: 64 })

    live.setAudioTriggers(4, true)
    expect(lastSent(socket)).toEqual({ type: 'audiotriggers', id: 4, enabled: true })

    live.setMatrixPreset(6, 2)
    expect(lastSent(socket)).toEqual({ type: 'matrix', id: 6, preset: 2 })

    live.setPad(9, 0.25, 0.75)
    expect(lastSent(socket)).toEqual({ type: 'xypad', id: 9, x: 0.25, y: 0.75 })

    live.setFramePage(11, 1)
    expect(lastSent(socket)).toEqual({ type: 'framepage', id: 11, page: 1 })
  })

  it('drives a cue list by chaser, with -1 standing for no particular cue', () => {
    const { live, socket } = openLive()

    live.cuelist(12, 'next')
    expect(lastSent(socket)).toEqual({ type: 'cuelist', chaser: 12, action: 'next', index: -1 })

    live.cuelist(12, 'step', 4)
    expect(lastSent(socket)).toEqual({ type: 'cuelist', chaser: 12, action: 'step', index: 4 })
  })

  it('sends the cue list side fader with its mode', () => {
    const { live, socket } = openLive()

    live.cuelistSideFader(12, 'Crossfade', 128)
    expect(lastSent(socket)).toEqual({
      type: 'cuelist',
      chaser: 12,
      action: 'sidefader',
      mode: 'Crossfade',
      value: 128,
    })
  })

  it('subscribes and unsubscribes with distinct verbs', () => {
    // Unsubscribe is its own message: the daemon reads subscribe([]) as
    // "add none" and would leave every frame flowing.
    const { live, socket } = openLive()

    live.subscribe([1, 2])
    expect(lastSent(socket)).toEqual({ type: 'subscribe', universes: [1, 2] })

    live.unsubscribe([1])
    expect(lastSent(socket)).toEqual({ type: 'unsubscribe', universes: [1] })
  })

  it('drops a command sent while the socket is not open, without throwing', () => {
    // Mid-reconnect there is nowhere to send to; a throw here would take the
    // whole press handler down with it.
    const live = new Live(allHandlers())
    live.connect()
    const socket = lastSocket()
    socket.readyState = FakeWebSocket.CONNECTING

    live.setSlider(1, 255)

    expect(socket.sent).toEqual([])
  })
})

describe('reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('redials after a drop it did not ask for, waiting 250 ms the first time', () => {
    const { handlers, socket } = openLive()

    socket.dropConnection()
    expect(connectionStates(handlers)).toEqual(['connecting', 'open', 'closed'])

    vi.advanceTimersByTime(249)
    expect(FakeWebSocket.instances).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(connectionStates(handlers)).toEqual(['connecting', 'open', 'closed', 'connecting'])
  })

  it('doubles the wait on each failure and never waits past eight seconds', () => {
    // Backing off spares a daemon that is coming back up; the cap keeps the
    // desk from ever feeling abandoned.
    openLive()
    const delays = [250, 500, 1000, 2000, 4000, 8000, 8000, 8000]
    let count = 1

    for (const delay of delays) {
      lastSocket().dropConnection()
      vi.advanceTimersByTime(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(count)
      vi.advanceTimersByTime(1)
      count += 1
      expect(FakeWebSocket.instances).toHaveLength(count)
    }
  })

  it('starts the backoff over once a connection succeeds', () => {
    openLive()
    lastSocket().dropConnection()
    vi.advanceTimersByTime(250)
    lastSocket().dropConnection()
    vi.advanceTimersByTime(500)

    // The third socket connects properly...
    json(lastSocket(), { type: 'hello', authRequired: false })
    lastSocket().dropConnection()

    // ...so the next drop waits the starting 250 ms again, not a second.
    vi.advanceTimersByTime(249)
    expect(FakeWebSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('carries the token through a reconnect so auth still works', () => {
    const handlers = allHandlers()
    const live = new Live(handlers)
    live.connect('llave')
    json(lastSocket(), { type: 'hello', authRequired: true })
    json(lastSocket(), { type: 'authenticated' })

    lastSocket().dropConnection()
    vi.advanceTimersByTime(250)

    const second = lastSocket()
    json(second, { type: 'hello', authRequired: true })
    expect(lastSent(second)).toEqual({ type: 'auth', token: 'llave' })
  })

  it('stays closed after close(): a deliberate goodbye is not an outage', () => {
    const { live, handlers, socket } = openLive()

    live.close()
    socket.dropConnection()

    expect(connectionStates(handlers)).toEqual(['connecting', 'open', 'closed'])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
