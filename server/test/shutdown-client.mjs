/**
 * Shutting the daemon down is part of the show, and this proves both halves.
 *
 *   node shutdown-client.mjs <base-url> <token> <expect-zero>
 *
 * The authorization half: POST /api/v1/shutdown must demand the token even on
 * loopback, where the rest of the API deliberately works without one. Killing
 * the desk is in a different class from using it.
 *
 * The wire half: with --zero-on-exit, the last frame to leave through the
 * output plugin must be dark. Read where only the truth exists -- off the
 * network. The daemon's WebSocket stream cannot answer this one: under
 * blackout the engine's post-GM values keep the old look while the plugins
 * are already sending zeros, so only a socket on the receiving end knows what
 * an ArtNet node would have latched.
 *
 * The listener binds 127.0.0.1:6454 -- deliberately more specific than the
 * plugin's own 0.0.0.0:6454 input socket, which is what makes the kernel hand
 * the packets to us instead of back to the daemon. That is delivery by
 * address-specificity, not a race.
 *
 * Protocol: prints READY-FOR-KILL once frames with the test value are seen;
 * the harness then terminates the daemon however this run is exercising
 * (SIGTERM or POST /shutdown), and this process judges the aftermath.
 */

import dgram from 'node:dgram'
import process from 'node:process'

const [base, token, expectZero] = process.argv.slice(2)
if (!base) {
  console.error('usage: shutdown-client.mjs <base-url> <token> <expect-zero: yes|no>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const auth = { Authorization: `Bearer ${token}` }
const json = { 'Content-Type': 'application/json' }

/* -------------------------------------------------------------------------
   The authorization half.
   ------------------------------------------------------------------------- */

const bare = await fetch(`${base}/api/v1/shutdown`, { method: 'POST' })
check('shutdown without a token is refused', bare.status === 401, `${bare.status}`)

const wrong = await fetch(`${base}/api/v1/shutdown`, {
  method: 'POST',
  headers: { Authorization: 'Bearer not-the-token' },
})
check('shutdown with a wrong token is refused', wrong.status === 401, `${wrong.status}`)

// And neither refusal killed anything: the daemon still answers.
const alive = await fetch(`${base}/api/v1/status`)
check('a refused shutdown leaves the daemon running', alive.ok, `${alive.status}`)

/* -------------------------------------------------------------------------
   The wire half. ArtDMX: "Art-Net\0", opcode 0x5000 LE at 8, universe LE at
   14, length BE at 16, channel data from 18.
   ------------------------------------------------------------------------- */

const packets = []
let lastData = null

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
socket.on('message', (bytes) => {
  if (bytes.length < 20) return
  if (bytes.toString('latin1', 0, 8) !== 'Art-Net\0') return
  if (bytes.readUInt16LE(8) !== 0x5000) return
  const length = bytes.readUInt16BE(16)
  lastData = bytes.subarray(18, 18 + length)
  packets.push(lastData)
})
await new Promise((resolve, reject) => {
  socket.once('error', reject)
  socket.bind(6454, '127.0.0.1', resolve)
})

// A rig to observe: one RGBW fixture at address 1, driven by the live desk.
// Built through the API so this test needs no project file of its own.
const patched = await fetch(`${base}/api/v1/fixtures`, {
  method: 'POST',
  headers: { ...auth, ...json },
  body: JSON.stringify({
    manufacturer: 'Generic',
    model: 'Generic RGBW',
    mode: 'RGBW',
    universe: 1,
    // 1-based, like everything the operator sees; on the wire this is offset 0.
    address: 1,
  }),
})
check('a fixture can be patched for the test', patched.ok, `${patched.status}`)

const wired = await fetch(`${base}/api/v1/universes/1`, {
  method: 'PATCH',
  headers: { ...auth, ...json },
  body: JSON.stringify({ output: { plugin: 'ArtNet', line: '127.0.0.1' } }),
})
check('the universe can be patched to ArtNet on loopback', wired.ok, `${wired.status}`)

const lit = await fetch(`${base}/api/v1/live`, {
  method: 'PUT',
  headers: { ...auth, ...json },
  body: JSON.stringify({
    values: [
      { fixture: 0, channel: 0, value: 200 },
      { fixture: 0, channel: 1, value: 150 },
    ],
  }),
})
check('the live desk holds a look', lit.ok, `${lit.status}`)

// The look must actually reach the wire before the kill means anything.
const sawLook = await new Promise((resolve) => {
  const deadline = setTimeout(() => resolve(false), 8000)
  const poll = setInterval(() => {
    if (lastData !== null && lastData[0] === 200 && lastData[1] === 150) {
      clearTimeout(deadline)
      clearInterval(poll)
      resolve(true)
    }
  }, 50)
})
check('the look is observed on the ArtNet wire', sawLook, `packets so far: ${packets.length}`)

if (failures.length > 0) {
  socket.close()
  process.exit(1)
}

/* Hand over to the harness, which now terminates the daemon. From here on the
   only job is listening: collect until the wire has been silent for a while,
   then judge the final frame. */
console.log('READY-FOR-KILL')

await new Promise((resolve) => {
  let seen = packets.length
  const idle = setInterval(() => {
    if (packets.length === seen) {
      clearInterval(idle)
      resolve()
    }
    seen = packets.length
  }, 1200)
})

const last = lastData
if (expectZero === 'yes') {
  const dark = last !== null && last.every((value) => value === 0)
  check(
    'the last frame on the wire is dark',
    dark,
    last === null ? 'no frames at all' : `ch0=${last[0]} ch1=${last[1]}`,
  )
} else {
  /* The default deliberately leaves the look: walking away from a daemon
     mid-show must not black out the venue. If this ever starts zeroing, the
     flag has silently become the default and both behaviours are lost. */
  const held = last !== null && last[0] === 200 && last[1] === 150
  check(
    'without --zero-on-exit the last frame still holds the look',
    held,
    last === null ? 'no frames at all' : `ch0=${last[0]} ch1=${last[1]}`,
  )
}

socket.close()
process.exit(failures.length === 0 ? 0 : 1)
