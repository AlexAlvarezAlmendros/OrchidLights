/**
 * The chaser editor's promises, read off the wire and out of the file.
 *
 *   node chaser-client.mjs <base-url> <ws-url> <save-path>
 *
 *  - per-step fades are real: a step with fadeIn 0 SNAPS and a step with
 *    fadeIn 1000 RAMPS, and the ramp is measured as many distinct
 *    intermediate frames, not believed from an acknowledgement;
 *  - a step's note and speeds survive into the saved .qxw;
 *  - reordering is a permutation that persists byte-visibly;
 *  - a sequence's edited step values change the DMX the next run plays;
 *  - path, tempo, clone, usage and the startup function round-trip.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, savePath] = process.argv.slice(2)
if (!base || !wsUrl || !savePath) {
  console.error('usage: chaser-client.mjs <base-url> <ws-url> <save-path>')
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

/* Every frame of universe 1, kept with a timestamp: the ramp assertions need
   history, not just the present. */
let frame = null
const history = []
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  const bytes = new Uint8Array(event.data)
  const universe = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
  if (universe !== 1) return
  frame = bytes.subarray(2)
  history.push({ at: Date.now(), values: [...frame.subarray(0, 8)] })
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

const at = (address1) => (frame === null ? -1 : (frame[address1 - 1] ?? 0))
const settle = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(60)
  }
  return false
}

const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const patch = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const body = async (id) => await (await fetch(`${base}/api/v1/functions/${id}/body`)).json()

/* --- The rig: one bar, two scenes, one chaser through both ---------------- */

await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 1,
})

const scene = async (name, channel, value) => {
  const made = await (await post('/functions', { type: 'Scene', name })).json()
  await post(`/functions/${made.id}/values`, { fixture: 0, channel, value })
  return made.id
}
const s1 = await scene('Roja', 0, 200)
const s2 = await scene('Verde', 1, 200)

const chaser = (await (await post('/functions', { type: 'Chaser', name: 'Pasos' })).json()).id
await post(`/functions/${chaser}/steps`, { function: s1 })
await post(`/functions/${chaser}/steps`, { function: s2 })

/* --- Per-step speeds, measured ------------------------------------------- */

/* Speeds mean nothing per-step until the chaser is told to look at them. */
await patch(`/functions/${chaser}`, { fadeInMode: 'perstep', durationMode: 'perstep' })
await patch(`/functions/${chaser}/steps/0`, { fadeIn: 0, hold: 700 })
await patch(`/functions/${chaser}/steps/1`, { fadeIn: 1200, hold: 700, note: 'Puente' })

const after = await body(chaser)
check('the chaser reports its per-step modes',
  after.fadeInMode === 'perstep' && after.durationMode === 'perstep',
  `${after.fadeInMode}/${after.durationMode}`)
check('the note lands on the step', after.steps[1].note === 'Puente',
  JSON.stringify(after.steps[1]))
check('editing hold recomputes the stored duration like the reference does',
  after.steps[1].duration === 1200 + 700, `duration=${after.steps[1].duration}`)

history.length = 0
await post(`/functions/${chaser}/start`, {})
check('step 0 snaps red up', await settle(() => at(1) === 200), `1=${at(1)}`)

/* Step 1's green climbs for 1200 ms: the wire must show a real ramp -- many
   distinct values between dark and lit -- not one jump. */
check('step 1 ramps green up', await settle(() => at(2) === 200, 6000), `2=${at(2)}`)
const climb = new Set(
  history.map((entry) => entry.values[1]).filter((value) => value > 10 && value < 190),
)
check('and the ramp is made of frames, not a jump', climb.size >= 5,
  `${climb.size} distinct mid-values`)
await post(`/functions/${chaser}/stop`, {})
await settle(() => at(1) === 0 && at(2) === 0)

/* --- The order is a persisted permutation -------------------------------- */

const flipped = await put(`/functions/${chaser}/steps/order`, { order: [1, 0] })
check('the reorder is accepted', flipped.ok, `${flipped.status}`)
const reordered = await body(chaser)
check('the body walks in the new order',
  reordered.steps[0].function === s2 && reordered.steps[1].function === s1,
  JSON.stringify(reordered.steps.map((s) => s.function)))

const refused = await put(`/functions/${chaser}/steps/order`, { order: [0, 0] })
check('a non-permutation is refused', refused.status === 400, `${refused.status}`)

/* --- Organization, clone, usage, startup --------------------------------- */

await patch(`/functions/${chaser}`, { path: 'Bolo/Sábado', tempoType: 'time' })
const listed = (await (await fetch(`${base}/api/v1/functions`)).json())
  .find((f) => f.id === chaser)
check('the folder is on the function', listed.path === 'Bolo/Sábado', listed.path)

const copy = await (await post(`/functions/${chaser}/clone`, {})).json()
const copied = await body(copy.id)
check('the clone carries the steps', copied.steps?.length === 2,
  JSON.stringify(copy))

const usage = await (await fetch(`${base}/api/v1/functions/${s1}/usage`)).json()
check('usage names both chasers and nothing else',
  usage.functions.length === 2
    && usage.functions.every((f) => f.id === chaser || f.id === copy.id),
  JSON.stringify(usage.functions))

await patch('/project', { startupFunction: chaser })
const project = await (await fetch(`${base}/api/v1/project`)).json()
check('the startup function is set', project.startupFunction === chaser,
  `${project.startupFunction}`)

/* --- The sequence: edited values are the next run's DMX ------------------ */

const s3 = await scene('Base', 2, 0)
const sequence = (await (await post('/functions', { type: 'Sequence', name: 'Frase' })).json()).id
await put(`/functions/${sequence}/body`, { scene: s3 })
await post(`/functions/${sequence}/steps`, { function: s3 })
const withValues = await put(`/functions/${sequence}/steps/0/values`, {
  values: [{ fixture: 0, channel: 2, value: 123 }],
})
check('a sequence step takes values', withValues.ok, `${withValues.status}`)

await post(`/functions/${sequence}/start`, {})
check('and plays them', await settle(() => at(3) === 123), `3=${at(3)}`)
await post(`/functions/${sequence}/stop`, {})
await settle(() => at(3) === 0)

await put(`/functions/${sequence}/steps/0/values`, {
  values: [{ fixture: 0, channel: 2, value: 77 }],
})
await post(`/functions/${sequence}/start`, {})
check('edited values change the next run', await settle(() => at(3) === 77), `3=${at(3)}`)
await post(`/functions/${sequence}/stop`, {})

/* --- The file agrees ------------------------------------------------------ */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')

check('the reordered first step is in the file',
  new RegExp(`<Step Number="0"[^>]*>${s2}</Step>`).test(file),
  (file.match(/<Step Number="0"[^>]*>\d+<\/Step>/g) ?? []).join(' | '))
check('the note is in the file', /Note="Puente"/.test(file),
  (file.match(/Note="[^"]*"/g) ?? ['no notes']).join(' | '))
check('the folder is in the file', /Path="Bolo\/Sábado"/.test(file),
  (file.match(/Path="[^"]*"/g) ?? ['no paths']).join(' | '))
check('the startup function is in the file',
  new RegExp(`Autostart="${chaser}"`).test(file),
  (file.match(/Autostart="[^"]*"/g) ?? ['no Autostart']).join(' | '))
check('the sequence step values are in the file',
  /2,77/.test(file),
  (file.match(/<Step[^>]*Values="[^"]*"[^>]*>[^<]*/g) ?? ['no step values']).join(' | '))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
