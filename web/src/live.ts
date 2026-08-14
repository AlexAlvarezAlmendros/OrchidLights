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
  onPad?: (id: number, x: number, y: number) => void
  onUniverse?: (universe: number, channels: Uint8Array) => void
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
        case 'xypad':
          this.handlers.onPad?.(message.id, message.x, message.y)
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

  setSpeedDial(id: number, milliseconds: number): void {
    this.send({ type: 'speeddial', id, value: milliseconds })
  }

  setSlider(id: number, value: number): void {
    this.send({ type: 'slider', id, value })
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

  close(): void {
    this.closedByUs = true
    this.socket?.close()
  }
}
