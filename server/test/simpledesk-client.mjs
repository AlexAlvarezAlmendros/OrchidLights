/**
 * The Simple Desk, proved on the frames.
 *
 *   node simpledesk-client.mjs <base-url> <ws-url>
 *
 * Four promises, each read off the wire:
 *
 *  - the keypad's grammar means what it means in QLC+ 5: `1 THRU 10 AT FULL`
 *    puts ten channels at 255, `-% 10` takes a tenth off the CURRENT value;
 *  - a channel with NO fixture patched responds -- the one thing that tells
 *    this desk apart from the fixture-addressed live desk;
 *  - a held channel BEATS a running function (Override), and releasing it
 *    lets the function show through again;
 *  - releasing a universe returns every channel to its default.
 */

import process from 'node:process'

const [base, wsUrl] = process.argv.slice(2)
if (!base || !wsUrl) {
  console.error('usage: simpledesk-client.mjs <base-url> <ws-url>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = { 'Content-Type': 'application/json' }

/* One RGBW bar at address 1, so the override-vs-function chapter has a
   function target; everything above address 4 is bare wire. */
await fetch(`${base}/api/v1/fixtures`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    manufacturer: 'Generic',
    model: 'Generic RGBW',
    mode: 'RGBW',
    universe: 1,
    address: 1,
  }),
})

let frame = null
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  const bytes = new Uint8Array(event.data)
  const universe = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
  if (universe === 1) frame = bytes.subarray(2)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

/* Beyond the frame's tail IS dark: the stream carries only the channels the
   universe has grown to use, and an address it never touched reads as zero. */
const at = (address1) => (frame === null ? -1 : (frame[address1 - 1] ?? 0))
const settle = async (predicate, timeout = 6000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(80)
  }
  return false
}

const keypad = (command) =>
  fetch(`${base}/api/v1/simpledesk/1/keypad`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ command }),
  })

/* 1. The grammar, on the wire. */
await keypad('100 THRU 109 AT FULL')
check(
  'THRU puts ten channels at full',
  await settle(() => at(100) === 255 && at(109) === 255 && at(110) === 0),
  `100=${at(100)} 109=${at(109)} 110=${at(110)}`,
)

await keypad('100 AT 200')
await settle(() => at(100) === 200)
await keypad('100 -% 10')
check(
  '-% takes a tenth off the current value',
  await settle(() => at(100) === 180),
  `100=${at(100)}`,
)

/* 2. Bare wire: channel 500 has no fixture anywhere near it. This is the
   difference between this desk and /live, which cannot address it at all. */
const bare = await fetch(`${base}/api/v1/simpledesk/1/channels`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ values: { '500': 222 } }),
})
check('a bare channel can be held', bare.ok, `${bare.status}`)
check(
  'and its value reaches the wire',
  await settle(() => at(500) === 222),
  `500=${at(500)}`,
)

/* 3. Override beats a running function; release lets it back through. */
const scene = await fetch(`${base}/api/v1/functions`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ type: 'Scene', name: 'Debajo' }),
})
const sceneId = (await scene.json()).id
await fetch(`${base}/api/v1/functions/${sceneId}/values`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ fixture: 0, channel: 0, value: 90 }),
})
await fetch(`${base}/api/v1/functions/${sceneId}/start`, { method: 'POST' })
check(
  'a scene drives channel 1',
  await settle(() => at(1) === 90),
  `1=${at(1)}`,
)

await fetch(`${base}/api/v1/simpledesk/1/channels`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ values: { '1': 40 } }),
})
check(
  'the desk overrides the running scene',
  await settle(() => at(1) === 40),
  `1=${at(1)}`,
)

await fetch(`${base}/api/v1/simpledesk/1/channels/1`, { method: 'DELETE' })
check(
  'releasing the channel lets the scene show through',
  await settle(() => at(1) === 90),
  `1=${at(1)}`,
)
await fetch(`${base}/api/v1/functions/${sceneId}/stop`, { method: 'POST' })

/* 4. Releasing the universe darkens the bare channels it held. */
await fetch(`${base}/api/v1/simpledesk/1`, { method: 'DELETE' })
check(
  'releasing the universe returns the bare wire to zero',
  await settle(() => at(500) === 0 && at(100) === 0),
  `500=${at(500)} 100=${at(100)}`,
)

const heldAfter = await (await fetch(`${base}/api/v1/simpledesk/1`)).json()
check(
  'the desk admits to holding nothing',
  Object.keys(heldAfter.held).length === 0,
  JSON.stringify(heldAfter.held),
)

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
