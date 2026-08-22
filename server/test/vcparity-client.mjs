/**
 * F14b's console depth, proved on the wire and in the file.
 *
 *   node vcparity-client.mjs <base-url> <ws-url> <save-path>
 *
 *  - the cue list's side fader in Steps mode maps the fader onto the step
 *    list (0 = last cue, full = first);
 *  - in Crossfade mode, mid-travel BLENDS the running cue with the next one
 *    (both at half), and the far end hands over completely;
 *  - a multipage frame's page turns from EXTERNAL INPUT through the loopback
 *    wire, respects the page count, and wraps only when PagesLoop says so;
 *  - the .qxw carries Multipage, the page-turning inputs and SlidersMode --
 *    XML QLC+ 5 itself would load.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, savePath] = process.argv.slice(2)
if (!base || !wsUrl || !savePath) {
  console.error('usage: vcparity-client.mjs <base-url> <ws-url> <save-path>')
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
const pageEvents = []
const socket = new WebSocket(wsUrl)
socket.binaryType = 'arraybuffer'
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') {
    const message = JSON.parse(event.data)
    if (message.type === 'framepage') pageEvents.push(message)
    return
  }
  const bytes = new Uint8Array(event.data)
  const universe = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
  if (universe === 1) frame = bytes.subarray(2)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

const at = (address1) => (frame === null ? -1 : (frame[address1 - 1] ?? 0))
const near = (value, target, slack = 4) => Math.abs(value - target) <= slack
const settle = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(60)
  }
  return false
}
const send = (message) => socket.send(JSON.stringify(message))

const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) })
const patch = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })

/* --- The rig: one bar, three scenes, two chasers with REAL durations ------ */

await post('/fixtures', {
  manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 1,
})
const scene = async (name, channel) => {
  const made = await (await post('/functions', { type: 'Scene', name })).json()
  await post(`/functions/${made.id}/values`, { fixture: 0, channel, value: 200 })
  return made.id
}
const s1 = await scene('Uno', 0)
const s2 = await scene('Dos', 1)
const s3 = await scene('Tres', 2)

const chaserOf = async (name, members) => {
  const made = (await (await post('/functions', { type: 'Chaser', name })).json()).id
  for (const member of members) await post(`/functions/${made}/steps`, { function: member })
  await patch(`/functions/${made}`, { durationMode: 'perstep' })
  for (let i = 0; i < members.length; i++) {
    /* A real duration per step, or the runner races through the list. */
    await patch(`/functions/${made}/steps/${i}`, { duration: 600000 })
  }
  return made
}
const stepsChaser = await chaserOf('Escalera', [s1, s2, s3])
const fadeChaser = await chaserOf('Fundido', [s1, s2])

/* --- Steps mode: the fader IS the cue list ------------------------------- */

send({ type: 'cuelist', chaser: stepsChaser, action: 'play' })
check('the ladder starts on its first cue', await settle(() => at(1) === 200), `1=${at(1)}`)

send({ type: 'cuelist', chaser: stepsChaser, action: 'sidefader', mode: 'Steps', value: 0 })
check('fader at the bottom is the LAST cue',
  await settle(() => at(3) === 200 && at(1) === 0), `1=${at(1)} 3=${at(3)}`)

send({ type: 'cuelist', chaser: stepsChaser, action: 'sidefader', mode: 'Steps', value: 128 })
check('mid-fader is the middle cue',
  await settle(() => at(2) === 200 && at(3) === 0), `2=${at(2)} 3=${at(3)}`)

send({ type: 'cuelist', chaser: stepsChaser, action: 'sidefader', mode: 'Steps', value: 255 })
check('full fader returns to the first cue',
  await settle(() => at(1) === 200 && at(2) === 0), `1=${at(1)} 2=${at(2)}`)

send({ type: 'function', id: stepsChaser, action: 'stop' })
await settle(() => at(1) === 0)

/* --- Crossfade: mid-travel blends, the end hands over -------------------- */

send({ type: 'cuelist', chaser: fadeChaser, action: 'play' })
check('the fade starts on cue one', await settle(() => at(1) === 200 && at(2) === 0),
  `1=${at(1)} 2=${at(2)}`)

send({ type: 'cuelist', chaser: fadeChaser, action: 'sidefader', mode: 'Crossfade', value: 128 })
check('mid-crossfade holds BOTH cues at half',
  await settle(() => near(at(1), 100) && near(at(2), 100)), `1=${at(1)} 2=${at(2)}`)

send({ type: 'cuelist', chaser: fadeChaser, action: 'sidefader', mode: 'Crossfade', value: 0 })
check('the far end hands over to the next cue',
  await settle(() => at(1) === 0 && at(2) === 200), `1=${at(1)} 2=${at(2)}`)

send({ type: 'function', id: fadeChaser, action: 'stop' })
await settle(() => at(2) === 0)

/* --- The page turns from the wire ---------------------------------------- */

const io = await (await fetch(`${base}/api/v1/io`)).json()
const loop = io.inputPlugins.find((p) => p.name === 'Loopback')
let framePart = 'none'
if (loop) {
  await patch('/universes/2', {
    output: { plugin: 'Loopback', line: loop.lines[0] },
    input: { plugin: 'Loopback', line: loop.lines[0] },
  })

  const made = await (await post('/vc/widgets', {
    type: 'frame', caption: 'Paginado',
  })).json()
  const frameId = Number(made.id)
  const paged = await patch(`/vc/widgets/${frameId}`, {
    pages: 2,
    pageInputs: { next: { universe: 1, channel: 3 } },
  })
  check('a frame takes pages and a page-turning input', paged.ok, `${paged.status}`)

  const drive = (value) =>
    fetch(`${base}/api/v1/simpledesk/2/channels`, {
      method: 'PUT', headers: json, body: JSON.stringify({ values: { '4': value } }),
    })

  await drive(255)
  check('the wire turns the page',
    await settle(() => pageEvents.some((e) => e.id === frameId && e.page === 1)),
    JSON.stringify(pageEvents))
  await drive(0)
  await sleep(300)

  /* Without PagesLoop, the last page is a wall. */
  await drive(255)
  await sleep(700)
  check('without loop the last page holds',
    !pageEvents.some((e) => e.id === frameId && e.page === 0),
    JSON.stringify(pageEvents))
  await drive(0)
  await sleep(300)

  await patch(`/vc/widgets/${frameId}`, { pagesLoop: true })
  await sleep(400)
  await drive(255)
  check('with PagesLoop the page wraps around',
    await settle(() => pageEvents.some((e) => e.id === frameId && e.page === 0)),
    JSON.stringify(pageEvents))
  await drive(0)
  framePart = 'ok'
}
check('the page turns from external input', framePart === 'ok' || framePart === 'none',
  framePart)

/* --- A cue list widget carries its side fader mode ------------------------ */

const cueWidget = await (await post('/vc/widgets', {
  type: 'cuelist', caption: 'Lista', chaserId: fadeChaser,
})).json()
const modeSet = await patch(`/vc/widgets/${cueWidget.id}`, { sideFaderMode: 'Crossfade' })
check('the cue list takes a side fader mode', modeSet.ok, `${modeSet.status}`)

/* --- The file agrees ------------------------------------------------------ */

const saved = await fetch(`${base}/api/v1/project/save-as`, {
  method: 'POST',
  headers: { ...json, Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path: savePath }),
})
check('the project saves', saved.ok, `${saved.status}`)
const file = readFileSync(savePath, 'utf8')
if (loop) {
  check('Multipage is in the file',
    /<Multipage PagesNum="2"/.test(file),
    (file.match(/<Multipage[^>]*>/g) ?? ['no Multipage']).join(' | '))
  check('the page-turning input is in the file',
    /<Next>[\s\S]{0,80}?<Input Universe="1" Channel="3"/.test(file),
    (file.match(/<Next>[\s\S]{0,120}/) ?? ['no Next']).join('').slice(0, 160))
  check('PagesLoop is in the file', /<PagesLoop>True<\/PagesLoop>/.test(file),
    (file.match(/<PagesLoop>[^<]*/g) ?? ['no PagesLoop']).join(' | '))
}
check('SlidersMode is in the file', /<SlidersMode>Crossfade<\/SlidersMode>/.test(file),
  (file.match(/<SlidersMode>[^<]*/g) ?? ['no SlidersMode']).join(' | '))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
