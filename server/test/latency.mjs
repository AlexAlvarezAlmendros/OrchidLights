/*
  Measures what F2 promises: the time from a control moving to the resulting
  value appearing on a universe.

    node server/test/latency.mjs ws://127.0.0.1:9998/ws <sliderId> [samples]

  The clock starts when the command leaves this process and stops on the first
  DMX frame carrying the value that was asked for. That interval contains the
  socket hop, the engine's next tick, and the feed's own flush -- which is the
  whole point: an operator does not care which of those three cost the time.

  Everything is measured over one connection, because opening a socket per
  sample would measure the handshake instead.
*/

const url = process.argv[2] ?? 'ws://127.0.0.1:9998/ws'
const sliderId = Number(process.argv[3] ?? 0)
const samples = Number(process.argv[4] ?? 30)

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

/** Values still in flight, by the value asked for. */
const pending = new Map()
const latencies = []
let index = 0

const deadline = setTimeout(() => report('timed out'), 40_000)

socket.addEventListener('error', () => report('socket error'))

socket.addEventListener('message', (event) => {
  if (event.data instanceof ArrayBuffer) {
    const frame = new Uint8Array(event.data)
    const now = performance.now()

    // A frame carries the whole universe, so look for the value we are waiting
    // for rather than a particular channel: the slider may drive several.
    for (const [value, sentAt] of pending) {
      if (frame.includes(value)) {
        latencies.push(now - sentAt)
        pending.delete(value)
        next()
      }
    }
    return
  }

  const message = JSON.parse(event.data)
  if (message.type === 'hello') {
    socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
    setTimeout(next, 200)
  }
  if (message.type === 'error') report(message.error)
})

function next() {
  if (latencies.length >= samples) return report(null)

  // Distinct values, so a frame can be attributed to the command that caused
  // it. Stepping by 3 keeps them clear of each other and of zero.
  const value = 20 + ((index++ * 3) % 200)
  pending.set(value, performance.now())
  socket.send(JSON.stringify({ type: 'slider', id: sliderId, value }))
}

function report(error) {
  clearTimeout(deadline)

  latencies.sort((a, b) => a - b)
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]

  console.log(
    JSON.stringify({
      samples: latencies.length,
      min: round(latencies[0]),
      median: round(at(0.5)),
      p95: round(at(0.95)),
      max: round(latencies.at(-1)),
      error: error ?? null,
    }),
  )

  socket.close()
  process.exit(error ? 1 : 0)
}

function round(value) {
  return value === undefined ? null : Math.round(value * 10) / 10
}
