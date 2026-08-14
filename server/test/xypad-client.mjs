/**
 * Aim an XY pad over the live feed and read back the DMX it produced.
 *
 *   node xypad-client.mjs <ws-url> <token>
 *
 * The interface tests prove the pad moves; this proves the lights do. Nothing
 * short of reading the universe back says that: the position could be parked,
 * echoed to other clients and reported correctly while never reaching a
 * channel at all.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const PAD = 1
// MAC500 DMX1: pan coarse is channel 10 of the fixture, tilt coarse is 11.
// Zero-based inside the universe, so the second fixture at address 12 puts
// them at 22 and 23.
const LEFT = { pan: 10, tilt: 11 }
const RIGHT = { pan: 22, tilt: 23 }
// The DMX2 at address 24 has fine channels: pan 10/11, tilt 12/13.
const FINE = { pan: 34, panFine: 35, tilt: 36, tiltFine: 37 }

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

/** Latest frame per universe, 1-based universe id in the first two bytes. */
const frames = new Map()

socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  const bytes = new Uint8Array(event.data)
  frames.set(bytes[0] | (bytes[1] << 8), bytes.slice(2))
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))

/** Aim the pad and wait for a frame that reflects it. */
async function aim(x, y) {
  socket.send(JSON.stringify({ type: 'xypad', id: PAD, x, y }))
  // The engine applies on its next tick and the feed flushes at 25 Hz, so a
  // few frames of slack rather than a guess at one.
  await sleep(400)
  return frames.get(1)
}

try {
  let dmx = await aim(0, 0)
  /* The feed sends the channels the universe is actually using, not a padded
     512, so this asks for enough of them rather than all of them. */
  check('the feed is sending DMX', dmx !== undefined && dmx.length > FINE.tiltFine,
        `${dmx?.length} channels`)

  if (dmx) {
    check('at the origin the left head is at zero', dmx[LEFT.pan] === 0 && dmx[LEFT.tilt] === 0,
          `pan=${dmx[LEFT.pan]} tilt=${dmx[LEFT.tilt]}`)

    // The right head's X is reversed, so the pad's origin is its far end.
    check('and the reversed head is at the other end', dmx[RIGHT.pan] === 255,
          `pan=${dmx[RIGHT.pan]}`)

    // Its tilt is limited to the top half, so the bottom of the pad is already
    // the middle of the head's travel.
    check('and its limited tilt starts halfway', dmx[RIGHT.tilt] === 128,
          `tilt=${dmx[RIGHT.tilt]}`)
  }

  dmx = await aim(1, 1)
  if (dmx) {
    check('at the far corner the left head is at full', dmx[LEFT.pan] === 255 && dmx[LEFT.tilt] === 255,
          `pan=${dmx[LEFT.pan]} tilt=${dmx[LEFT.tilt]}`)
    check('the reversed head has swapped ends', dmx[RIGHT.pan] === 0, `pan=${dmx[RIGHT.pan]}`)
    check('and the limited tilt reaches its own top', dmx[RIGHT.tilt] === 255,
          `tilt=${dmx[RIGHT.tilt]}`)
  }

  dmx = await aim(0.5, 0)
  if (dmx) {
    check('halfway is halfway', dmx[LEFT.pan] === 128, `pan=${dmx[LEFT.pan]}`)
  }

  /* And the fine channels, which is what 16-bit arithmetic is for. A third of
     the way across is 21845 -- 85 coarse, 85 fine. Computed in 8 bits the
     coarse byte would come out the same and the fine one would be zero, so a
     head would step in 512 places instead of 65536 and a slow sweep would
     visibly stutter. */
  dmx = await aim(1 / 3, 0)
  if (dmx) {
    check('a fine channel gets the low byte', dmx[FINE.panFine] === 85,
          `coarse=${dmx[FINE.pan]} fine=${dmx[FINE.panFine]}`)
    check('and the coarse one the high byte', dmx[FINE.pan] === 85, `coarse=${dmx[FINE.pan]}`)
  }

  /* A pad that does not exist has to be refused rather than silently ignored,
     or an interface pointing at the wrong id looks like it is working. */
  const refused = await new Promise((resolve) => {
    const onMessage = (event) => {
      if (typeof event.data !== 'string') return
      const message = JSON.parse(event.data)
      if (message.type === 'error') {
        socket.removeEventListener('message', onMessage)
        resolve(message.error)
      }
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ type: 'xypad', id: 999, x: 0.5, y: 0.5 }))
    setTimeout(() => resolve('no answer'), 1500)
  })
  check('an unknown pad is refused', refused.includes('XY pad'), refused)
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nXY pad DMX test passed.')
process.exit(0)
