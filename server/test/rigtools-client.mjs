/**
 * F15b's rig tools, proved on the wire and in the file.
 *
 *   node rigtools-client.mjs <base-url> <ws-url> <workdir>
 *
 *  - the RGB panel wizard builds one fixture per row and a group whose snake
 *    doubles back exactly where the reference's arithmetic says;
 *  - a remap carries the show across: a scene lit red before the swap lights
 *    the NEW address after it, through channels matched semantically (red on
 *    channel 0 becomes red on channel 2 of a BGR lamp), and a console slider
 *    holding that channel follows;
 *  - a linked lamp is drawn twice on the plan and lands in the file with its
 *    Linked attribute;
 *  - selective import from another .qxw brings fixtures and a chosen scene
 *    across with ids remapped, reuses by name instead of duplicating, and the
 *    imported scene LIGHTS.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, workdir] = process.argv.slice(2)
if (!base || !wsUrl || !workdir) {
  console.error('usage: rigtools-client.mjs <base-url> <ws-url> <workdir>')
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
const authed = { ...json, Authorization: `Bearer ${token}` }

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

const get = (path) => fetch(`${base}/api/v1${path}`).then((r) => r.json())
const post = (path, body, headers = json) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })

/* --- The RGB panel wizard -------------------------------------------------- */

const panel = await (await post('/fixtures/rgbpanel', {
  name: 'Muro LED', universe: 1, address: 1, rows: 2, columns: 3,
  components: 'RGB', displacement: 'snake', startCorner: 'topleft', direction: 'horizontal',
})).json()
check('the wizard builds one fixture per row', panel.created?.length === 2, JSON.stringify(panel))

const fixtures = await get('/fixtures')
const rowOf = (i) => fixtures.find((f) => f.id === panel.created[i])
check('rows are 9 channels each, back to back',
  rowOf(0)?.channels === 9 && rowOf(0)?.address === 1
    && rowOf(1)?.channels === 9 && rowOf(1)?.address === 10,
  JSON.stringify([rowOf(0)?.address, rowOf(1)?.address]))
check('each row carries three heads', rowOf(0)?.heads === 3, JSON.stringify(rowOf(0)?.heads))

const wall = (await get('/fixture-groups')).find((g) => g.id === panel.group)
const cellAt = (x, y) => wall?.cells.find((c) => c.x === x && c.y === y)
check('the panel group is 3x2', wall?.size.width === 3 && wall?.size.height === 2,
  JSON.stringify(wall?.size))
check('the snake doubles back on the second row',
  cellAt(0, 0)?.fixture === panel.created[0] && cellAt(0, 0)?.head === 0
    && cellAt(2, 1)?.fixture === panel.created[1] && cellAt(2, 1)?.head === 0
    && cellAt(0, 1)?.fixture === panel.created[1] && cellAt(0, 1)?.head === 2,
  JSON.stringify(wall?.cells))

/* --- The remap carries the show across ------------------------------------- */

const lampMade = await (await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', name: 'Foco',
  universe: 1, address: 101,
})).json()
const lamp = lampMade.created?.[0]

const scene = await (await post('/functions', { type: 'Scene', name: 'Rojo' })).json()
await post(`/functions/${scene.id}/values`, { fixture: lamp, channel: 0, value: 200 })

const slider = await (await post('/vc/widgets', {
  type: 'slider', caption: 'RojoFader',
})).json()
await fetch(`${base}/api/v1/vc/widgets/${slider.id}`, {
  method: 'PATCH', headers: json,
  body: JSON.stringify({ levelChannels: [{ fixture: lamp, channel: 0 }] }),
})

await put(`/plan/fixtures/${lamp}`, { x: 1500, y: 2500 })

socket.send(JSON.stringify({ type: 'function', id: scene.id, action: 'start' }))
check('the scene lights red on channel 0 of the old lamp', await settle(() => at(101) === 200),
  `101=${at(101)}`)
socket.send(JSON.stringify({ type: 'function', id: scene.id, action: 'stop' }))
await settle(() => at(101) === 0)

const remap = await (await post(`/fixtures/${lamp}/remap`, {
  manufacturer: 'Generic', model: 'Generic RGB', mode: 'BGR', address: 201,
})).json()
check('the remap answers with what it carried',
  remap.channelsCarried >= 3 && remap.slidersTouched === 1, JSON.stringify(remap))
check('the lamp keeps its id and wears the new definition',
  remap.fixture?.id === lamp && remap.fixture?.model === 'Generic RGB'
    && remap.fixture?.address === 201,
  JSON.stringify(remap.fixture))

socket.send(JSON.stringify({ type: 'function', id: scene.id, action: 'start' }))
check('the same scene lights the NEW address, red matched onto channel 2',
  await settle(() => at(203) === 200 && at(201) === 0), `201=${at(201)} 203=${at(203)}`)
socket.send(JSON.stringify({ type: 'function', id: scene.id, action: 'stop' }))
await settle(() => at(203) === 0)

const walk = (w) => [w, ...(w.children ?? []).flatMap(walk)]
const console_ = await get('/vc')
const sliderNow = walk(console_).find((w) => w.id === Number(slider.id))
check('the console slider follows the remap',
  sliderNow?.levelChannels?.length === 1 && sliderNow.levelChannels[0].channel === 2,
  JSON.stringify(sliderNow?.levelChannels))

const planNow = await get('/plan')
const lampPlan = planNow.fixtures.find((f) => f.id === lamp)
check('the plan position survives the remap', lampPlan?.x === 1500 && lampPlan?.y === 2500,
  JSON.stringify([lampPlan?.x, lampPlan?.y]))

/* --- A linked lamp --------------------------------------------------------- */

const linked = await (await post(`/plan/fixtures/${lamp}/linked`, { x: 4000, y: 2500 })).json()
check('a linked lamp is born', linked.linked === 1, JSON.stringify(linked))
const planLinked = (await get('/plan')).fixtures.find((f) => f.id === lamp)
check('the plan draws it apart',
  planLinked?.linkedItems?.length === 1 && planLinked.linkedItems[0].x === 4000,
  JSON.stringify(planLinked?.linkedItems))

/* --- The file agrees, and becomes the donor -------------------------------- */

const donor = `${workdir}/donante.qxw`
const saved = await post('/project/save-as', { path: donor }, authed)
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(donor, 'utf8')

check('the snake is in the file',
  new RegExp(`<Head X="0" Y="1" Fixture="${panel.created[1]}">2</Head>`).test(file),
  (file.match(/<Head X[^<]*</g) ?? ['none']).slice(0, 8).join(' | '))
check('the remapped lamp is in the file at its new address',
  /<Address>200<\/Address>/.test(file),
  (file.match(/<Address>\d+/g) ?? []).join(','))
check('the linked lamp is in the file',
  new RegExp(`<FxItem ID="${lamp}" Linked="1"`).test(file),
  (file.match(/<FxItem[^>]*Linked[^>]*>/g) ?? ['none']).join(' | '))

const unlinked = await fetch(`${base}/api/v1/plan/fixtures/${lamp}/linked/1`, { method: 'DELETE' })
check('the linked lamp can be taken down', unlinked.ok, `${unlinked.status}`)

/* --- Selective import ------------------------------------------------------ */

const cleared = await post('/project/new', {}, authed)
check('a fresh project opens', cleared.ok, `${cleared.status}`)
await sleep(400)
check('and it is empty', (await get('/fixtures')).length === 0, 'fixtures remain')

const preview = await (await post('/project/import/preview', { path: donor }, authed)).json()
check('the preview lists the donor rig',
  preview.fixtures?.length === 3 && preview.functions?.some((f) => f.name === 'Rojo'),
  JSON.stringify({ f: preview.fixtures?.length, fn: preview.functions?.length }))

const sceneEntry = preview.functions.find((f) => f.name === 'Rojo')
const report = await (await post('/project/import', {
  path: donor, fixtures: 'all', functions: [sceneEntry.id],
}, authed)).json()
check('the import lands fixtures and the chosen scene',
  report.fixturesCreated === 3 && report.functionsCreated === 1 && report.groupsCreated === 1,
  JSON.stringify(report))

const imported = await get('/fixtures')
const focoNow = imported.find((f) => f.name === 'Foco')
check('the lamp keeps its address when it is free', focoNow?.address === 201,
  JSON.stringify(focoNow?.address))

const sceneNow = (await get('/functions')).find((f) => f.name === 'Rojo')
socket.send(JSON.stringify({ type: 'function', id: sceneNow.id, action: 'start' }))
check('the imported scene LIGHTS through the remapped fixture',
  await settle(() => at(203) === 200), `203=${at(203)}`)
socket.send(JSON.stringify({ type: 'function', id: sceneNow.id, action: 'stop' }))

const again = await (await post('/project/import', {
  path: donor, fixtures: 'all',
}, authed)).json()
check('importing again reuses by name instead of duplicating',
  again.fixturesCreated === 0 && again.fixturesReused === 3, JSON.stringify(again))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
