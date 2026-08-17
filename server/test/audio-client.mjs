/**
 * Audio triggers, as far as a test can honestly go.
 *
 *   node audio-client.mjs <ws-url> <token>
 *
 * What can be asserted without a microphone in the room: that the bars are read
 * out of the project correctly, that the switch reaches the daemon, that it
 * reports whether an input actually came up rather than claiming to listen, and
 * that a widget that does not exist is refused.
 *
 * What cannot: that a sound moves a light. That needs a signal, and a CI runner
 * has no audio input at all -- which is exactly why the daemon has to say so
 * instead of pretending. The switch reporting `capturing: false` on a silent
 * machine is the assertion that stands in for it.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const WIDGET = 1

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)

const states = []
const errors = []
let spectra = 0

socket.addEventListener('message', (event) => {
  if (typeof event.data !== 'string') return
  const message = JSON.parse(event.data)
  if (message.type === 'audiotriggers') states.push(message)
  if (message.type === 'error') errors.push(message.error)
  if (message.type === 'spectrum') spectra++
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const base = new URL(url.replace(/^ws/, 'http')).origin

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

socket.send(JSON.stringify({ type: 'auth', token }))
await sleep(400)

try {
  /* What the interface is handed. The unassigned bar must not be among them:
     a reader that treated type 0 as a kind would drive channel nothing. */
  const vc = await (await fetch(`${base}/api/v1/vc`)).json()
  const walk = (w) => [w, ...(w.children ?? []).flatMap(walk)]
  const widget = walk(vc).find((w) => w.type === 'audiotriggers')

  check('the widget is reported', widget !== undefined)

  if (widget) {
    check('with the bands it was built for', widget.bands === 8, `${widget.bands}`)
    check(
      'and only the bars that are assigned',
      widget.bars?.length === 3,
      `${widget.bars?.length} bars: ${widget.bars?.map((b) => b.drives).join(',')}`,
    )
    check(
      'each saying what it drives',
      widget.bars?.filter((b) => b.drives === 'dmx').length === 2 &&
        widget.bars?.some((b) => b.drives === 'function' && b.functionId === 0),
      widget.bars?.map((b) => `${b.name}:${b.drives}`).join(' '),
    )
    check(
      'and a volume bar told apart from a band',
      widget.bars?.filter((b) => b.volume).length === 1,
      `${widget.bars?.filter((b) => b.volume).length}`,
    )
    check('and offering itself as operable', widget.controllable === true)
  }

  /* Nothing has been switched on, so nothing may be listening. A daemon that
     opened the microphone on load would be taking a device the operator may be
     using for something else. */
  check('no spectrum arrives before it is switched on', spectra === 0, `${spectra} frames`)

  socket.send(JSON.stringify({ type: 'audiotriggers', id: WIDGET, enabled: true }))
  await sleep(1200)

  const on = states.at(-1)
  check('the switch reaches the daemon', on?.enabled === true, JSON.stringify(on))

  /* The honest part. On a machine with an input this is true and a spectrum
     follows; on a CI runner with none it is false and the reason is there to
     show. What must never happen is `capturing: true` with nothing arriving. */
  if (on?.capturing) {
    await sleep(1200)
    check('and a spectrum follows', spectra > 0, `${spectra} frames`)
  } else {
    check(
      'or it says why it could not listen',
      typeof on?.unavailable === 'string' && on.unavailable.length > 0,
      on?.unavailable ?? '(no reason given)',
    )
    check('and sends no spectrum it does not have', spectra === 0, `${spectra} frames`)
  }

  socket.send(JSON.stringify({ type: 'audiotriggers', id: WIDGET, enabled: false }))
  await sleep(600)
  check('and switches off again', states.at(-1)?.enabled === false)

  errors.length = 0
  socket.send(JSON.stringify({ type: 'audiotriggers', id: 999, enabled: true }))
  await sleep(500)
  check('a widget that does not exist is refused', errors.length === 1, errors.join(' | '))

  /* Which input the capture uses, and being able to change it.
   *
   * This is the difference between a widget that does not work and one that is
   * listening to the wrong socket: on the machine this was built on, the system
   * default is a headphones jack with nothing plugged into it, and the two look
   * identical from the console. */
  const audio = await (await fetch(`${base}/api/v1/audio`)).json()
  check('the inputs are listed', Array.isArray(audio.inputs), JSON.stringify(audio.inputs))
  check(
    'with the one in use named',
    typeof audio.selected === 'string',
    audio.selected ?? '(none)',
  )

  if ((audio.inputs?.length ?? 0) > 0) {
    const chosen = audio.inputs[audio.inputs.length - 1]
    const set = await fetch(`${base}/api/v1/audio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: chosen }),
    })
    check('and choosable', set.ok && (await set.json()).selected === chosen, chosen)

    // Restore, so the test leaves the machine as it found it.
    await fetch(`${base}/api/v1/audio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: audio.selected }),
    })
  }

  const refusedInput = await fetch(`${base}/api/v1/audio`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'No such microphone' }),
  })
  check('an input that does not exist is refused', refusedInput.status === 400)
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nAudio triggers test passed.')
process.exit(0)
