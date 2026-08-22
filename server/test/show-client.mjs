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

  /* --- F16: the ruler counts in beats when the show says so --------------- */

  const tempoSet = await patch(`/functions/${SHOW}`, { timeDivision: 'BPM_3_4', bpm: 90 })
  check('the show takes a time division', tempoSet.ok, `${tempoSet.status}`)
  const counted = await body()
  check('and repeats it', counted.timeDivision === 'BPM_3_4' && counted.bpm === 90,
        `${counted.timeDivision} @ ${counted.bpm}`)
  const badTempo = await patch(`/functions/${SHOW}`, { timeDivision: 'Waltz' })
  check('an invented division is refused', badTempo.status === 400, `${badTempo.status}`)

  /* --- F16: solo, the reference way --------------------------------------- */

  const soloTrack = await post(`/functions/${SHOW}/tracks`, { name: 'SoloHumo' })
  const soloTrackId = (await soloTrack.json()).id
  const soloed = await post(`/functions/${SHOW}/tracks/${TRACK}/solo`, { solo: true })
  check('a track can go solo', soloed.ok, `${soloed.status}`)
  const during = await body()
  check('solo means every OTHER track mutes',
        during.tracks.find((t) => t.id === TRACK)?.mute === false
          && during.tracks.find((t) => t.id === soloTrackId)?.mute === true,
        JSON.stringify(during.tracks.map((t) => [t.id, t.mute])))
  await post(`/functions/${SHOW}/tracks/${TRACK}/solo`, { solo: false })
  const unsoloed = await body()
  check('un-solo unmutes them all', unsoloed.tracks.every((t) => t.mute === false),
        JSON.stringify(unsoloed.tracks.map((t) => t.mute)))
  await fetch(`${base}/api/v1/functions/${SHOW}/tracks/${soloTrackId}`, { method: 'DELETE' })

  /* --- F16: time surgery at the cursor ------------------------------------ */

  const itemsNow = (await body()).tracks[0].functions
  const rojoItem = itemsNow.find((f) => f.name === 'Rojo')?.id
  const verdeItem = itemsNow.find((f) => f.name === 'Verde')?.id

  const inserted = await (await post(`/functions/${SHOW}/time`, {
    action: 'insert', at: 400, amount: 2000,
  })).json()
  check('inserting 2 s inside Rojo stretches it and pushes Verde',
        inserted.stretched === 1 && inserted.moved === 1, JSON.stringify(inserted))
  const grown = (await body()).tracks[0].functions
  check('the arithmetic is exact: Rojo 2800 ms, Verde starts at 2800',
        grown.find((f) => f.id === rojoItem)?.duration === 2800
          && grown.find((f) => f.id === verdeItem)?.start === 2800,
        grown.map((f) => `${f.name}@${f.start}+${f.duration}`).join(' '))

  const cutBack = await (await post(`/functions/${SHOW}/time`, {
    action: 'cut', at: 400, amount: 1000,
  })).json()
  check('cutting 1 s shrinks Rojo and pulls Verde back',
        cutBack.shrunk === 1 && cutBack.moved === 1, JSON.stringify(cutBack))
  const shrunkNow = (await body()).tracks[0].functions
  check('again exact: Rojo 1800 ms, Verde at 1800',
        shrunkNow.find((f) => f.id === rojoItem)?.duration === 1800
          && shrunkNow.find((f) => f.id === verdeItem)?.start === 1800,
        shrunkNow.map((f) => `${f.name}@${f.start}+${f.duration}`).join(' '))

  const emptyAir = await post(`/functions/${SHOW}/time`, {
    action: 'insert', at: 60000, amount: 1000,
  })
  check('the cursor in empty air is refused', emptyAir.status === 400, `${emptyAir.status}`)

  /* Back to the file's own shape, through the same primitives an editor
     drags with. */
  await patch(`/functions/${SHOW}/items/${rojoItem}`, { duration: 800 })
  await patch(`/functions/${SHOW}/items/${verdeItem}`, { start: 800 })

  /* --- F16: the cursor is a transport -- seek, pause, resume -------------- */

  positions.length = 0
  socket.send(JSON.stringify({ type: 'function', id: SHOW, action: 'start', at: 900 }))
  await sleep(250)
  check('started at 900 ms the show opens on Verde, Rojo never lit',
        dmx?.[GREEN] === 255 && dmx?.[RED] === 0,
        `red=${dmx?.[RED]} green=${dmx?.[GREEN]}`)
  check('and the clock says so', positions.some((p) => p.running && p.elapsed >= 900),
        positions.map((p) => p.elapsed).join(','))

  socket.send(JSON.stringify({ type: 'function', id: SHOW, action: 'pause' }))
  await sleep(500)
  const frozenAt = positions.filter((p) => p.paused).map((p) => p.elapsed)
  socket.send(JSON.stringify({ type: 'function', id: SHOW, action: 'resume' }))
  await sleep(250)
  check('pause freezes the clock without dropping the light',
        frozenAt.length >= 2 && frozenAt[0] === frozenAt[frozenAt.length - 1]
          && dmx?.[GREEN] === 255,
        `elapsed ${frozenAt.join(',')} green=${dmx?.[GREEN]}`)
  const resumed = positions.filter((p) => p.paused === false && p.running).map((p) => p.elapsed)
  check('resume lets it run on', resumed.length > 0
          && resumed[resumed.length - 1] > (frozenAt[0] ?? 0),
        resumed.join(','))
  socket.send(JSON.stringify({ type: 'function', id: SHOW, action: 'stop' }))
  await sleep(400)
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nShow manager test passed.')
process.exit(0)
