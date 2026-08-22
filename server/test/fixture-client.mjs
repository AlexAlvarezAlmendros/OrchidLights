/**
 * The patch at rig scale, proved in the saved file.
 *
 *   node fixture-client.mjs <base-url> <save-path>
 *
 *  - a batch of 8 with a gap lands on EXACT addresses, in the API and in the
 *    .qxw QLC+ 5 itself would load;
 *  - a clone finds its own hole: right after the original, first run that
 *    fits the whole batch;
 *  - plan properties stick per HEAD -- gel, rotation, zoom and the four
 *    flags -- and the file says which head with a Head attribute;
 *  - a group laid out as a 4x2 grid turns into a 2x4 when rotated, every
 *    head in the cell the turn says;
 *  - renaming a group works at all (it silently never did).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, savePath] = process.argv.slice(2)
if (!base || !savePath) {
  console.error('usage: fixture-client.mjs <base-url> <save-path>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const json = { 'Content-Type': 'application/json' }
const token = readFileSync(`${homedir()}/.orchidlights/api-token`, 'utf8').trim()

const get = (path) => fetch(`${base}/api/v1${path}`).then((r) => r.json())
const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const patch = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })

/* --- A batch of 8 with a gap: exact addresses ----------------------------- */

const batch = await (await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW',
  universe: 1, address: 1, quantity: 8, gap: 2,
})).json()
check('the batch of 8 is accepted', Array.isArray(batch.created) && batch.created.length === 8,
  JSON.stringify(batch))
const rgbw = batch.created ?? []

const afterBatch = await get('/fixtures')
const addressOf = (id) => afterBatch.find((f) => f.id === id)?.address
const expected = [1, 7, 13, 19, 25, 31, 37, 43]
check('the gap spreads the batch onto exact addresses',
  expected.every((address, i) => addressOf(rgbw[i]) === address),
  rgbw.map((id) => addressOf(id)).join(','))

/* --- A clone finds its own hole ------------------------------------------- */

const cloned = await (await post(`/fixtures/${rgbw[0]}/clone`, { quantity: 2 })).json()
check('two copies are made', Array.isArray(cloned.created) && cloned.created.length === 2,
  JSON.stringify(cloned))

const afterClone = await get('/fixtures')
const cloneRows = (cloned.created ?? []).map((id) => afterClone.find((f) => f.id === id))
check('the copies land right after the batch, first run that fits both',
  cloneRows[0]?.address === 47 && cloneRows[1]?.address === 51,
  cloneRows.map((f) => f?.address).join(','))
check('the copies say what they are copies of',
  cloneRows.every((f) => f?.name.includes('copia')),
  cloneRows.map((f) => f?.name).join(' | '))

/* --- Properties per head --------------------------------------------------- */

const barMade = await (await post('/fixtures', {
  manufacturer: 'Stairville', model: 'CLB4 RGB Compact LED Bar 4', mode: '14 Channel',
  universe: 1, address: 101,
})).json()
const bar = barMade.created?.[0]
const barRow = (await get('/fixtures')).find((f) => f.id === bar)
check('the bar carries four heads', barRow?.heads === 4, JSON.stringify(barRow?.heads))

const head0 = await put(`/plan/fixtures/${bar}`, {
  x: 100, y: 200, rotation: 90, gel: '#ff0000', zoom: 25, hidden: true,
})
check('head 0 takes position, gel, zoom and a flag', head0.ok, `${head0.status}`)

const head2 = await put(`/plan/fixtures/${bar}`, {
  head: 2, x: 300, y: 200, locked: true, invertTilt: true,
})
check('head 2 takes its own item', head2.ok, `${head2.status}`)

const overflow = await put(`/plan/fixtures/${bar}`, { head: 9, x: 0 })
check('a head the bar does not have is refused', overflow.status === 400, `${overflow.status}`)

const plan = await get('/plan')
const planBar = plan.fixtures.find((f) => f.id === bar)
check('the plan says head 0 whole',
  planBar?.x === 100 && planBar?.zoom === 25 && planBar?.hidden === true
    && planBar?.gel === '#ff0000' && planBar?.rotation === 90,
  JSON.stringify(planBar))
const item2 = (planBar?.headItems ?? []).find((h) => h.head === 2)
check('the plan says head 2 apart',
  item2?.x === 300 && item2?.locked === true && item2?.invertTilt === true,
  JSON.stringify(planBar?.headItems))

/* --- The group grid turns -------------------------------------------------- */

const groupMade = await (await post('/fixture-groups', { name: 'Muro', fixtures: [] })).json()
const group = groupMade.id

const grid = await patch(`/fixture-groups/${group}`, {
  size: { width: 4, height: 2 },
  cells: rgbw.map((fixture, i) => ({ x: i % 4, y: Math.floor(i / 4), fixture, head: 0 })),
})
check('the group takes a 4x2 grid', grid.ok, `${grid.status}`)

const badCell = await patch(`/fixture-groups/${group}`, {
  size: { width: 2, height: 2 },
  cells: [{ x: 5, y: 0, fixture: rgbw[0], head: 0 }],
})
check('a cell outside the grid is refused whole', badCell.status === 400, `${badCell.status}`)

const turned = await post(`/fixture-groups/${group}/transform`, { op: 'rotate90' })
check('the grid rotates', turned.ok, `${turned.status}`)

const groups = await get('/fixture-groups')
const wall = groups.find((g) => g.id === group)
check('a quarter turn swaps the size', wall?.size.width === 2 && wall?.size.height === 4,
  JSON.stringify(wall?.size))
const cellOf = (fixture) => wall?.cells.find((c) => c.fixture === fixture)
check('the corner travels with the turn',
  cellOf(rgbw[0])?.x === 1 && cellOf(rgbw[0])?.y === 0
    && cellOf(rgbw[4])?.x === 0 && cellOf(rgbw[4])?.y === 0
    && cellOf(rgbw[7])?.x === 0 && cellOf(rgbw[7])?.y === 3,
  JSON.stringify(wall?.cells))

const renamed = await patch(`/fixture-groups/${group}`, { name: 'Muro girado' })
check('the group takes a new name', renamed.ok, `${renamed.status}`)
const named = (await get('/fixture-groups')).find((g) => g.id === group)
check('and keeps it', named?.name === 'Muro girado', JSON.stringify(named?.name))

/* --- Physical data for the rigger's summary -------------------------------- */

check('the fixture says what it weighs and draws',
  typeof barRow?.physical?.weight === 'number' && typeof barRow?.physical?.power === 'number',
  JSON.stringify(barRow?.physical))

/* --- The file agrees -------------------------------------------------------- */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')

/* Addresses are 0-based in the file, exactly as QLC+ writes them. */
const fileAddresses = [...file.matchAll(/<Address>(\d+)<\/Address>/g)].map((m) => Number(m[1]))
const wanted = [0, 6, 12, 18, 24, 30, 36, 42, 46, 50, 100]
check('the file carries every address the gap arithmetic promised',
  wanted.every((a) => fileAddresses.includes(a)), fileAddresses.join(','))

const fxItems = file.match(/<FxItem[^>]*>/g) ?? []
const barItems = fxItems.filter((s) => s.includes(`ID="${bar}"`))
const head0Item = barItems.find((s) => !s.includes('Head='))
const head2Item = barItems.find((s) => s.includes('Head="2"'))
check('head 0 of the bar is in the file with gel, zoom, rotation and Hidden',
  head0Item !== undefined && head0Item.includes('Hidden="True"')
    && head0Item.includes('FixedZoom="25"') && head0Item.includes('GelColor="#ff0000"')
    && head0Item.includes('Rotation="90"'),
  head0Item ?? barItems.join(' | '))
check('head 2 of the bar is its own FxItem, locked and tilt-inverted',
  head2Item !== undefined && head2Item.includes('Locked="True"')
    && head2Item.includes('InvertedTilt="True"'),
  head2Item ?? barItems.join(' | '))

check('the turned grid is in the file', /<Size X="2" Y="4"\/>/.test(file),
  (file.match(/<Size[^>]*>/g) ?? ['no Size']).join(' | '))
check('the corner head is in its turned cell',
  new RegExp(`<Head X="1" Y="0" Fixture="${rgbw[0]}">0</Head>`).test(file),
  (file.match(/<Head X[^<]*</g) ?? ['no Head']).slice(0, 4).join(' | '))

process.exit(failures.length === 0 ? 0 : 1)
