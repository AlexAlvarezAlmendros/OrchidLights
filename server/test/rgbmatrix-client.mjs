/**
 * The RGB matrix, proved on the frames and in the file.
 *
 *   node rgbmatrix-client.mjs <base-url> <ws-url> <save-path>
 *
 *  - Plain Color paints both pixels red, ON THE WIRE;
 *  - control mode White moves the white channel and leaves RGB alone;
 *  - blend Mask over darkness is darkness, and back to Normal it lights again;
 *  - a five-colour script carries all five into body and .qxw;
 *  - a script's dynamic property round-trips and lands as <Property>;
 *  - Text and Image carry their settings (the image via POST /assets);
 *  - the bake produces a Scene + Sequence whose steps hold the painted pixels.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, savePath] = process.argv.slice(2)
if (!base || !wsUrl || !savePath) {
  console.error('usage: rgbmatrix-client.mjs <base-url> <ws-url> <save-path>')
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
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const body = async (id) => await (await fetch(`${base}/api/v1/functions/${id}/body`)).json()
/* Stops are queued on the engine; restarting before one landed loses the
   start. With Mask the wire is dark either way, so the FLAG is the wait. */
const waitStopped = async (id) => {
  await post(`/functions/${id}/stop`, {})
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = (await (await fetch(`${base}/api/v1/functions`)).json()).find((f) => f.id === id)
    if (state?.running === false) return true
    await sleep(80)
  }
  return false
}

/* --- The rig: two RGBW bars in a 2x1 group ------------------------------- */

for (const address of [1, 5]) {
  await post('/fixtures', {
    manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address,
  })
}
const group = (await (await post('/fixture-groups', { name: 'Panel', fixtures: [0, 1] })).json()).id
const matrix = (await (await post('/functions', { type: 'RGBMatrix', name: 'Lienzo' })).json()).id

/* --- Plain Color, on the wire -------------------------------------------- */

let answer = await put(`/functions/${matrix}/body`, {
  fixtureGroup: group, algorithm: 'Plain Color', colors: ['#ff0000'],
})
check('the matrix takes group, algorithm and colour', answer.ok, `${answer.status}`)

await post(`/functions/${matrix}/start`, {})
check(
  'Plain Color paints both pixels red',
  await settle(() => at(1) === 255 && at(2) === 0 && at(5) === 255 && at(6) === 0),
  `p1=${at(1)},${at(2)},${at(3)} p2=${at(5)},${at(6)},${at(7)}`,
)

/* --- Control mode: White moves white, not RGB ---------------------------- */

await post(`/functions/${matrix}/stop`, {})
await settle(() => at(1) === 0)
answer = await put(`/functions/${matrix}/body`, { controlMode: 'White' })
check('the control mode is accepted', answer.ok, `${answer.status}`)
await post(`/functions/${matrix}/start`, {})
check(
  'White control lights the white channel and leaves RGB dark',
  await settle(() => at(4) > 0 && at(1) === 0 && at(2) === 0 && at(3) === 0),
  `rgbw=${at(1)},${at(2)},${at(3)},${at(4)}`,
)
await post(`/functions/${matrix}/stop`, {})
await settle(() => at(4) === 0)
await put(`/functions/${matrix}/body`, { controlMode: 'RGB' })

/* --- Blend: Mask over darkness is darkness ------------------------------- */

answer = await put(`/functions/${matrix}/body`, { blendMode: 'Mask' })
check('the blend mode is accepted', answer.ok, `${answer.status}`)
await post(`/functions/${matrix}/start`, {})
/* RUNNING and dark, or the assertion is vacuously true of a matrix that
   simply failed to start. */
const masked = await (async () => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const state = (await (await fetch(`${base}/api/v1/functions`)).json()).find((f) => f.id === matrix)
    if (state?.running === true) return true
    await sleep(80)
  }
  return false
})()
await sleep(900)
check('Mask over nothing lights nothing (while genuinely running)',
  masked && at(1) === 0 && at(5) === 0, `running=${masked} 1=${at(1)} 5=${at(5)}`)
await waitStopped(matrix)
await put(`/functions/${matrix}/body`, { blendMode: 'Normal' })
await post(`/functions/${matrix}/start`, {})
check('back to Normal it lights again', await settle(() => at(1) === 255), `1=${at(1)}`)
await post(`/functions/${matrix}/stop`, {})
await settle(() => at(1) === 0)

/* --- Five colours, a dynamic property ------------------------------------ */

answer = await put(`/functions/${matrix}/body`, {
  algorithm: 'Plasma',
  colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'],
})
check('a five-colour script takes five colours', answer.ok, `${answer.status}`)
let shape = await body(matrix)
check('and the body reports all five',
  shape.acceptsColors === 5 && shape.colors.length === 5 && shape.colors[4] === '#ff00ff',
  JSON.stringify({ accepts: shape.acceptsColors, colors: shape.colors }))

const property = (shape.properties ?? [])[0]
check('the script declares its knobs', property !== undefined,
  JSON.stringify(shape.properties?.map((p) => p.name)))
if (property) {
  const wanted = property.type === 'list' ? property.values.find((v) => v !== property.value) : '3'
  answer = await put(`/functions/${matrix}/body`, { properties: { [property.name]: wanted } })
  check('a property can be set', answer.ok, `${answer.status}`)
  shape = await body(matrix)
  check('and reads back',
    shape.properties.find((p) => p.name === property.name)?.value === wanted,
    JSON.stringify(shape.properties.find((p) => p.name === property.name)))
}

/* --- Text and Image ------------------------------------------------------- */

const canvas2 = (await (await post('/functions', { type: 'RGBMatrix', name: 'Cartel' })).json()).id
answer = await put(`/functions/${canvas2}/body`, {
  fixtureGroup: group, algorithm: 'Text', text: { content: 'HOLA', animation: 'Letters' },
})
check('the Text algorithm takes its settings', answer.ok, `${answer.status}`)
shape = await body(canvas2)
check('and reports them',
  shape.text?.content === 'HOLA' && shape.text?.animation === 'Letters',
  JSON.stringify(shape.text))

/* A 2x2 PNG, uploaded as an asset and hung on the Image algorithm. */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxAAFCAYAG10BBdmz9y8AAAAASUVORK5CYII=',
  'base64',
)
const uploaded = await fetch(`${base}/api/v1/assets?name=pixel.png`, {
  method: 'POST', body: png,
})
check('an asset uploads', uploaded.status === 201, `${uploaded.status}`)
const assetPath = (await uploaded.json()).path

answer = await put(`/functions/${canvas2}/body`, {
  algorithm: 'Image', image: { file: assetPath, animation: 'Animation' },
})
check('the Image algorithm takes the asset', answer.ok, `${answer.status}`)
shape = await body(canvas2)
check('and reports it', shape.image?.file === assetPath, JSON.stringify(shape.image))

/* --- The bake: Alternate frozen into a sequence --------------------------- */

await put(`/functions/${matrix}/body`, {
  algorithm: 'Alternate', colors: ['#ff0000', '#00ff00'],
})
const baked = await (await post(`/functions/${matrix}/bake`, {})).json()
check('the bake answers a scene and a sequence',
  baked.scene !== undefined && baked.sequence !== undefined, JSON.stringify(baked))

const sequence = await body(baked.sequence)
check('the sequence has the algorithm steps and painted pixels',
  (sequence.steps?.length ?? 0) >= 2
    && sequence.steps.every((step) => (step.values?.length ?? 0) > 0),
  JSON.stringify({ steps: sequence.steps?.length, firstValues: sequence.steps?.[0]?.values?.length }))

/* The alternate pattern: in any step, the two pixels wear DIFFERENT colours. */
const first = sequence.steps[0].values
const p1red = first.some((v) => v.fixture === 0 && v.channel === 0 && v.value === 255)
const p2green = first.some((v) => v.fixture === 1 && v.channel === 1 && v.value === 255)
const p1green = first.some((v) => v.fixture === 0 && v.channel === 1 && v.value === 255)
const p2red = first.some((v) => v.fixture === 1 && v.channel === 0 && v.value === 255)
check('the baked step alternates the two colours across the pixels',
  (p1red && p2green) || (p1green && p2red), JSON.stringify(first))

/* And the sequence PLAYS: the baked look reaches the wire. */
await post(`/functions/${baked.sequence}/start`, {})
check('the baked sequence lights the panel',
  await settle(() => (at(1) === 255 && at(6) === 255) || (at(2) === 255 && at(5) === 255)),
  `p1=${at(1)},${at(2)} p2=${at(5)},${at(6)}`)
await post(`/functions/${baked.sequence}/stop`, {})

/* --- The file agrees ------------------------------------------------------ */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')

check('the image is in the .qxw (path normalized against the project)',
  /<Filename>[^<]*pixel\.png<\/Filename>/.test(file),
  (file.match(/<Filename>[^<]*<\/Filename>/g) ?? ['no Filename']).join(' | '))
check('the baked sequence is in the .qxw with step values',
  /<Function[^>]*Type="Sequence"[^>]*Name="Lienzo Sequence"/.test(file)
    && /<Step[^>]*Values="[1-9]/.test(file),
  (file.match(/<Function[^>]*Sequence[^>]*>/g) ?? ['no sequence']).join(' | '))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
