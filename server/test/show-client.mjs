/**
 * The show manager, read off the universe and off the clock.
 *
 *   node show-client.mjs <ws-url> <token>
 *
 * A timeline is the one thing in a lighting desk where being right in the model
 * and wrong in time are indistinguishable from the outside. Every assertion
 * about what plays therefore waits for the show to reach a moment and reads the
 * wire at it.
 *
 * The project's show is two scenes on one track, back to back: red for 800 ms,
 * then green for 800 ms.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const SHOW = 3
const RED_SCENE = 1
const GREEN_SCENE = 2
const TRACK = 0

// Barra is at address 101, so its red channel is DMX 100.
const RED = 100
const GREEN = 101

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
const positions = []

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    dmx = new Uint8Array(event.data).slice(2)
    return
  }
  const message = JSON.parse(event.data)
  if (message.type === 'show') positions.push(message)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = new URL(url.replace(/^ws/, 'http')).origin

const body = () => fetch(`${base}/api/v1/functions/${SHOW}/body`).then((r) => r.json())

const post = (path, payload) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

const patch = (path, payload) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
await sleep(300)

try {
  /* What the file says. A show was the one function whose body this daemon
     could not read at all; it answered a note saying so. */
  const show = await body()
  check('the timeline comes out of the file', show.tracks?.length === 1, `${show.tracks?.length} tracks`)
  check('with its track named and bound to a scene',
        show.tracks?.[0]?.name === 'Luces' && show.tracks[0].sceneName === 'Rojo',
        `${show.tracks?.[0]?.name} / ${show.tracks?.[0]?.sceneName}`)
  check('and both functions placed on it', show.tracks?.[0]?.functions?.length === 2)
  check(
    'each with the name of what it plays',
    show.tracks?.[0]?.functions?.map((f) => f.name).join(',') === 'Rojo,Verde',
    show.tracks?.[0]?.functions?.map((f) => `${f.name}@${f.start}+${f.duration}`).join(' '),
  )
  check('and the length of the whole show', show.duration === 1600, `${show.duration} ms`)

  /* Playing it. This is what a timeline is for, and everything above is
     bookkeeping until it holds. */
  await post(`/functions/${SHOW}/start`, {})

  await sleep(400)
  check('at 400 ms the first scene is up', dmx?.[RED] === 255 && dmx?.[GREEN] === 0,
        `red=${dmx?.[RED]} green=${dmx?.[GREEN]}`)

  await sleep(800) // ~1200 ms in
  check('at 1200 ms the second has taken over', dmx?.[RED] === 0 && dmx?.[GREEN] === 255,
        `red=${dmx?.[RED]} green=${dmx?.[GREEN]}`)

  /* The playhead. The daemon's clock, sent while the show runs -- without it a
     timeline is a drawing, and a local timer started on play would drift and
     would carry on after the show ended. */
  check('the show reports where it is', positions.length > 3, `${positions.length} updates`)
  const moving = positions.filter((p) => p.running).map((p) => p.elapsed)
  check(
    'and the position moves forward',
    moving.length > 2 && moving[moving.length - 1] > moving[0],
    `${moving[0]}..${moving[moving.length - 1]} ms`,
  )
  check(
    'roughly in step with the wall clock',
    Math.abs((moving[moving.length - 1] ?? 0) - 1200) < 400,
    `${moving[moving.length - 1]} ms at about 1200`,
  )

  await sleep(900) // past the end
  check('and it ends on its own', dmx?.[RED] === 0 && dmx?.[GREEN] === 0,
        `red=${dmx?.[RED]} green=${dmx?.[GREEN]}`)
  check('saying so once rather than going quiet',
        positions.some((p) => p.running === false),
        positions.map((p) => p.running).join(','))

  /* Editing. */
  const track = await post(`/functions/${SHOW}/tracks`, { name: 'Humo' })
  check('a track can be added', track.status === 201, `${track.status}`)
  const second = (await track.json()).id

  const placed = await post(`/functions/${SHOW}/tracks/${second}/items`, {
    function: GREEN_SCENE,
    start: 200,
    duration: 400,
  })
  check('and a function placed on it', placed.status === 201, `${placed.status}`)
  const item = (await placed.json()).id

  /* Two things at the same time on the *same* track both play, and what the rig
     does is whichever wrote last -- which cannot be read off a timeline that
     draws them stacked. Refused with the culprit named. */
  const overlap = await post(`/functions/${SHOW}/tracks/${second}/items`, {
    function: RED_SCENE,
    start: 400,
    duration: 400,
  })
  check('an overlap on one track is refused', overlap.status === 400,
        overlap.ok ? '(accepted)' : (await overlap.json()).error)

  /* On another track it is fine, and that is the point of tracks. */
  const parallel = await post(`/functions/${SHOW}/tracks/${TRACK}/items`, {
    function: RED_SCENE,
    start: 2000,
    duration: 400,
  })
  check('but two tracks can play at once', parallel.status === 201, `${parallel.status}`)
  const parallelItem = (await parallel.json()).id

  const moved = await patch(`/functions/${SHOW}/items/${item}`, { start: 1000, duration: 500 })
  check('an item can be moved and stretched', moved.ok, `${moved.status}`)

  const after = await body()
  const humo = after.tracks?.find((t) => t.id === second)
  check(
    'and lands where it was put',
    humo?.functions?.[0]?.start === 1000 && humo?.functions?.[0]?.duration === 500,
    `${humo?.functions?.[0]?.start}+${humo?.functions?.[0]?.duration}`,
  )

  /* Locking is what stops a hand from dragging a cue that must not move. */
  await patch(`/functions/${SHOW}/items/${item}`, { locked: true })
  const locked = await patch(`/functions/${SHOW}/items/${item}`, { start: 5000 })
  check('a locked item refuses to be moved', locked.status === 400,
        locked.ok ? '(moved anyway)' : (await locked.json()).error)

  const stillThere = await body()
  check(
    'and has not moved',
    stillThere.tracks?.find((t) => t.id === second)?.functions?.[0]?.start === 1000,
    `${stillThere.tracks?.find((t) => t.id === second)?.functions?.[0]?.start}`,
  )
  await patch(`/functions/${SHOW}/items/${item}`, { locked: false })

  /* Refusals that matter. */
  const refuse = async (payload, why, track = TRACK) => {
    const response = await post(`/functions/${SHOW}/tracks/${track}/items`, payload)
    const detail = response.ok ? '(accepted)' : (await response.json()).error
    check(why, response.status === 400, detail)
  }

  await refuse({ function: SHOW, start: 10_000 }, 'a show inside itself is refused')
  await refuse({ function: 999, start: 10_000 }, 'a function that does not exist is refused')
  await refuse({ function: RED_SCENE, start: -5 }, 'a negative start is refused')

  const script = await (
    await post('/functions', { type: 'script', name: 'Guion' })
  ).json()
  await refuse({ function: script.id, start: 10_000 },
               'a script is refused: it has no duration to draw or to stop it at')

  const collection = await (
    await post('/functions', { type: 'collection', name: 'Conjunto' })
  ).json()
  await refuse({ function: collection.id, start: 12_000 }, 'and so is a collection')

  const noTrack = await post(`/functions/${SHOW}/tracks/99/items`, { function: RED_SCENE })
  check('a track that does not exist is refused', noTrack.status === 400, `${noTrack.status}`)

  const noShow = await post('/functions/999/tracks', { name: 'x' })
  check('and so is a show that does not exist', noShow.status === 400, `${noShow.status}`)

  const notAShow = await post(`/functions/${RED_SCENE}/tracks`, { name: 'x' })
  check('as is a function that is not a show', notAShow.status === 400, `${notAShow.status}`)

  /* Tidy up what this run added, so the saved file is predictable. */
  await fetch(`${base}/api/v1/functions/${SHOW}/items/${parallelItem}`, { method: 'DELETE' })
  const removedTrack = await fetch(`${base}/api/v1/functions/${SHOW}/tracks/${second}`, {
    method: 'DELETE',
  })
  check('a track can be removed', removedTrack.ok, `${removedTrack.status}`)
  await fetch(`${base}/api/v1/functions/${script.id}?force=true`, { method: 'DELETE' })
  await fetch(`${base}/api/v1/functions/${collection.id}?force=true`, { method: 'DELETE' })

  const back = await body()
  check('leaving the show as it started', back.tracks?.length === 1 && back.duration === 1600,
        `${back.tracks?.length} tracks, ${back.duration} ms`)
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nShow manager test passed.')
process.exit(0)
