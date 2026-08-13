/*
  OrchidLights -- WebSocket exercise client.

  Connects, authenticates if asked to, subscribes to a universe, starts a
  function and reports what came back. Used by ws-smoke.sh; also handy on its
  own while poking at a running daemon.

    node server/test/ws-client.mjs ws://127.0.0.1:9998/ws [token]

  Node 22 has a global WebSocket, so this needs nothing installed.
*/

const url = process.argv[2] ?? 'ws://127.0.0.1:9998/ws'
const token = process.argv[3] ?? ''

const seen = {
  hello: null,
  authenticated: false,
  functions: 0,
  binaryFrames: 0,
  universesInFrames: new Set(),
  frameBytes: 0,
  errors: [],
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

/* A test that hangs is a test that tells you nothing. */
const deadline = setTimeout(() => {
  finish('timed out waiting for the daemon')
}, 15000)

let finished = false

function finish(error) {
  /* A socket error can fire repeatedly while we are tearing down, and printing
     the report several times makes the output unparseable. */
  if (finished) return
  finished = true

  clearTimeout(deadline)
  const result = {
    ...seen,
    universesInFrames: [...seen.universesInFrames],
    error: error ?? null,
  }
  console.log(JSON.stringify(result))
  try { socket.close() } catch { /* already gone */ }
  process.exit(error ? 1 : 0)
}

socket.addEventListener('error', () => finish('socket error'))

/* The daemon closes the socket on a bad token. That is the expected outcome of
   that case, not a failure, so report what was seen rather than sitting here
   until the deadline. */
socket.addEventListener('close', () => finish(seen.hello ? null : 'closed before hello'))

socket.addEventListener('message', (event) => {
  if (event.data instanceof ArrayBuffer) {
    const frame = new Uint8Array(event.data)
    seen.binaryFrames += 1
    seen.frameBytes = frame.length
    /* Two bytes of little-endian 1-based universe id, then channel values. */
    seen.universesInFrames.add(frame[0] | (frame[1] << 8))
    return
  }

  const message = JSON.parse(event.data)

  switch (message.type) {
    case 'hello':
      seen.hello = message
      if (message.authRequired) {
        socket.send(JSON.stringify({ type: 'auth', token }))
      } else {
        ready()
      }
      break

    case 'authenticated':
      seen.authenticated = true
      ready()
      break

    case 'functions':
      seen.functions = message.functions.length
      break

    case 'error':
      seen.errors.push(message.error)
      break
  }
})

function ready() {
  socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

  /* Starting a scene makes the universes change, which is what produces the
     binary frames in the first place: the engine only emits on change. */
  socket.send(JSON.stringify({ type: 'function', id: Number(process.env.FUNCTION_ID ?? 0), action: 'start' }))

  setTimeout(() => finish(null), 3000)
}
