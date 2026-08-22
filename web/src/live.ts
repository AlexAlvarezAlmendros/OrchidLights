import type { FunctionState } from './api'

/**
 * The live feed.
 *
 * Commands go out over this socket rather than through REST: a button press has
 * a 50 ms budget from tap to DMX, and an already-open socket skips the request
 * setup entirely. State comes back the same way, so the interface never has to
 * poll and never shows a stale button.
 */

export type Connection = 'connecting' | 'open' | 'auth' | 'closed'

export interface LiveHandlers {
  onFunctions: (functions: FunctionState[]) => void
  onConnection: (state: Connection) => void
  /** Another client moved a fader; ours needs to follow. */
  onSlider?: (id: number, value: number) => void
  /** Another client moved a channels group. Its own message rather than a
   *  slider, because group ids and widget ids are different id spaces. */
  onChannelGroup?: (id: number, value: number) => void
  onPad?: (id: number, x: number, y: number) => void
  /** Where a running show has got to, in milliseconds. Sent at the flush rate
   *  while one plays, and once more with running: false when it ends. */
  onShow?: (id: number, elapsed: number, running: boolean, paused: boolean) => void
  /** An external control moved. Carried live because binding a widget to one
   *  means watching for the next thing the operator touches. */
  onInput?: (universe: number, channel: number, value: number) => void
  onFramePage?: (id: number, page: number) => void
  /** The project changed under us. `what` names what, or ["project"] when the
   *  change is one nothing reports in detail. */
  onChanged?: (what: string[]) => void
  /** A new spectrum from the microphone, 0..255 per band. */
  onSpectrum?: (bands: number[], volume: number) => void
  /** An audio triggers widget was switched on or off -- by us or by anyone. */
  onAudioTriggers?: (
    id: number,
    state: { enabled: boolean; capturing: boolean; unavailable?: string },
  ) => void
  onUniverse?: (universe: number, channels: Uint8Array) => void
  /** Blackout engaged or released -- by us or by anyone. */
  onBlackout?: (on: boolean) => void
  /** What a dump would capture changed. The button in the bar wears this. */
  onDump?: (count: number, bare: number) => void
  /** The Simple Desk changed what it holds on a universe (1-based). */
  onSimpleDesk?: (universe: number, held: Record<string, number>) => void
  /** The Grand Master moved or changed mode -- by anyone. */
  onGrandMaster?: (state: {
    value: number
    channelMode: string
    valueMode: string
    visible: boolean
  }) => void
  /** The dirty flag flipped -- an edit landed, or a save (anyone's) cleaned
   *  it. Both edges travel: a banner that says "sin guardar" after the
   *  desktop saved reads as a desk that lost the edits. */
  onProject?: (dirty: boolean, name: string) => void
  /** The daemon refused something this client sent. Surfaced, not swallowed:
   *  a press that did nothing and said nothing teaches the operator that the
   *  desk is broken. */
  onError?: (message: string) => void
}

export class Live {
  private socket: WebSocket | null = null
  private retry = 0
  private closedByUs = false

  constructor(private readonly handlers: LiveHandlers) {}

  connect(token?: string): void {
    this.closedByUs = false
    this.handlers.onConnection('connecting')

    const url = new URL('/ws', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = new Uint8Array(event.data)
        // Two bytes of little-endian 1-based universe id, then channel values.
        const universe = (frame[0] ?? 0) | ((frame[1] ?? 0) << 8)
        this.handlers.onUniverse?.(universe, frame.subarray(2))
        return
      }

      const message = JSON.parse(event.data as string)

      switch (message.type) {
        case 'hello':
          if (message.authRequired) {
            this.handlers.onConnection('auth')
            socket.send(JSON.stringify({ type: 'auth', token: token ?? '' }))
          } else {
            this.retry = 0
            this.handlers.onConnection('open')
          }
          break
        case 'authenticated':
          this.retry = 0
          this.handlers.onConnection('open')
          break
        case 'functions':
          this.handlers.onFunctions(message.functions)
          break
        case 'slider':
        case 'speeddial':
          this.handlers.onSlider?.(message.id, message.value)
          break
        case 'channelgroup':
          this.handlers.onChannelGroup?.(message.id, message.value)
          break
        case 'show':
          this.handlers.onShow?.(
            message.id,
            message.elapsed,
            message.running,
            message.paused === true,
          )
          break
        case 'framepage':
          this.handlers.onFramePage?.(message.id, message.page)
          break
        case 'input':
          this.handlers.onInput?.(message.universe, message.channel, message.value)
          break
        case 'xypad':
          this.handlers.onPad?.(message.id, message.x, message.y)
          break
        case 'spectrum':
          this.handlers.onSpectrum?.(message.bands, message.volume)
          break
        case 'audiotriggers':
          this.handlers.onAudioTriggers?.(message.id, {
            enabled: message.enabled,
            capturing: message.capturing,
            unavailable: message.unavailable,
          })
          break
        case 'matrix':
          // Nothing to mirror locally: the change lands in the engine, and the
          // matrix's own output is what the operator watches.
          break
        case 'changed':
          this.handlers.onChanged?.(message.what ?? ['project'])
          break
        case 'blackout':
          this.handlers.onBlackout?.(message.on === true)
          break
        case 'dump':
          this.handlers.onDump?.(Number(message.count ?? 0), Number(message.bare ?? 0))
          break
        case 'simpledesk':
          this.handlers.onSimpleDesk?.(Number(message.universe ?? 0), message.held ?? {})
          break
        case 'grandmaster':
          this.handlers.onGrandMaster?.({
            value: Number(message.value ?? 255),
            channelMode: String(message.channelMode ?? 'Intensity'),
            valueMode: String(message.valueMode ?? 'Reduce'),
            visible: message.visible !== false,
          })
          break
        case 'project':
          this.handlers.onProject?.(message.dirty === true, String(message.name ?? ''))
          break
        case 'error':
          this.handlers.onError?.(String(message.message ?? 'La mesa rechazó la orden'))
          break
        case 'subscribed':
          // An acknowledgement, deliberately unused: the effect of a
          // subscription is the frames themselves arriving.
          break
      }
    })

    socket.addEventListener('close', () => {
      this.handlers.onConnection('closed')
      if (this.closedByUs) return

      // A desk that quietly stops responding is worse than one that says so,
      // so reconnect, backing off but never giving up.
      this.retry = Math.min(this.retry + 1, 6)
      setTimeout(() => this.connect(token), 250 * 2 ** (this.retry - 1))
    })
  }

  send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  toggle(id: number, running: boolean): void {
    this.send({ type: 'function', id, action: running ? 'stop' : 'start' })
  }

  /** Turn a multipage frame to a page. The daemon broadcasts the result to
   *  every client, this one included. */
  setFramePage(id: number, page: number): void {
    this.send({ type: 'framepage', id, page })
  }

  /** The cue list's side fader: Steps maps it onto the cue list, Crossfade
   *  blends the running cue with the next. */
  cuelistSideFader(chaser: number, mode: string, value: number): void {
    this.send({ type: 'cuelist', chaser, action: 'sidefader', mode, value })
  }

  /** Hold-to-light through the engine's own flash overlay: it lights
   *  without owning the function's run state, and honours the button's
   *  override / force-LTP flags. */
  flash(id: number, on: boolean, flags?: { override?: boolean; forceLTP?: boolean }): void {
    this.send(
      on
        ? {
            type: 'function',
            id,
            action: 'flash',
            override: flags?.override ?? false,
            forceLTP: flags?.forceLTP ?? false,
          }
        : { type: 'function', id, action: 'unflash' },
    )
  }

  setSpeedDial(id: number, milliseconds: number): void {
    this.send({ type: 'speeddial', id, value: milliseconds })
  }

  setSlider(id: number, value: number): void {
    this.send({ type: 'slider', id, value })
  }

  /** Move a channels group. Addressed by group id, which is the document's own
   *  numbering and has nothing to do with the console's. */
  setChannelGroup(id: number, value: number): void {
    this.send({ type: 'channelgroup', id, value })
  }

  /** Switch an audio triggers widget on or off. The daemon holds the
   *  microphone only while at least one is on. */
  setAudioTriggers(id: number, enabled: boolean): void {
    this.send({ type: 'audiotriggers', id, enabled })
  }

  /** Apply one of a matrix widget's presets. Addressed by widget, because the
   *  preset belongs to the widget and the matrix is its business. */
  setMatrixPreset(id: number, preset: number): void {
    this.send({ type: 'matrix', id, preset })
  }

  /** Aim an XY pad, 0..1 on each axis. What that means for each head is the
   *  project's business, not the interface's. */
  setPad(id: number, x: number, y: number): void {
    this.send({ type: 'xypad', id, x, y })
  }

  /**
   * Transport for a cue list, which is a chaser plus next/previous.
   *
   * Addressed by chaser, not by widget: the same chaser can be driven from a
   * cue list, a button and another client at once, and they all have to agree
   * about which cue is up.
   */
  cuelist(
    chaser: number,
    action: 'play' | 'stop' | 'next' | 'previous' | 'step',
    index = -1,
  ): void {
    this.send({ type: 'cuelist', chaser, action, index })
  }

  subscribe(universes: number[]): void {
    this.send({ type: 'subscribe', universes })
  }

  /** Stop the frames. Its own message rather than subscribing to an empty
   *  list, which the daemon reads as "add none" and leaves everything on. */
  unsubscribe(universes: number[]): void {
    this.send({ type: 'unsubscribe', universes })
  }

  close(): void {
    this.closedByUs = true
    this.socket?.close()
  }
}
