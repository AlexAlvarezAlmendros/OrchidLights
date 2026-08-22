/**
 * F17's I/O depth, proved on the wire.
 *
 *   node io-client.mjs <base-url> <ws-url> <workdir>
 *
 *  - ONE universe drives TWO loopback lines at once, and the same frame
 *    arrives on both (read back through two input patches);
 *  - one of the two outputs can be cleared BY INDEX without touching the other;
 *  - a plugin parameter set on a patch reads back from the running plugin;
 *  - the engine's internal metronome beats at the BPM it was asked for, and
 *    doubling the tempo halves the interval;
 *  - a chaser whose tempo is Beats advances WITH the beat, not with a clock
 *    of its own;
 *  - the input profile editor writes a .qxi in the (sandboxed) user
 *    directory that the engine itself can read back.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import process from 'node:process'

const [base, wsUrl, workdir] = process.argv.slice(2)
if (!base || !wsUrl || !workdir) {
  console.error('usage: io-client.mjs <base-url> <ws-url> <workdir>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = { 'Content-Type': 'application/json' }

const inputs = []
const beats = []
const steps = []
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const message = JSON.parse(event.data)
  if (message.type === 'input') inputs.push(message)
  if (message.type === 'beat') beats.push({ at: performance.now(), bpm: message.bpm })
  if (message.type === 'functions') {
    for (const fn of message.functions ?? []) {
      if (fn.step !== undefined) steps.push({ at: performance.now(), id: fn.id, step: fn.step })
    }
  }
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

const get = (path) => fetch(`${base}/api/v1${path}`).then((r) => r.json())
const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: json, body: JSON.stringify(body) })
const patch = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })

/* --- One universe, two lines ---------------------------------------------- */

const io = await get('/io')
const loop = io.inputPlugins.find((p) => p.name === 'Loopback')
if (!loop || loop.lines.length < 2) {
  console.error('the loopback plugin is not in the tree; nothing here can be proven')
  process.exit(1)
}

await post('/universes', { name: 'EspejoA' })
await post('/universes', { name: 'EspejoB' })

const first = await patch('/universes/1', {
  output: { plugin: 'Loopback', line: loop.lines[0], index: 0 },
})
const second = await patch('/universes/1', {
  output: { plugin: 'Loopback', line: loop.lines[1], index: 1 },
})
check('a universe takes a second output', first.ok && second.ok,
  `${first.status}/${second.status}`)

await patch('/universes/2', { input: { plugin: 'Loopback', line: loop.lines[0] } })
await patch('/universes/3', { input: { plugin: 'Loopback', line: loop.lines[1] } })

const shape = (await get('/universes')).find((u) => u.id === 1)
check('and says so', shape?.outputs?.length === 2, JSON.stringify(shape?.outputs))

inputs.length = 0
await put('/simpledesk/1/channels', { values: { '5': 200 } })
await sleep(700)
const mirrorA = inputs.some((m) => m.universe === 1 && m.channel === 4 && m.value === 200)
const mirrorB = inputs.some((m) => m.universe === 2 && m.channel === 4 && m.value === 200)
check('the SAME frame leaves on both lines', mirrorA && mirrorB,
  JSON.stringify(inputs.slice(0, 6)))

/* --- Plugin knobs stick ---------------------------------------------------- */

const knobs = await put('/universes/1/parameters', {
  target: 'output', index: 0, parameters: { PruebaF17: 'valor' },
})
check('a plugin parameter is accepted', knobs.ok, `${knobs.status}`)
const dressed = (await get('/universes')).find((u) => u.id === 1)
check('and reads back from the running plugin',
  dressed?.outputs?.[0]?.parameters?.PruebaF17 === 'valor',
  JSON.stringify(dressed?.outputs?.[0]))

/* --- Clearing BY INDEX leaves the other line alone ------------------------- */

const cleared = await patch('/universes/1', { output: { plugin: '', index: 1 } })
check('one of two outputs clears by index', cleared.ok, `${cleared.status}`)
const remaining = (await get('/universes')).find((u) => u.id === 1)
check('and the other line stays patched',
  remaining?.outputs?.length === 1 && remaining.outputs[0].output === loop.lines[0],
  JSON.stringify(remaining?.outputs))

/* --- The metronome --------------------------------------------------------- */

beats.length = 0
const armed = await put('/beat', { source: 'internal', bpm: 120 })
check('the metronome arms', armed.ok, `${armed.status}`)
await sleep(2300)
const at120 = beats.map((b) => b.at)
const gaps120 = at120.slice(1).map((t, i) => t - at120[i])
const mid120 = gaps120.sort((a, b) => a - b)[Math.floor(gaps120.length / 2)] ?? 0
check('at 120 BPM the beats come every ~500 ms',
  gaps120.length >= 3 && mid120 > 420 && mid120 < 580,
  `${gaps120.length} gaps, median ${Math.round(mid120)} ms`)
check('and each one says its tempo', beats.every((b) => b.bpm === 120),
  beats.map((b) => b.bpm).join(','))

beats.length = 0
await put('/beat', { bpm: 240 })
await sleep(1500)
const at240 = beats.map((b) => b.at)
const gaps240 = at240.slice(1).map((t, i) => t - at240[i])
const mid240 = gaps240.sort((a, b) => a - b)[Math.floor(gaps240.length / 2)] ?? 0
check('doubling the tempo halves the interval',
  gaps240.length >= 4 && mid240 > 190 && mid240 < 320,
  `median ${Math.round(mid240)} ms`)

/* --- A chaser that walks on the beat --------------------------------------- */

await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 1,
})
const scene = async (name, channel) => {
  const made = await (await post('/functions', { type: 'Scene', name })).json()
  await post(`/functions/${made.id}/values`, { fixture: 0, channel, value: 200 })
  return made.id
}
const uno = await scene('BeatUno', 0)
const dos = await scene('BeatDos', 1)
const chaser = (await (await post('/functions', { type: 'Chaser', name: 'Marcha' })).json()).id
await post(`/functions/${chaser}/steps`, { function: uno })
await post(`/functions/${chaser}/steps`, { function: dos })
await patch(`/functions/${chaser}`, { duration: 500 })
/* Back to 120 BEFORE the tempo switch: Beats converts the stored times at
   the CURRENT bpm (500 ms is one beat at 120, two at 240), exactly as the
   reference does. */
await put('/beat', { bpm: 120 })
const onBeats = await patch(`/functions/${chaser}`, { tempoType: 'Beats' })
check('a chaser takes the Beats tempo', onBeats.ok, `${onBeats.status}`)

steps.length = 0
socket.send(JSON.stringify({ type: 'function', id: chaser, action: 'start' }))
await sleep(2600)
socket.send(JSON.stringify({ type: 'function', id: chaser, action: 'stop' }))
const mine = steps.filter((s) => s.id === chaser)
const changes = mine.filter((s, i) => i === 0 || s.step !== mine[i - 1].step)
const stepGaps = changes.slice(1).map((s, i) => s.at - changes[i].at)
const midStep = stepGaps.sort((a, b) => a - b)[Math.floor(stepGaps.length / 2)] ?? 0
check('and advances WITH the beat: a step every ~500 ms at 120 BPM',
  stepGaps.length >= 3 && midStep > 380 && midStep < 640,
  `${stepGaps.length} changes, median ${Math.round(midStep)} ms`)

/* --- The profile editor writes real .qxi ----------------------------------- */

const born = await post('/inputprofiles', { manufacturer: 'Orchid', model: 'TestWing' })
check('a profile is born', born.status === 201, `${born.status}`)
const filled = await put('/inputprofiles/Orchid TestWing/channels/1234', {
  name: 'Fader maestro', type: 'Slider',
})
check('and takes a channel', filled.ok, `${filled.status}`)

const readBack = await get('/inputprofiles/Orchid TestWing')
check('the profile reads back editable, channel and all',
  readBack.editable === true
    && readBack.channels?.some((c) => c.channel === 1234 && c.type === 'Slider'
      && c.name === 'Fader maestro'),
  JSON.stringify(readBack.channels))

const files = existsSync(`${workdir}/.orchidlights/inputprofiles`)
  ? readdirSync(`${workdir}/.orchidlights/inputprofiles`)
  : []
check('the .qxi lands in the (sandboxed) user directory', files.length === 1, files.join(','))
const qxi = files.length === 1
  ? readFileSync(`${workdir}/.orchidlights/inputprofiles/${files[0]}`, 'utf8')
  : ''
check('and carries the channel in QLC+\'s own XML',
  qxi.includes('<Channel Number="1234"') && qxi.includes('<Name>Fader maestro</Name>')
    && qxi.includes('<Type>Slider</Type>'),
  qxi.slice(0, 400))

const dropped = await fetch(`${base}/api/v1/inputprofiles/Orchid TestWing/channels/1234`, {
  method: 'DELETE',
})
check('a channel can be taken out again', dropped.ok, `${dropped.status}`)

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
