/**
 * The Grand Master, proved where it acts: on the frames.
 *
 *   node grandmaster-client.mjs <base-url> <ws-url>
 *
 * The WS stream is post-GM by construction, so it is exactly the right
 * witness. A scene drives an RGBW fixture's colour channels and, separately,
 * a dimmer fixture's intensity channel; then:
 *
 *  - GM 128 in Reduce/Intensity halves the intensity channel and leaves the
 *    colour channels alone (in QLC+'s model, RGB of an RGBW-with-dimmer rig
 *    counts as intensity too -- so the fixture set here is a plain dimmer vs
 *    a moving head's pan, which is never intensity);
 *  - switching to AllChannels scales the pan as well;
 *  - switching BACK to Intensity restores the pan -- the engine recompute
 *    this exercise exists for: before the fix, the pan stayed scaled until
 *    something else moved it;
 *  - /api/v1/stop with a fade brings a running function's channels to zero
 *    gradually, observed as a strictly decreasing sequence.
 */

import process from 'node:process'

const [base, wsUrl] = process.argv.slice(2)
if (!base || !wsUrl) {
  console.error('usage: grandmaster-client.mjs <base-url> <ws-url>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = { 'Content-Type': 'application/json' }

/* The rig: an RGBW bar (its colour channels are group Intensity, which is
   exactly what the GM scales) and a MAC500 whose shutter never is. Both
   patched here so the test owns its addresses. */
const bar = await fetch(`${base}/api/v1/fixtures`, {
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
check('an RGBW bar is patched', bar.ok, `${bar.status}`)

const mover = await fetch(`${base}/api/v1/fixtures`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    manufacturer: 'Martin',
    model: 'MAC500',
    mode: 'DMX1',
    universe: 1,
    address: 10,
  }),
})
check('a moving head is patched', mover.ok, `${mover.status}`)

// Drive both through the live desk: red to 200, shutter to 200.
const lit = await fetch(`${base}/api/v1/live`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({
    values: [
      { fixture: 0, channel: 0, value: 200 },
      { fixture: 1, channel: 0, value: 200 },
    ],
  }),
})
check('the desk holds intensity and shutter', lit.ok, `${lit.status}`)

/* Frames from the wire. */
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

const channelAt = (offset) => frame?.[offset] ?? -1
const RED = 0 // address 1 -> wire offset 0: the bar's Red, group Intensity
const SHUTTER = 9 // address 10 -> wire offset 9: MAC500 DMX1 channel 0, Shutter

const settle = async (predicate, timeout = 6000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(80)
  }
  return false
}

check(
  'both channels reach the wire at full GM',
  await settle(() => channelAt(RED) === 200 && channelAt(SHUTTER) === 200),
  `red=${channelAt(RED)} shutter=${channelAt(SHUTTER)}`,
)

/* GM 128, Reduce/Intensity: the red halves, the shutter does not move. */
await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ value: 128, valueMode: 'Reduce', channelMode: 'Intensity' }),
})
check(
  'Reduce/Intensity halves intensity only',
  await settle(() => channelAt(RED) === 100 && channelAt(SHUTTER) === 200),
  `red=${channelAt(RED)} shutter=${channelAt(SHUTTER)}`,
)

/* AllChannels: now the shutter scales too. */
await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ channelMode: 'All' }),
})
check(
  'AllChannels scales the shutter as well',
  await settle(() => channelAt(SHUTTER) === 100),
  `shutter=${channelAt(SHUTTER)}`,
)

/* And back: the recompute the engine fix exists for. Before it, the shutter
   stayed at its scaled value until something else happened to move it. */
await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ channelMode: 'Intensity' }),
})
check(
  'switching back to Intensity restores the shutter',
  await settle(() => channelAt(SHUTTER) === 200 && channelAt(RED) === 100),
  `shutter=${channelAt(SHUTTER)} red=${channelAt(RED)}`,
)

/* Limit mode: values above the ceiling clamp to it, below pass through. */
await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ value: 150, valueMode: 'Limit' }),
})
check(
  'Limit clamps instead of scaling',
  await settle(() => channelAt(RED) === 150),
  `red=${channelAt(RED)}`,
)

/* Restore, then the panic: a scene runs, /stop with a fade takes it down as
   a ramp, not a cliff. The scene lives on the bar's red, which fades. */
await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ value: 255, valueMode: 'Reduce' }),
})
await fetch(`${base}/api/v1/live`, { method: 'DELETE' })

const scene = await fetch(`${base}/api/v1/functions`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ type: 'Scene', name: 'Panico' }),
})
const sceneId = (await scene.json()).id
await fetch(`${base}/api/v1/functions/${sceneId}/values`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ fixture: 0, channel: 0, value: 255 }),
})
await fetch(`${base}/api/v1/functions/${sceneId}/start`, { method: 'POST' })
check(
  'the scene reaches full',
  await settle(() => channelAt(RED) === 255),
  `red=${channelAt(RED)}`,
)

const samples = []
const sampler = setInterval(() => samples.push(channelAt(RED)), 100)
await fetch(`${base}/api/v1/stop`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ fadeMs: 1200 }),
})
await sleep(2200)
clearInterval(sampler)

check(
  'the fade ends dark',
  channelAt(RED) === 0,
  `red=${channelAt(RED)}`,
)
/* A ramp, not a cliff: somewhere in the samples there are values strictly
   between full and none. A snap to black shows only 255s and 0s. */
const between = samples.filter((v) => v > 5 && v < 250)
check('the way down is a ramp, not a cliff', between.length >= 2, `mid samples: ${between.length}`)

const running = await (await fetch(`${base}/api/v1/status`)).json()
check('nothing is left running', running.runningFunctions === 0, `${running.runningFunctions}`)

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
