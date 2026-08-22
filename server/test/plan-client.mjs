/**
 * The plan: where each fixture stands, and which channels decide its colour.
 *
 *   node plan-client.mjs <ws-url> <token>
 *
 * The colours themselves are worked out in the browser from the DMX frames it
 * already receives, so what has to be right here is the map it works from: the
 * roles. A role that names the wrong channel paints the wrong lamp the wrong
 * colour, and everything downstream looks like it is working.
 *
 * So each role is checked by lighting exactly that channel and reading the wire
 * back: the assertion is not "the daemon says red is channel 0", it is "putting
 * a value on the channel the daemon calls red moves the channel that is red".
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const BARRA = 2 // Generic RGBW at address 101
const SPOT = 0 // Martin MAC500, a dimmer with no colour mixing

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') dmx = new Uint8Array(event.data).slice(2)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = new URL(url.replace(/^ws/, 'http')).origin

const json = { 'Content-Type': 'application/json' }
const plan = () => fetch(`${base}/api/v1/plan`).then((r) => r.json())

const place = (id, position) =>
  fetch(`${base}/api/v1/plan/fixtures/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(position),
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
  const first = await plan()

  check('the stage has a size', first.grid?.width > 0 && first.grid?.depth > 0,
        `${first.grid?.width} x ${first.grid?.depth} ${first.grid?.units}`)
  check('every patched fixture is on the plan', first.fixtures?.length === 3,
        `${first.fixtures?.length}`)

  /* Nobody has placed anything in this project, and that has to be said rather
     than answered with zeroes: a plan that stacks every unplaced lamp at the
     origin looks like a plan, and is not. */
  check(
    'and none of them claims a position it does not have',
    first.fixtures?.every((f) => f.x === undefined && f.y === undefined),
    JSON.stringify(first.fixtures?.map((f) => [f.name, f.x, f.y])),
  )

  const barra = first.fixtures.find((f) => f.id === BARRA)
  const spot = first.fixtures.find((f) => f.id === SPOT)

  check('an RGBW bar reports its colour channels',
        barra?.roles?.red === 0 && barra?.roles?.green === 1 && barra?.roles?.blue === 2,
        JSON.stringify(barra?.roles))
  check('a moving head with no mixing reports only its dimmer',
        spot?.roles?.intensity === 1 && spot?.roles?.red === undefined,
        JSON.stringify(spot?.roles))

  /* The roles, proved on the wire. A channels group is the shortest way to put
     a value on one named channel and see where it lands. */
  const group = await (
    await fetch(`${base}/api/v1/channel-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Prueba de roles',
        channels: [{ fixture: BARRA, channel: barra.roles.green }],
      }),
    })
  ).json()

  socket.send(JSON.stringify({ type: 'channelgroup', id: group.id, value: 200 }))
  await sleep(500)

  const address = barra.address + barra.roles.green
  check('the channel the daemon calls green is the one that moves',
        dmx?.[address] === 200 && dmx?.[barra.address + barra.roles.red] === 0,
        `green(${address})=${dmx?.[address]} red=${dmx?.[barra.address + barra.roles.red]}`)

  socket.send(JSON.stringify({ type: 'channelgroup', id: group.id, value: 0 }))
  await sleep(400)
  await fetch(`${base}/api/v1/channel-groups/${group.id}`, { method: 'DELETE' })

  /* The live desk: absolute values pinned on individual channels.
   *
     This is what turns the plan from a picture into a place to work, and it is
     worth checking here as well as through the browser -- the route is the
     thing, and it should not need an interface to be known to work. */
  const live = (values) =>
    fetch(`${base}/api/v1/live`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    })

  const held = await live([
    { fixture: BARRA, channel: barra.roles.red, value: 255 },
    { fixture: BARRA, channel: barra.roles.green, value: 45 },
    { fixture: BARRA, channel: barra.roles.blue, value: 45 },
  ])
  check('the live desk takes a set of channel values', held.ok, `${held.status}`)
  await sleep(500)

  check(
    'and each one lands on its own channel',
    dmx?.[barra.address] === 255 &&
      dmx?.[barra.address + 1] === 45 &&
      dmx?.[barra.address + 2] === 45,
    `${dmx?.[barra.address]}/${dmx?.[barra.address + 1]}/${dmx?.[barra.address + 2]}`,
  )

  /* A fader could not have done that: it holds every channel it owns at one
     value, which is right for a group of dimmers and wrong for a colour. */
  check(
    'which is something a level fader cannot express',
    dmx?.[barra.address] !== dmx?.[barra.address + 1],
    `red ${dmx?.[barra.address]} vs green ${dmx?.[barra.address + 1]}`,
  )

  const reported = await (await fetch(`${base}/api/v1/live`)).json()
  check('what it is holding can be read back', reported.values?.length === 3,
        `${reported.values?.length}`)

  const badChannel = await live([{ fixture: BARRA, channel: 9, value: 1 }])
  check("a channel past the fixture's last is refused", badChannel.status === 400,
        badChannel.ok ? '(accepted)' : (await badChannel.json()).error)

  const badValue = await live([{ fixture: BARRA, channel: 0, value: 300 }])
  check('and a value that is not a DMX value', badValue.status === 400, `${badValue.status}`)

  /* Nothing it refused was applied: it checks the whole batch before writing
     any of it, because half a colour is a lamp nobody asked for. */
  await sleep(400)
  check('a refused batch changed nothing', dmx?.[barra.address] === 255,
        `${dmx?.[barra.address]}`)

  await fetch(`${base}/api/v1/live`, { method: 'DELETE' })
  await sleep(600)
  check(
    'and letting go puts the channels down rather than leaving them latched',
    dmx?.[barra.address] === 0 && dmx?.[barra.address + 1] === 0,
    `${dmx?.[barra.address]}/${dmx?.[barra.address + 1]}`,
  )

  /* Placing. */
  const placed = await place(BARRA, { x: 1200, y: 800, rotation: 45, gel: '#ff8800' })
  check('a fixture can be placed', placed.ok, `${placed.status}`)

  const after = await plan()
  const put = after.fixtures.find((f) => f.id === BARRA)
  check('and comes back where it was put',
        put?.x === 1200 && put?.y === 800 && put?.rotation === 45,
        `${put?.x},${put?.y} @${put?.rotation}`)
  check('with the gel it was given', put?.gel === '#ff8800', put?.gel)

  /* A move must not throw away the gel somebody set. */
  await place(BARRA, { x: 2000 })
  const moved = (await plan()).fixtures.find((f) => f.id === BARRA)
  check('moving it keeps the gel and the rotation',
        moved?.x === 2000 && moved?.y === 800 && moved?.gel === '#ff8800' && moved?.rotation === 45,
        `${moved?.x},${moved?.y} @${moved?.rotation} ${moved?.gel}`)

  /* Once refused because the save would have lost it; the save now writes
     the third coordinate (F18), so a height simply works -- proven end to end
     further down and in the .qxw check. */
  const height = await place(BARRA, { x: 100, z: 900 })
  check('a height is accepted now that the file keeps it', height.ok, `${height.status}`)

  const notANumber = await place(BARRA, { x: 'izquierda' })
  check('a position that is not a number is refused', notANumber.status === 400,
        `${notANumber.status}`)

  const badGel = await place(BARRA, { gel: 'rojo intenso' })
  check('a colour that is not a colour is refused', badGel.status === 400,
        badGel.ok ? '(accepted)' : (await badGel.json()).error)

  const noFixture = await place(99, { x: 0, y: 0 })
  check('a fixture that does not exist is refused', noFixture.status === 400, `${noFixture.status}`)

  /* Taking a lamp off the plan is not unpatching it. */
  const off = await fetch(`${base}/api/v1/plan/fixtures/${BARRA}`, { method: 'DELETE' })
  check('a fixture can be taken off the plan', off.ok, `${off.status}`)

  const without = await plan()
  check('and is reported as unplaced again, still patched',
        without.fixtures.find((f) => f.id === BARRA)?.x === undefined &&
          without.fixtures.length === 3,
        `${without.fixtures.length} fixtures`)

  const twice = await fetch(`${base}/api/v1/plan/fixtures/${BARRA}`, { method: 'DELETE' })
  check('and cannot be taken off twice', twice.status === 404, `${twice.status}`)

  /* The background. This project names none, and saying so beats a broken
     image: the drawing a plan was built against being missing is worth
     knowing. */
  check('no background is a 404 with a reason', first.background === false)
  const background = await fetch(`${base}/api/v1/plan/background`)
  check('and the route says so', background.status === 404, `${background.status}`)

  /* --- F18: the plan grows a third coordinate and a stage of its own ------ */

  const raised = await place(BARRA, { x: 500, y: 500, z: 2500, rotationX: 30 })
  check('a lamp takes a height and a hang tilt', raised.ok, `${raised.status}`)
  const lifted = (await plan()).fixtures.find((f) => f.id === BARRA)
  check('and the plan repeats them', lifted?.z === 2500 && lifted?.rotationX === 30,
        JSON.stringify([lifted?.z, lifted?.rotationX]))

  const resized = await fetch(`${base}/api/v1/plan/grid`, {
    method: 'PUT', headers: json,
    body: JSON.stringify({ width: 12, depth: 8, units: 'meters' }),
  })
  check('the stage can be resized', resized.ok, `${resized.status}`)
  const staged = await plan()
  check('and the plan says the new stage',
        staged.grid.width === 12 && staged.grid.depth === 8,
        JSON.stringify(staged.grid))
  const povRefused = await fetch(`${base}/api/v1/plan/grid`, {
    method: 'PUT', headers: json, body: JSON.stringify({ pointOfView: 'front' }),
  })
  check('a point of view is refused with the reason (it would remap every position)',
        povRefused.status === 400, `${povRefused.status}`)
  const badUnits = await fetch(`${base}/api/v1/plan/grid`, {
    method: 'PUT', headers: json, body: JSON.stringify({ units: 'cubits' }),
  })
  check('an invented unit is refused', badUnits.status === 400, `${badUnits.status}`)

  /* A one-pixel PNG becomes the backdrop, and comes off again. */
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')
  const uploaded = await fetch(`${base}/api/v1/assets?name=fondo.png`, {
    method: 'POST', body: pixel,
  })
  check('a backdrop uploads as an asset', uploaded.ok, `${uploaded.status}`)
  const hung = await fetch(`${base}/api/v1/plan/background`, {
    method: 'PUT', headers: json, body: JSON.stringify({ asset: 'fondo.png' }),
  })
  check('and hangs behind the plan', hung.ok, `${hung.status}`)
  const withBackdrop = await fetch(`${base}/api/v1/plan/background`)
  check('the backdrop serves', withBackdrop.status === 200, `${withBackdrop.status}`)
  const unhung = await fetch(`${base}/api/v1/plan/background`, { method: 'DELETE' })
  check('and comes off again', unhung.ok, `${unhung.status}`)
  const bare = await fetch(`${base}/api/v1/plan/background`)
  check('leaving the 404 with its reason', bare.status === 404, `${bare.status}`)

  /* Put it back, so the saved file has something in it to check. The height
     and the tilt STAY: preserving them across a move is the whole point. */
  await place(BARRA, { x: 1200, y: 800, rotation: 45, gel: '#ff8800' })
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nPlan test passed.')
process.exit(0)
