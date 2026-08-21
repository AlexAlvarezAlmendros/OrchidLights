/**
 * External input made to act, proved through the loopback plugin.
 *
 *   node input-client.mjs <base-url> <ws-url>
 *
 * The wire is the loop: universe B's OUTPUT is patched to a Loopback line and
 * its INPUT to the same line, so anything the engine writes on B comes back as
 * external input -- exactly what a MIDI wing would send, produced without
 * hardware. B's feedback rides the same line, which is the only wiring the
 * loopback can deliver (the input patch filters by source universe) -- and
 * the hostile case the router's edge logic must survive.
 *
 *  - a button binding starts the scene, and the scene's DMX on universe A is
 *    the proof (Toggle: acts on the press edge, ignores the release);
 *  - the Grand Master binding scales universe A, read off the frames -- bound
 *    through a SHUTTER channel on purpose, because a GM bound to a channel the
 *    GM itself scales would chase its own tail downward in this loop;
 *  - feedback for the button's state comes back on the looped line at the
 *    widget's custom upper value, and the router reads it as a non-edge;
 *  - the bindings survive in the saved .qxw, byte-greppable.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, savePath] = process.argv.slice(2)
if (!base || !wsUrl || !savePath) {
  console.error('usage: input-client.mjs <base-url> <ws-url> <save-path>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = { 'Content-Type': 'application/json' }
const token = readFileSync(`${homedir()}/.orchidlights/api-token`, 'utf8').trim()

/* Frames of universe A (1) and every input event, off the same socket. */
let frameA = null
const inputs = []
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') {
    const message = JSON.parse(event.data)
    if (message.type === 'input') inputs.push(message)
    return
  }
  const bytes = new Uint8Array(event.data)
  const universe = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
  if (universe === 1) frameA = bytes.subarray(2)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

const at = (address1) => (frameA === null ? -1 : (frameA[address1 - 1] ?? 0))
const settle = async (predicate, timeout = 6000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(80)
  }
  return false
}

/* --- The loop ------------------------------------------------------------ */

const io = await (await fetch(`${base}/api/v1/io`)).json()
const loopOut = io.outputPlugins.find((p) => p.name === 'Loopback')
const loopIn = io.inputPlugins.find((p) => p.name === 'Loopback')
check('the Loopback plugin is loaded', Boolean(loopOut && loopIn),
  io.outputPlugins.map((p) => p.name).join(', '))
if (!loopOut || !loopIn) {
  socket.close()
  process.exit(1)
}

/* Universe B (2): out, in AND feedback on the same line -- the wire becomes
   the wing, and the wing's LEDs are the same wire. The loopback can only
   deliver to the universe it came from (the input patch filters by source
   universe), so B watching its own feedback is not a shortcut, it is the only
   observable wiring -- and exactly the hostile case the router's edge
   detection has to survive without a button talking to itself. */
const patched = await fetch(`${base}/api/v1/universes/2`, {
  method: 'PATCH',
  headers: json,
  body: JSON.stringify({
    output: { plugin: 'Loopback', line: loopOut.lines[0] },
    input: { plugin: 'Loopback', line: loopIn.lines[0] },
    feedback: { plugin: 'Loopback', line: loopOut.lines[0] },
  }),
})
check('universe B loops out, in and feedback on one line', patched.ok, `${patched.status}`)

const universes = await (await fetch(`${base}/api/v1/universes`)).json()
const b = universes.find((u) => u.id === 2)
check('the patches read back', b?.input?.plugin === 'Loopback' && b?.feedback?.plugin === 'Loopback',
  JSON.stringify({ input: b?.input, feedback: b?.feedback }))

/* --- The rig ------------------------------------------------------------- */

/* A lamp on A for the scene to light, and a MAC500 on B so the GM binding
   rides a Shutter channel the grand master never scales. */
await fetch(`${base}/api/v1/fixtures`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 1 }),
})
await fetch(`${base}/api/v1/fixtures`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ manufacturer: 'Martin', model: 'MAC500', mode: 'DMX1', universe: 2, address: 8 }),
})

const scene = await (await fetch(`${base}/api/v1/functions`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ type: 'Scene', name: 'Disparada' }),
})).json()
await fetch(`${base}/api/v1/functions/${scene.id}/values`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ fixture: 0, channel: 0, value: 201 }),
})

/* A button carrying the scene, bound to input (universe B = index 1, channel
   5 = desk channel 6), with a custom ON feedback of 200. */
const made = await (await fetch(`${base}/api/v1/vc/widgets`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    type: 'button',
    caption: 'Externa',
    functionId: scene.id,
    input: { universe: 1, channel: 5, upper: 200 },
  }),
})).json()
check('a button with an input binding is created', made.id !== undefined, JSON.stringify(made))

/* --- Press by wire ------------------------------------------------------- */

const drive = (channel1, value) =>
  fetch(`${base}/api/v1/simpledesk/2/channels`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ values: { [String(channel1)]: value } }),
  })

await drive(6, 255)
check(
  'the wire presses the button and the scene lights universe A',
  await settle(() => at(1) === 201),
  `A/1=${at(1)}`,
)

/* Feedback: the resulting ON state went back out the looped line and arrived
   as input on the button's own channel -- at the widget's custom upper value,
   not plain 255. The router must READ it as a non-edge and do nothing. */
check(
  'feedback comes back at the custom upper value',
  await settle(() => inputs.some((i) => i.universe === 1 && i.channel === 5 && i.value === 200)),
  JSON.stringify(inputs.filter((i) => i.universe === 1).slice(-5)),
)
await sleep(500)
check('and the echo does not press the button again', at(1) === 201, `A/1=${at(1)}`)

/* Toggle ignores the release: the scene must survive the fall to zero. */
await drive(6, 0)
await sleep(700)
check('the release does not toggle it back', at(1) === 201, `A/1=${at(1)}`)

/* A second press stops it. */
await drive(6, 255)
check(
  'the second press toggles the scene off',
  await settle(() => at(1) === 0),
  `A/1=${at(1)}`,
)
await drive(6, 0)

/* --- Flash by wire ------------------------------------------------------- */

/* A flash button follows BOTH edges: light while the wire holds it, dark the
   moment it falls. */
const flashScene = await (await fetch(`${base}/api/v1/functions`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ type: 'Scene', name: 'Ráfaga' }),
})).json()
await fetch(`${base}/api/v1/functions/${flashScene.id}/values`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ fixture: 0, channel: 1, value: 180 }),
})
await fetch(`${base}/api/v1/vc/widgets`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({
    type: 'button',
    caption: 'Ráfaga',
    functionId: flashScene.id,
    action: 'Flash',
    input: { universe: 1, channel: 9 },
  }),
})

await drive(10, 255)
check('flash lights while held', await settle(() => at(2) === 180), `A/2=${at(2)}`)
await drive(10, 0)
check('and darkens on release', await settle(() => at(2) === 0), `A/2=${at(2)}`)

/* --- The Grand Master by wire -------------------------------------------- */

const gmBound = await fetch(`${base}/api/v1/grandmaster`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ input: { universe: 1, channel: 7 } }),
})
check('the grand master takes a binding', gmBound.ok, `${gmBound.status}`)

/* Light the scene again and RELEASE the wire -- with the button's channel
   back at zero, the grand master rescaling universe B cannot re-press it
   (post-GM wire values are exactly what the loop feeds back). Then pull the
   GM to 128 through the MAC's shutter channel, which the GM never scales:
   B address 8, input channel 7. 201 reduced by 128/255 rounds to 101 --
   the engine's applyGM is floor(x + 0.5), not a truncation. */
await drive(6, 255)
await settle(() => at(1) === 201)
await drive(6, 0)
await sleep(400)
await drive(8, 128)
check(
  'the wire moves the grand master and universe A dims',
  await settle(() => at(1) === Math.round((201 * 128) / 255)),
  `A/1=${at(1)}, gm=${(await (await fetch(`${base}/api/v1/grandmaster`)).json()).value}`,
)

const gmState = await (await fetch(`${base}/api/v1/grandmaster`)).json()
check('the grand master reports its binding', gmState.input?.universe === 1 && gmState.input?.channel === 7,
  JSON.stringify(gmState.input))

/* --- The file remembers -------------------------------------------------- */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')
check(
  "the button's binding is in the file, custom feedback included",
  /<Input Universe="1" Channel="5" UpperValue="200"\s*\/>/.test(file)
    || /<Input Universe="1" Channel="5" UpperValue="200">/.test(file),
  (file.match(/<Input[^>]*>/g) ?? []).join(' | '),
)
check(
  "the grand master's binding is in the file",
  /<GrandMaster[^>]*>[\s\S]*?<Input Universe="1" Channel="7"/.test(file),
  (file.match(/<GrandMaster[\s\S]{0,200}/) ?? ['no GrandMaster node']).join(''),
)

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
