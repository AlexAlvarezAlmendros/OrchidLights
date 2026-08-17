/**
 * Channels groups, read off the universe.
 *
 *   node channelgroup-client.mjs <ws-url> <token>
 *
 * A channels group is one fader over a handful of channels picked by hand. It
 * belongs to the document, not to the console, and that distinction is what
 * most of this file is about:
 *
 *  - group ids and widget ids are different id spaces that both start at 0, so
 *    a group must never drive a widget's channels;
 *  - a group is not inside any frame, so no submaster scales it -- and since
 *    these groups hold Intensity channels, a design that scaled them would show
 *    on the wire rather than hide;
 *  - a channel taken out of a group, or a group deleted, is a channel nothing
 *    moves any more. It has to be let go of at zero, not left latched with its
 *    only control gone.
 *
 * Every assertion reads DMX back. A group can look perfect in the model and
 * reach nothing at all.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const WHITES = 0 // group: Barra red + white
const GREEN = 1 // group: Barra green
const GOBOS = 2 // group: the Spot's gobo wheel and gobo index
const MASTER = 1 // submaster over the whole console -- same number, other space
const SPOT = 2 // console level fader: MAC500 Intensity + Color1

// Barra is a Generic RGBW at address 101, so channel 0 is DMX 100.
const RED = 100
const GRN = 101
const BLU = 102
const WHT = 103
// What the console holds, which must stay the console's.
const DIM = 1
// The Spot's gobo channels, at address 1. Not Intensity channels, which is
// the whole point of them: an Intensity channel is zeroed by the engine every
// tick and rebuilt from whatever is holding it, so it falls back to zero on
// its own when a control goes away. A gobo wheel stays exactly where it was
// left. Only a channel like this can tell whether a control that disappears
// lets go of what it was holding, or abandons it there with nothing left to
// move it.
const GOBO = 4
const GOBO_INDEX = 5
const PRISM = 9

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
const echoes = []
const errors = []

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    dmx = new Uint8Array(event.data).slice(2)
    return
  }
  const message = JSON.parse(event.data)
  if (message.type === 'channelgroup') echoes.push(message)
  if (message.type === 'error') errors.push(message.error)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = new URL(url.replace(/^ws/, 'http')).origin

const groups = () => fetch(`${base}/api/v1/channel-groups`).then((r) => r.json())

const setGroup = async (id, value) => {
  socket.send(JSON.stringify({ type: 'channelgroup', id, value }))
  await sleep(450)
}

const setSlider = async (id, value) => {
  socket.send(JSON.stringify({ type: 'slider', id, value }))
  await sleep(450)
}

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
await sleep(300)

try {
  /* What the file said, with every channel named. A group listed as
     "fixture 2, channel 3" is one nobody can check is the one they meant. */
  const listed = await groups()
  check('the groups come out of the file', listed.length === 3, `${listed.length}`)

  const whites = listed.find((g) => g.id === WHITES)
  check(
    'with their channels named',
    whites?.channels?.map((c) => c.name).join('+') === 'Red+White',
    whites?.channels?.map((c) => `${c.fixtureName}·${c.name}`).join(' '),
  )
  check('and their addresses resolved', whites?.channels?.[0]?.address === RED, `${whites?.channels?.[0]?.address}`)
  check('and offering themselves as operable', whites?.controllable === true)

  /* The one that matters most: a group moves the channels it names. */
  await setGroup(WHITES, 200)
  check(
    'moving a group reaches its channels',
    dmx?.[RED] === 200 && dmx?.[WHT] === 200,
    `red=${dmx?.[RED]} white=${dmx?.[WHT]}`,
  )
  check(
    'and only its channels',
    dmx?.[GRN] === 0 && dmx?.[BLU] === 0,
    `green=${dmx?.[GRN]} blue=${dmx?.[BLU]}`,
  )

  await setGroup(GREEN, 90)
  check('a second group is its own fader', dmx?.[GRN] === 90 && dmx?.[RED] === 200,
        `green=${dmx?.[GRN]} red=${dmx?.[RED]}`)

  /* Group 1 and widget 1 are both "1". Widget 1 is a submaster over the whole
     console; if the two id spaces were one, moving the group would have moved
     the submaster and dimmed the console instead. */
  await setSlider(SPOT, 255)
  check('the console fader is unaffected by a group of the same id',
        dmx?.[DIM] === 255, `dim=${dmx?.[DIM]}`)

  /* And the other way round: a submaster scales the console, not the document.
     These are Intensity channels, so this would show if it were wrong. */
  await setSlider(MASTER, 128)
  check(
    'a submaster does not scale a channels group',
    dmx?.[RED] === 200 && dmx?.[GRN] === 90,
    `red=${dmx?.[RED]} green=${dmx?.[GRN]}`,
  )
  check('though it does scale the console', dmx?.[DIM] === 128, `dim=${dmx?.[DIM]}`)
  await setSlider(MASTER, 255)

  /* Other clients are told, so two browsers do not disagree about where a
     fader is. The sender is not echoed to, which is why this counts zero. */
  check('the mover is not echoed back to itself', echoes.length === 0, `${echoes.length}`)

  /* Editing, on the gobo group, because that is where it can be proved.
     A channel dropped from a group is a channel nothing moves any more, and it
     must not be left sitting at 200 with its only control gone. */
  await setGroup(GOBOS, 200)
  check(
    'a group holds channels that are not intensity',
    dmx?.[GOBO] === 200 && dmx?.[GOBO_INDEX] === 200,
    `gobo=${dmx?.[GOBO]} index=${dmx?.[GOBO_INDEX]}`,
  )

  const trimmed = await fetch(`${base}/api/v1/channel-groups/${GOBOS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Gobo', channels: [{ fixture: 0, channel: 4 }] }),
  })
  check('a group can be edited', trimmed.ok, `${trimmed.status}`)
  await sleep(450)

  check('the channel it kept is still held', dmx?.[GOBO] === 200, `gobo=${dmx?.[GOBO]}`)
  check('the channel it lost is let go of at zero', dmx?.[GOBO_INDEX] === 0,
        `index=${dmx?.[GOBO_INDEX]}`)
  check('and the rename took', (await groups()).find((g) => g.id === GOBOS)?.name === 'Gobo')

  /* The same on a group of intensity channels, which is the easy case: the
     engine zeroes those every tick anyway. Here to say that the easy case was
     not what the assertion above was testing. */
  const patched = await fetch(`${base}/api/v1/channel-groups/${WHITES}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Rojo', channels: [{ fixture: 2, channel: 0 }] }),
  })
  check('an intensity group can be trimmed too', patched.ok, `${patched.status}`)
  await sleep(450)
  check('keeping one channel and dropping the other',
        dmx?.[RED] === 200 && dmx?.[WHT] === 0,
        `red=${dmx?.[RED]} white=${dmx?.[WHT]}`)

  /* A new group works without reloading the project. On a prism channel, so
     deleting it is asserted on something that would otherwise stay put. */
  const created = await fetch(`${base}/api/v1/channel-groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Prisma', channels: [{ fixture: 0, channel: 9 }] }),
  })
  check('a group can be created', created.status === 201, `${created.status}`)
  const prism = (await created.json()).id

  await setGroup(prism, 77)
  check('and drives its channel immediately', dmx?.[PRISM] === 77, `prism=${dmx?.[PRISM]}`)

  /* Deleting is the same problem as dropping a channel, all at once. */
  const removed = await fetch(`${base}/api/v1/channel-groups/${prism}`, { method: 'DELETE' })
  check('a group can be deleted', removed.ok, `${removed.status}`)
  await sleep(450)
  check('and what it was holding goes out with it', dmx?.[PRISM] === 0, `prism=${dmx?.[PRISM]}`)

  /* Refusals. Each of these is a group that would look built and do something
     other than what it says. */
  const refuse = async (body, why) => {
    const response = await fetch(`${base}/api/v1/channel-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const detail = response.ok ? '(accepted)' : (await response.json()).error
    check(why, response.status === 400, detail)
  }

  // Barra has 4 channels, so channel 9 lands on whatever is patched next to it.
  await refuse({ name: 'Mala', channels: [{ fixture: 2, channel: 9 }] },
               'a channel past the fixture\'s last is refused')
  await refuse({ name: 'Mala', channels: [{ fixture: 99, channel: 0 }] },
               'a fixture that does not exist is refused')
  await refuse({ name: 'Mala', channels: [{ fixture: 2, channel: 0 }, { fixture: 2, channel: 0 }] },
               'the same channel twice is refused')
  await refuse({ name: 'Mala', channels: [] }, 'a group with no channels is refused')
  await refuse({ name: '  ', channels: [{ fixture: 2, channel: 0 }] },
               'a group with no name is refused')
  await refuse({ name: 'Mala', channels: [{ fixture: 2 }] },
               'a channel with no channel number is refused')

  /* A rejected edit must leave the group it was aimed at exactly as it was:
     the write path empties the channel list before refilling it, so validating
     late would leave a fader with nothing in it. */
  const badPatch = await fetch(`${base}/api/v1/channel-groups/${GREEN}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels: [{ fixture: 2, channel: 40 }] }),
  })
  check('a refused edit answers 400', badPatch.status === 400, `${badPatch.status}`)
  const survivor = (await groups()).find((g) => g.id === GREEN)
  check('and leaves the group it could not change alone',
        survivor?.channels?.length === 1 && survivor.channels[0].channel === 1,
        JSON.stringify(survivor?.channels))
  check('and the fader it was holding never moved', dmx?.[GRN] === 90, `green=${dmx?.[GRN]}`)

  errors.length = 0
  socket.send(JSON.stringify({ type: 'channelgroup', id: 404, value: 100 }))
  await sleep(400)
  check('a group that does not exist is refused', errors.length === 1, errors.join(' | '))

  const missing = await fetch(`${base}/api/v1/channel-groups/404`, { method: 'DELETE' })
  check('and cannot be deleted twice', missing.status === 404, `${missing.status}`)
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nChannels groups test passed.')
process.exit(0)
