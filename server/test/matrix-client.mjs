/**
 * A Matrix widget, read off the universe.
 *
 *   node matrix-client.mjs <ws-url> <token>
 *
 * The widget is a fader over an RGB matrix plus a bank of presets. Everything
 * about a preset can look right in the model and be wrong on the wire, so the
 * colour ones are checked by reading the DMX the matrix produces, and the
 * animation one by reading back the algorithm the matrix is running.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const WIDGET = 1
const MATRIX = 0

// Two Generic RGB at addresses 1 and 4: red, green, blue in that order.
const PIXEL1 = { r: 0, g: 1, b: 2 }
const PIXEL2 = { r: 3, g: 4, b: 5 }

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
const errors = []

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') {
    dmx = new Uint8Array(event.data).slice(2)
    return
  }
  const message = JSON.parse(event.data)
  if (message.type === 'error') errors.push(message.error)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = new URL(url.replace(/^ws/, 'http')).origin

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(300)
socket.send(JSON.stringify({ type: 'subscribe', universes: [1] }))
await sleep(300)

const preset = async (id) => {
  socket.send(JSON.stringify({ type: 'matrix', id: WIDGET, preset: id }))
  await sleep(600)
}

const lit = () => [dmx?.[PIXEL1.r], dmx?.[PIXEL1.g], dmx?.[PIXEL1.b]]

try {
  /* The widget is a fader over the matrix: at zero it is stopped, above zero it
     runs. Nothing else in the project starts it. */
  socket.send(JSON.stringify({ type: 'slider', id: WIDGET, value: 255 }))
  await sleep(900)

  check(
    'the fader starts the matrix',
    dmx?.[PIXEL1.r] === 255 && dmx?.[PIXEL2.r] === 255,
    `pixel1=${lit().join(',')} pixel2r=${dmx?.[PIXEL2.r]}`,
  )

  await preset(1)
  check('a colour preset repaints it', lit().join(',') === '0,255,0', lit().join(','))

  await preset(2)
  check('and another one changes it again', lit().join(',') === '0,0,255', lit().join(','))

  /* An animation preset swaps the algorithm. Read back from the matrix rather
     than from the widget: what matters is what the engine is running. */
  await preset(4)
  const body = await (await fetch(`${base}/api/v1/functions/${MATRIX}/body`)).json()
  check('an animation preset swaps the algorithm', body.algorithm === 'Stripes', body.algorithm)

  /* A knob is continuous, not a button. Refusing beats applying something
     else, and the reason has to reach the operator. */
  errors.length = 0
  await preset(5)
  check('a knob preset is refused with a reason', errors.length === 1, errors.join(' | '))

  errors.length = 0
  socket.send(JSON.stringify({ type: 'matrix', id: WIDGET, preset: 99 }))
  await sleep(500)
  check('and so is a preset that does not exist', errors.length === 1, errors.join(' | '))

  socket.send(JSON.stringify({ type: 'slider', id: WIDGET, value: 0 }))
  await sleep(900)
  check(
    'and the fader stops it at zero',
    dmx?.[PIXEL1.r] === 0 && dmx?.[PIXEL1.g] === 0 && dmx?.[PIXEL1.b] === 0,
    lit().join(','),
  )
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nMatrix widget test passed.')
process.exit(0)
