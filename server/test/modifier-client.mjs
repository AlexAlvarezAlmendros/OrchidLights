/**
 * Channel modifiers, read off the universe.
 *
 *   node modifier-client.mjs <ws-url> <token>
 *
 * A modifier is the curve every value on a channel passes through on the way
 * out. It is applied inside Universe::updatePostGMValue, which is the same
 * buffer the live feed broadcasts -- so it can be proved rather than asserted
 * about: put 100 on an inverted channel and 155 comes off the wire.
 *
 * The assertion that costs something is "it takes effect without touching the
 * fader". A modifier is applied when a channel is written, so attaching one to
 * a lamp holding a look changes nothing at all until something moves -- which
 * is exactly when nobody wants to discover whether it worked.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const WHITES = 0 // channels group: Barra red + white
const RED = 100 // Barra is at address 101, so its channel 0 is DMX 100
const WHT = 103
// The Spot's prism, at address 1. Nothing in this project holds it: it is set
// once by a scene and left there, which is what makes it useful. A channel
// something is holding would be put back by whatever holds it, and would say
// nothing about whether attaching a modifier disturbed it.
const PRISM = 9
const GOBO_INDEX = 5

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

const setGroup = async (id, value) => {
  socket.send(JSON.stringify({ type: 'channelgroup', id, value }))
  await sleep(450)
}

const put = (id, modifiers) =>
  fetch(`${base}/api/v1/fixtures/${id}/modifiers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modifiers }),
  })

const channels = async (id) =>
  (await (await fetch(`${base}/api/v1/fixtures/${id}`)).json()).channelList

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
await sleep(300)

try {
  /* What the daemon has to offer. The names are all a client gets, so the list
     had better be the real one rather than a guess at what ships. */
  const listed = await (await fetch(`${base}/api/v1/modifiers`)).json()
  check('the templates are listed', (listed.modifiers?.length ?? 0) > 5, `${listed.modifiers?.length}`)
  check('including Invert', listed.modifiers?.includes('Invert'), listed.modifiers?.join(', '))

  /* The curve, because "Exponential Medium" and "Exponential Deep" are both
     plausible names and only one of them is what the lamp needs. */
  const invert = await (await fetch(`${base}/api/v1/modifiers/Invert`)).json()
  check(
    'and their curves can be read',
    invert.curve?.length === 256 && invert.curve[0] === 255 && invert.curve[255] === 0,
    `${invert.curve?.length} points, ${invert.curve?.[0]}..${invert.curve?.[255]}`,
  )

  const missing = await fetch(`${base}/api/v1/modifiers/No%20such%20curve`)
  check('a curve that does not exist is refused', missing.status === 404, `${missing.status}`)

  /* What the project came with. */
  const before = await channels(2)
  check(
    'the modifier in the file is reported',
    before?.[0]?.modifier === 'Invert',
    JSON.stringify(before?.[0]),
  )
  check('and only on the channel it names', before?.[1]?.modifier === undefined)

  /* And what it does. This is the whole point: the group is set to 100 and the
     wire must carry 155, because that channel is inverted. */
  await setGroup(WHITES, 100)
  check('an inverted channel comes out inverted', dmx?.[RED] === 155, `red=${dmx?.[RED]}`)
  check('and its neighbour does not', dmx?.[WHT] === 100, `white=${dmx?.[WHT]}`)

  /* Attaching one while the rig is holding a look. */
  const attached = await put(2, { 0: 'Invert', 3: 'Always Full' })
  check('a modifier can be attached', attached.ok, `${attached.status}`)
  await sleep(500)
  check('and bends the channel it names', dmx?.[WHT] === 255, `white=${dmx?.[WHT]}`)
  check('leaving the one already there alone', dmx?.[RED] === 155, `red=${dmx?.[RED]}`)

  /* Attaching a modifier to one channel must not disturb the rest of the
     fixture.
   *
   * The obvious way to push a modifier down to the universe is
   * Doc::updateFixtureChannelCapabilities, which is what the desktop calls --
   * and which re-applies every channel's *default* value on the way past. Using
   * it would drop the whole fixture to defaults because one channel got a
   * curve, and on a rig holding a look that is a lamp going out for no reason
   * anybody can see.
   *
   * The prism is set by a scene and then left: nothing holds it, so nothing
   * would put it back. */
  const scene = await (
    await fetch(`${base}/api/v1/functions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scene', name: 'Prisma' }),
    })
  ).json()

  await fetch(`${base}/api/v1/functions/${scene.id}/values`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fixture: 0, channel: 9, value: 200 }),
  })
  await fetch(`${base}/api/v1/functions/${scene.id}/start`, { method: 'POST' })
  await sleep(600)
  await fetch(`${base}/api/v1/functions/${scene.id}/stop`, { method: 'POST' })
  await sleep(600)

  check('a channel nothing holds keeps its value', dmx?.[PRISM] === 200, `prism=${dmx?.[PRISM]}`)

  /* The assertion the write-back exists for. A modifier is applied on write,
     and this channel is written by nobody: a fader or a running function gets
     re-written every tick and would pick the curve up on its own, but a latched
     value would sit there uncurved for as long as the look stayed up. */
  const latched = await put(0, { 9: 'Invert' })
  check('a modifier on another fixture is accepted', latched.ok, `${latched.status}`)
  await sleep(600)
  check(
    'and bends a latched channel straight away',
    dmx?.[PRISM] === 55,
    `prism=${dmx?.[PRISM]} (200 means it is waiting for somebody to touch the channel)`,
  )

  /* And touching one channel must not disturb the rest of the fixture. The
     obvious way to push a modifier down is Doc::updateFixtureChannelCapabilities,
     which is what the desktop calls -- and which re-applies every channel's
     *default* value on the way past, dropping the whole fixture to defaults
     because one channel got a curve. */
  const other = await put(0, { 9: 'Invert', 5: 'Invert' })
  check('a second one can join it', other.ok, `${other.status}`)
  await sleep(600)
  check(
    'without disturbing the channels already set',
    dmx?.[PRISM] === 55,
    `prism=${dmx?.[PRISM]} (255 means the fixture was reset to its defaults and then inverted)`,
  )
  check('and the new one is bent too', dmx?.[GOBO_INDEX] === 255, `index=${dmx?.[GOBO_INDEX]}`)

  await put(0, {})
  await sleep(500)
  check('taking them off puts the latched channel back', dmx?.[PRISM] === 200,
        `prism=${dmx?.[PRISM]}`)

  await fetch(`${base}/api/v1/functions/${scene.id}?force=true`, { method: 'DELETE' })

  /* Taking one off is the same problem in reverse. */
  const cleared = await put(2, {})
  check('and detached', cleared.ok, `${cleared.status}`)
  await sleep(500)
  check(
    'putting the channels back where they were',
    dmx?.[RED] === 100 && dmx?.[WHT] === 100,
    `red=${dmx?.[RED]} white=${dmx?.[WHT]}`,
  )
  check('with nothing left on the fixture', (await channels(2)).every((c) => !c.modifier))

  /* Refusals. */
  const refuse = async (id, modifiers, why) => {
    const response = await put(id, modifiers)
    const detail = response.ok ? '(accepted)' : (await response.json()).error
    check(why, response.status === 400, detail)
  }

  await refuse(2, { 0: 'No such curve' }, 'a modifier that does not exist is refused')
  await refuse(2, { 9: 'Invert' }, "a channel past the fixture's last is refused")
  await refuse(2, { rojo: 'Invert' }, 'a channel that is not a number is refused')

  const noKey = await fetch(`${base}/api/v1/fixtures/2/modifiers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('and a body with no modifiers key is refused', noKey.status === 400, `${noKey.status}`)

  const noFixture = await put(99, { 0: 'Invert' })
  check('as is a fixture that does not exist', noFixture.status === 400, `${noFixture.status}`)

  /* A refused attach must leave the fixture as it was: the write path clears
     every channel before setting the ones asked for, so validating late would
     strip a fixture's curves on a typo. */
  await put(2, { 0: 'Invert' })
  await refuse(2, { 0: 'Invert', 1: 'No such curve' }, 'a half-valid map is refused whole')
  const survivors = await channels(2)
  check(
    'and leaves the modifiers it could not change',
    survivors?.[0]?.modifier === 'Invert' && survivors?.[1]?.modifier === undefined,
    JSON.stringify(survivors.map((c) => c.modifier)),
  )
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nChannel modifiers test passed.')
process.exit(0)
