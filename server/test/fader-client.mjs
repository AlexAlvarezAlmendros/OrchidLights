/**
 * What an edit to the console does to the faders that are holding a look.
 *
 *   node fader-client.mjs <ws-url> <token>
 *
 * Editing the Virtual Console makes the daemon re-read it and re-register
 * everything with the engine. Two things must survive that, and neither did:
 *
 *  - the value a fader is holding, which is the look on stage;
 *  - the fader's exclusive claim on its channels, because a Universe keeps its
 *    own reference to every fader it hands out. Dropping ours did not
 *    unregister it, so each edit stranded one that carried on asserting its
 *    last value -- and since faders merge highest-takes-precedence, the slider
 *    could never bring the channel back down.
 *
 * Read off the wire, because that is the only place the difference shows.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const SLIDER = 1
// Slider 1 drives fixture 1's channels 0 and 1; fixture 1 sits at address 4.
const CHANNELS = [3, 4]

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  dmx = new Uint8Array(event.data).slice(2)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const held = () => CHANNELS.map((c) => dmx?.[c])
const base = new URL(url.replace(/^ws/, 'http')).origin

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

try {
  socket.send(JSON.stringify({ type: 'slider', id: SLIDER, value: 200 }))
  await sleep(600)
  check('a fader reaches its channels', held().every((v) => v === 200), held().join(','))

  // Any edit at all: this one only renames a widget the fader knows nothing
  // about, which is the point -- the console is re-read either way.
  await fetch(`${base}/api/v1/vc/widgets/3`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption: 'Editado' }),
  })
  await sleep(900)
  check('and keeps holding it across an edit', held().every((v) => v === 200), held().join(','))

  socket.send(JSON.stringify({ type: 'slider', id: SLIDER, value: 0 }))
  await sleep(900)
  check('and can still be brought down', held().every((v) => v === 0), held().join(','))

  // Up again, so the check above cannot pass by everything simply being dead.
  socket.send(JSON.stringify({ type: 'slider', id: SLIDER, value: 120 }))
  await sleep(600)
  check('and back up', held().every((v) => v === 120), held().join(','))
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nFader survival test passed.')
process.exit(0)
