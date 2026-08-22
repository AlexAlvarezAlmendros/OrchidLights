/**
 * F19's global undo, proved on the wire.
 *
 *   node undo-client.mjs <base-url> <ws-url>
 *
 *  - an edited scene reverts to its stored body, and a DIFFERENT function
 *    running on another universe never blinks while it happens (the whole
 *    point of entity-sized snapshots over document reloads);
 *  - a deleted fixture comes back with its id, its address AND its place on
 *    the plan;
 *  - creation undoes to absence and redoes to existence;
 *  - a console widget created over the API disappears with the same global
 *    undo (the marker delegates to the VC's own history);
 *  - two rapid plan moves coalesce into ONE entry (a drag is one gesture);
 *  - the live desk is NOT in the ring.
 */

import process from 'node:process'

const [base, wsUrl] = process.argv.slice(2)
if (!base || !wsUrl) {
  console.error('usage: undo-client.mjs <base-url> <ws-url>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = { 'Content-Type': 'application/json' }

let frame2 = null
let sawDip = false
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  const bytes = new Uint8Array(event.data)
  const universe = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
  if (universe === 2) {
    frame2 = bytes.subarray(2)
    if (frame2[0] !== 200 && watching) sawDip = true
  }
})
let watching = false
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [2] }))

const get = (path) => fetch(`${base}/api/v1${path}`).then((r) => r.json())
const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const patch = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const undo = () => post('/undo', {})
const redo = () => post('/redo', {})

/* --- The rig: one lamp per universe ---------------------------------------- */

await post('/universes', { name: 'Guardia' })
await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', name: 'Editada',
  universe: 1, address: 1,
})
await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', name: 'Guardiana',
  universe: 2, address: 1,
})

const scene = async (name, fixture, channel, value) => {
  const made = await (await post('/functions', { type: 'Scene', name })).json()
  await post(`/functions/${made.id}/values`, { fixture, channel, value })
  return made.id
}
const edited = await scene('Retocada', 0, 0, 100)
const guardian = await scene('EnMarcha', 1, 0, 200)

/* The guard: running on universe 2 for the WHOLE test. Any frame where its
   channel is not 200 is a cut that undo caused. */
socket.send(JSON.stringify({ type: 'function', id: guardian, action: 'start' }))
await sleep(500)
check('the guard scene burns on universe 2', frame2?.[0] === 200, `${frame2?.[0]}`)
watching = true

/* --- An edit reverts; the guard never blinks -------------------------------- */

await post(`/functions/${edited}/values`, { fixture: 0, channel: 0, value: 250 })
let body = await get(`/functions/${edited}/body`)
check('the edit landed', body.values?.[0]?.value === 250, JSON.stringify(body.values))

const undone = await (await undo()).json()
check('undo answers with what it undid', undone.undone !== undefined, JSON.stringify(undone))
body = await get(`/functions/${edited}/body`)
check('the scene reverted to its stored body', body.values?.[0]?.value === 100,
  JSON.stringify(body.values))

const redone = await (await redo()).json()
check('redo brings the edit back', redone.redone !== undefined
  && (await get(`/functions/${edited}/body`)).values?.[0]?.value === 250,
  JSON.stringify(redone))

/* --- A deleted fixture comes back whole ------------------------------------- */

await put('/plan/fixtures/0', { x: 1234, y: 2345, gel: '#00ff00' })
await fetch(`${base}/api/v1/fixtures/0`, { method: 'DELETE' })
check('the fixture is gone', (await get('/fixtures')).every((f) => f.id !== 0))

/* Two entries: placing it on the plan, then deleting it. One undo. */
const backAnswer = await (await undo()).json()
const fixtures = await get('/fixtures')
const restored = fixtures.find((f) => f.id === 0)
check('undo restores the fixture with its id and address',
  restored?.address === 1 && restored?.name === 'Editada', JSON.stringify(restored))
const plan = await get('/plan')
const placed = plan.fixtures.find((f) => f.id === 0)
check('and its place on the plan comes back with it',
  placed?.x === 1234 && placed?.y === 2345 && placed?.gel === '#00ff00',
  JSON.stringify([placed?.x, placed?.y, placed?.gel, backAnswer.undone]))

/* --- Creation undoes to absence --------------------------------------------- */

const born = await (await post('/functions', { type: 'Scene', name: 'Efimera' })).json()
await undo()
check('undoing a creation removes it',
  (await get('/functions')).every((f) => f.id !== born.id))
await redo()
check('redoing brings it back by the same id',
  (await get('/functions')).some((f) => f.id === born.id && f.name === 'Efimera'))
await fetch(`${base}/api/v1/functions/${born.id}?force=true`, { method: 'DELETE' })
await undo()
check('and undoing THAT delete resurrects it once more',
  (await get('/functions')).some((f) => f.id === born.id))
await redo()

/* --- The console rides along as markers ------------------------------------- */

const widget = await (await post('/vc/widgets', { type: 'button', caption: 'Fugaz' })).json()
const walk = (w) => [w, ...(w.children ?? []).flatMap(walk)]
check('the widget exists', walk(await get('/vc')).some((w) => w.id === Number(widget.id)))
const consoleUndo = await (await undo()).json()
check('global undo reaches the console through the marker',
  consoleUndo.undone === 'console: crear widget'
    && walk(await get('/vc')).every((w) => w.id !== Number(widget.id)),
  JSON.stringify(consoleUndo))

/* --- A drag coalesces -------------------------------------------------------- */

const entriesBefore = (await get('/history')).entries.length
await put('/plan/fixtures/1', { x: 100, y: 100 })
await put('/plan/fixtures/1', { x: 140, y: 100 })
await put('/plan/fixtures/1', { x: 180, y: 100 })
const entriesAfter = (await get('/history')).entries.length
check('three rapid moves coalesce into one entry', entriesAfter === entriesBefore + 1,
  `${entriesBefore} -> ${entriesAfter}`)
const dragUndone = await (await undo()).json()
const planNow = await get('/plan')
check('and one undo takes the lamp back to BEFORE the gesture',
  planNow.fixtures.find((f) => f.id === 1)?.x === undefined
    || planNow.fixtures.find((f) => f.id === 1)?.x !== 180,
  JSON.stringify([planNow.fixtures.find((f) => f.id === 1)?.x, dragUndone.undone]))

/* --- The live desk is not an edit -------------------------------------------- */

const ringBefore = (await get('/history')).entries.length
await put('/live', { values: [{ fixture: 1, channel: 1, value: 99 }] })
await fetch(`${base}/api/v1/live`, { method: 'DELETE' })
check('the live desk leaves no ring entries',
  (await get('/history')).entries.length === ringBefore)

/* --- The guard never blinked ------------------------------------------------- */

watching = false
check('the guard scene NEVER blinked through any of it', sawDip === false
  && frame2?.[0] === 200, `dip=${sawDip} now=${frame2?.[0]}`)
socket.send(JSON.stringify({ type: 'function', id: guardian, action: 'stop' }))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
