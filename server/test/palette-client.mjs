/**
 * Palettes, proved on the frames and in the file.
 *
 *   node palette-client.mjs <base-url> <ws-url> <save-path>
 *
 *  - a scene that carries a palette plays the palette's colour, and RETINTING
 *    THE PALETTE retints the scene's next run without the scene changing at
 *    all -- that indirection is the whole point of palettes;
 *  - fanning Linear over four bars laid left to right reads MONOTONIC on the
 *    wire, first dimmer than last;
 *  - applying a palette holds its resolved values on the live desk, where the
 *    dump can see them;
 *  - the saved .qxw carries the palette and the scene's reference to it.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, savePath] = process.argv.slice(2)
if (!base || !wsUrl || !savePath) {
  console.error('usage: palette-client.mjs <base-url> <ws-url> <save-path>')
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
const stopAndWait = async (id) => {
  await post(`/functions/${id}/stop`, {})
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = (await (await fetch(`${base}/api/v1/functions`)).json()).find((f) => f.id === id)
    if (state?.running === false) return true
    await sleep(80)
  }
  return false
}

/* --- The rig: a colour bar, and four movers left to right ---------------- */

await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 1,
})
/* Dimmer palettes resolve through a REAL dimmer channel -- an RGBW bar has
   none, which is exactly the hole the first version of this test fell into.
   The MAC500's channel 1 is Intensity. */
for (const address of [100, 120, 140, 160]) {
  await post('/fixtures', {
    manufacturer: 'Martin', model: 'MAC500', mode: 'DMX1', universe: 1, address,
  })
}
/* Fanning sorts by plan position: without one, four equal keys are whatever
   std::sort feels like. Left to right, explicitly. */
for (let i = 1; i <= 4; i++) {
  await put(`/plan/fixtures/${i}`, { x: i, y: 0 })
}

/* --- A colour palette carried by a scene --------------------------------- */

const red = await (await post('/palettes', {
  type: 'Color', name: 'Corporativo', values: ['#ff0000'],
})).json()
check('a colour palette is created', red.id !== undefined, JSON.stringify(red))

const listed = (await (await fetch(`${base}/api/v1/palettes`)).json()).palettes
check('and listed with its value',
  listed.some((p) => p.id === red.id && p.type === 'Color' && p.values[0] === '#ff0000'),
  JSON.stringify(listed))

const scene = (await (await post('/functions', { type: 'Scene', name: 'Marca' })).json()).id
const linked = await put(`/functions/${scene}/body`, { palettes: [red.id], fixtures: [0] })
check('a scene takes the palette and its fixtures', linked.ok, `${linked.status}`)

await post(`/functions/${scene}/start`, {})
check('the scene plays the palette colour', await settle(() => at(1) === 255 && at(2) === 0),
  `rgb=${at(1)},${at(2)},${at(3)}`)
await stopAndWait(scene)
await settle(() => at(1) === 0)

/* Retint THE PALETTE; the scene is not touched. */
await patch(`/palettes/${red.id}`, { values: ['#00ff00'] })
const body = await (await fetch(`${base}/api/v1/functions/${scene}/body`)).json()
check('the scene still has no values of its own',
  (body.values ?? []).length === 0 && body.palettes?.[0]?.id === red.id,
  JSON.stringify({ values: body.values, palettes: body.palettes }))

await post(`/functions/${scene}/start`, {})
check('and its next run wears the NEW colour', await settle(() => at(2) === 255 && at(1) === 0),
  `rgb=${at(1)},${at(2)},${at(3)}`)
await stopAndWait(scene)
await settle(() => at(2) === 0)

/* --- Fanning: Linear left to right is monotonic on the wire -------------- */

/* The fan runs from the palette's value toward the FANNING value: 50 at the
   left hand, climbing to 250 at the right. */
const dimmer = await (await post('/palettes', {
  type: 'Dimmer', name: 'Abanico', values: [50],
  fanning: { type: 'Linear', layout: 'XAscending', amount: 100, value: 250 },
})).json()
check('a fanned dimmer palette is created', dimmer.id !== undefined, JSON.stringify(dimmer))

const applied = await (await post(`/palettes/${dimmer.id}/apply`, {
  fixtures: [1, 2, 3, 4],
})).json()
check('applying resolves at least one value per mover', applied.applied >= 4,
  JSON.stringify(applied))

/* Each MAC's dimmer is its second channel: 101, 121, 141, 161. */
const monotonic = await settle(() => {
  const values = [at(101), at(121), at(141), at(161)]
  return values[0] > 0
    && values[0] < values[3]
    && values.every((v, i) => i === 0 || v >= values[i - 1])
})
check('the fan reads monotonic, first dimmer than last', monotonic,
  `${at(101)},${at(121)},${at(141)},${at(161)}`)

/* The dump sees what apply held. */
const dump = await (await fetch(`${base}/api/v1/dump`)).json()
check('the dump can capture the applied palette', dump.count >= 4, JSON.stringify(dump))
await fetch(`${base}/api/v1/live`, { method: 'DELETE' })

/* --- A palette in use refuses to die ------------------------------------- */

const refused = await fetch(`${base}/api/v1/palettes/${red.id}`, { method: 'DELETE' })
check('a palette a scene still carries refuses deletion', refused.status === 409,
  `${refused.status}`)

/* --- The file remembers --------------------------------------------------- */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')
check('the palette is in the file, retinted',
  /<Palette[^>]*Type="Color"[^>]*Value="#00ff00"/.test(file)
    || /<Palette[^>]*Value="#00ff00"[^>]*Type="Color"/.test(file),
  (file.match(/<Palette[^>]*>/g) ?? ['no palettes']).join(' | '))
check('the scene references it by id',
  new RegExp(`<Function[^>]*Name="Marca"[\\s\\S]{0,600}?<Palette ID="${red.id}"`).test(file),
  (file.match(/<Function[^>]*Marca[\s\S]{0,300}/) ?? ['no scene']).join('').slice(0, 200))
check('the fanning is in the file',
  /Fanning/.test(file) || /Linear/.test(file),
  (file.match(/<Palette[^>]*Dimmer[^>]*>[\s\S]{0,200}/) ?? ['no dimmer palette']).join('').slice(0, 200))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
