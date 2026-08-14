/**
 * Frames: solo, and the engine's half of it.
 *
 *   node frames-client.mjs <ws-url> <token>
 *
 * A solo frame's contents are mutually exclusive -- the colour bank where
 * picking red should drop blue. The rule is enforced in the daemon rather than
 * in the interface because two clients have to agree about it: if one browser
 * did it and another did not, the frame would only be solo for whoever pressed
 * last.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const RED = 0
const BLUE = 1
const GREEN = 2
const SMOKE = 3 // in a plain frame, so it is not part of anyone's solo

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
let functions = []

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const message = JSON.parse(event.data)
  if (message.type === 'functions') functions = message.functions
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const running = () => new Set(functions.filter((f) => f.running).map((f) => f.id))

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(400)

/** Fire a function and wait for the engine to say it did. */
async function start(id) {
  socket.send(JSON.stringify({ type: 'function', id, action: 'start' }))
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    if (running().has(id)) return true
  }
  return false
}

try {
  check('red starts', await start(RED))

  check('blue starts and red drops', (await start(BLUE)) && !running().has(RED),
        [...running()].join(','))

  check('green starts and blue drops', (await start(GREEN)) && !running().has(BLUE),
        [...running()].join(','))

  /* The other half of the rule, and the one that is easy to get wrong by
     stopping everything: a function outside the solo frame is nobody's
     sibling, and green has to survive it starting. */
  check('smoke is outside the frame, so green survives',
        (await start(SMOKE)) && running().has(GREEN),
        [...running()].join(','))

  socket.send(JSON.stringify({ type: 'function', id: GREEN, action: 'stop' }))
  socket.send(JSON.stringify({ type: 'function', id: SMOKE, action: 'stop' }))
  await sleep(400)
  check('and both stop when asked', running().size === 0, [...running()].join(','))

  /* A playback slider rides a function rather than writing channels: at zero
     it stops it, above zero it starts it and holds its intensity there. The
     start and the stop are what can be observed from here; the intensity is an
     attribute override the engine applies to the running function. */
  const PLAYBACK = 10

  socket.send(JSON.stringify({ type: 'slider', id: PLAYBACK, value: 200 }))
  let started = false
  for (let i = 0; i < 30 && !started; i++) {
    await sleep(100)
    started = running().has(SMOKE)
  }
  check('a playback slider starts its function', started, [...running()].join(','))

  socket.send(JSON.stringify({ type: 'slider', id: PLAYBACK, value: 0 }))
  let stopped = false
  for (let i = 0; i < 30 && !stopped; i++) {
    await sleep(100)
    stopped = !running().has(SMOKE)
  }
  check('and stops it at zero', stopped, [...running()].join(','))
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nSolo frame test passed.')
process.exit(0)
