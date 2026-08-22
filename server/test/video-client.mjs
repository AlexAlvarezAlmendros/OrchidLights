/**
 * F21's video, proved on the wire.
 *
 *   node video-client.mjs <base-url> <ws-url> <media-path>
 *
 * The daemon runs with --require-auth, which is the point:
 *
 *  - every normal route demands the token;
 *  - the MEDIA route serves without one (a bare TV must play), with Range
 *    answering 206 and exact bytes;
 *  - starting the video emits a feed event carrying everything a surface
 *    needs; sync arrives within ~5 s bearing the engine's clock; pause,
 *    resume and stop all say themselves.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'

const [base, wsUrl, mediaPath] = process.argv.slice(2)
if (!base || !wsUrl || !mediaPath) {
  console.error('usage: video-client.mjs <base-url> <ws-url> <media-path>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const token = readFileSync(`${homedir()}/.orchidlights/api-token`, 'utf8').trim()
const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

const events = []
const socket = new WebSocket(wsUrl)
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const message = JSON.parse(event.data)
  if (message.type === 'video') events.push(message)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))
socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)

const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: authed, body: JSON.stringify(body) })
const put = (path, body) =>
  fetch(`${base}/api/v1${path}`, { method: 'PUT', headers: authed, body: JSON.stringify(body) })

/* --- The film ------------------------------------------------------------- */

const made = await (await post('/functions', { type: 'Video', name: 'Peli' })).json()
const film = made.id
const dressed = await put(`/functions/${film}/body`, {
  source: mediaPath,
  screen: 1,
  layer: 3,
  geometry: { x: 10, y: 20, width: 640, height: 360 },
  rotation: { x: 0, y: 0, z: 90 },
})
check('the video takes source, screen, layer, geometry and rotation', dressed.ok,
  `${dressed.status}`)
const body = await (await fetch(`${base}/api/v1/functions/${film}/body`,
  { headers: authed })).json()
check('and repeats them', body.screen === 1 && body.layer === 3
  && body.geometry?.width === 640 && body.rotation?.z === 90, JSON.stringify(body))

/* --- The media route: no token, exact ranges ------------------------------- */

const walledOff = await fetch(`${base}/api/v1/functions`)
check('normal routes demand the token', walledOff.status === 401, `${walledOff.status}`)

const whole = await fetch(`${base}/api/v1/functions/${film}/media`)
check('the media plays WITHOUT a token', whole.status === 200, `${whole.status}`)
const bytes = Buffer.from(await whole.arrayBuffer())
const onDisk = readFileSync(mediaPath)
check('and byte for byte', bytes.length === onDisk.length && bytes.equals(onDisk),
  `${bytes.length} of ${onDisk.length}`)

const partial = await fetch(`${base}/api/v1/functions/${film}/media`, {
  headers: { Range: 'bytes=100-199' },
})
check('a range answers 206', partial.status === 206, `${partial.status}`)
check('with the exact content-range',
  partial.headers.get('content-range') === `bytes 100-199/${onDisk.length}`,
  partial.headers.get('content-range') ?? 'none')
const slice = Buffer.from(await partial.arrayBuffer())
check('and the exact bytes', slice.length === 100 && slice.equals(onDisk.subarray(100, 200)))

const badRange = await fetch(`${base}/api/v1/functions/${film}/media`, {
  headers: { Range: 'bytes=99999999-' },
})
check('an impossible range is refused as such', badRange.status === 416, `${badRange.status}`)

const missing = await fetch(`${base}/api/v1/functions/999/media`)
check('a function that does not exist is a 404', missing.status === 404, `${missing.status}`)

/* --- The feed directs ------------------------------------------------------- */

events.length = 0
socket.send(JSON.stringify({ type: 'function', id: film, action: 'start' }))
await sleep(700)
const started = events.find((e) => e.action === 'started')
check('starting the film says so with everything a surface needs',
  started !== undefined && started.screen === 1 && started.layer === 3
    && started.geometry?.width === 640 && started.rotation?.z === 90
    && started.serverTime !== undefined,
  JSON.stringify(started ?? events))

await sleep(5200)
const sync = events.find((e) => e.action === 'sync')
check('a sync arrives within ~5 s bearing the clock',
  sync !== undefined && sync.elapsed > 4000 && sync.serverTime > 0,
  JSON.stringify(sync ?? events.map((e) => e.action)))

socket.send(JSON.stringify({ type: 'function', id: film, action: 'pause' }))
await sleep(500)
check('pausing says paused', events.some((e) => e.action === 'paused'),
  events.map((e) => e.action).join(','))
socket.send(JSON.stringify({ type: 'function', id: film, action: 'resume' }))
await sleep(500)
check('resuming says resumed', events.some((e) => e.action === 'resumed'),
  events.map((e) => e.action).join(','))

socket.send(JSON.stringify({ type: 'function', id: film, action: 'stop' }))
await sleep(600)
check('stopping says stopped', events.some((e) => e.action === 'stopped'),
  events.map((e) => e.action).join(','))

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
