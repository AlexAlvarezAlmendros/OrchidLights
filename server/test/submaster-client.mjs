/**
 * Submasters, read off the universe.
 *
 *   node submaster-client.mjs <ws-url> <token>
 *
 * A submaster scales the widgets around it. Everything about that can look
 * right in the model and be wrong on the wire, so every assertion here reads
 * DMX back.
 *
 * The two that discriminate between a real implementation and the tempting
 * shortcut are the colour-wheel one -- which kills multiplying the factor into
 * the target -- and the move-only-the-submaster one, which kills any design
 * that leans on a slider being touched.
 */

const url = process.argv[2]
const token = process.argv[3] ?? ''

const MASTER = 1 // submaster over the whole console
const SPOT = 2 // level fader: MAC500 Intensity + Color1
const PAD = 3
const INNER = 5 // submaster inside the nested frame
const NESTED = 6 // level fader inside it

// MAC500 DMX1 at address 1: Intensity is channel 1, Color1 is 2, pan 10.
const DIM = 1
const COLOUR = 2
const PAN = 10
// Second MAC500 at address 13.
const NESTED_DIM = 13

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const socket = new WebSocket(url)
socket.binaryType = 'arraybuffer'

let dmx = null
socket.addEventListener('message', (event) => {
  if (typeof event.data === 'string') return
  dmx = new Uint8Array(event.data).slice(2)
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

const set = async (id, value) => {
  socket.send(JSON.stringify({ type: 'slider', id, value }))
  await sleep(450)
}

try {
  await set(SPOT, 255)
  await set(NESTED, 255)
  check(
    'the faders reach their channels at full',
    dmx?.[DIM] === 255 && dmx?.[COLOUR] === 255 && dmx?.[NESTED_DIM] === 255,
    `dim=${dmx?.[DIM]} colour=${dmx?.[COLOUR]} nested=${dmx?.[NESTED_DIM]}`,
  )

  // Aim the pad somewhere that is not the origin, so a submaster dragging it
  // back towards zero would be visible.
  socket.send(JSON.stringify({ type: 'xypad', id: PAD, x: 1, y: 1 }))
  await sleep(450)
  const panBefore = dmx?.[PAN]
  check('the pad is aimed', panBefore === 255, `pan=${panBefore}`)

  /* Nothing else is touched from here: only the submaster moves. An
     implementation that waits for a fader to be moved again fails right here,
     and it is the failure that looks most like working software. */
  await set(MASTER, 127)

  check('a submaster dims what it encloses', dmx?.[DIM] === 127, `dim=${dmx?.[DIM]}`)

  /* The one that matters most. QLC+ applies a submaster only to channels in
     the Intensity group, so a colour wheel is left exactly where it was --
     dimming it would turn it into a different colour. */
  check('and leaves a colour wheel alone', dmx?.[COLOUR] === 255, `colour=${dmx?.[COLOUR]}`)
  check('and does not move a head', dmx?.[PAN] === 255, `pan=${dmx?.[PAN]}`)

  // The inner submaster is still at the full it was saved at, so the nested
  // fader is worth the outer factor alone: 255 × 127/255 = 127.
  check('and reaches into a nested frame', dmx?.[NESTED_DIM] === 127, `nested=${dmx?.[NESTED_DIM]}`)

  // Now both: 255 × (127/255)² = 63.25 -> 63. Nesting multiplies.
  await set(INNER, 127)
  check('and nesting multiplies', dmx?.[NESTED_DIM] === 63, `nested=${dmx?.[NESTED_DIM]}`)
  check('while the outer fader is untouched by it', dmx?.[DIM] === 127, `dim=${dmx?.[DIM]}`)

  /* Idempotence. QLC+ re-emits its submasters on several events and ratchets
     darker each time; ours is a product, so repeating a value changes nothing.
     Five console edits, each of which re-reads the tree and re-registers. */
  for (let i = 0; i < 5; i++) {
    await fetch(`${base}/api/v1/vc/widgets/9`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: `Etiqueta ${i}` }),
    })
    await sleep(250)
  }
  check(
    'and repeating does not ratchet the rig darker',
    dmx?.[DIM] === 127 && dmx?.[NESTED_DIM] === 63,
    `dim=${dmx?.[DIM]} nested=${dmx?.[NESTED_DIM]}`,
  )

  await set(MASTER, 255)
  check('back to full', dmx?.[DIM] === 255, `dim=${dmx?.[DIM]}`)

  await set(MASTER, 0)
  check('and to nothing at zero', dmx?.[DIM] === 0, `dim=${dmx?.[DIM]}`)
  check('with the colour wheel still where it was', dmx?.[COLOUR] === 255, `colour=${dmx?.[COLOUR]}`)

  await set(MASTER, 255)

  /* Buttons. A submaster does not press one, it scales what one started -- so
     the function keeps running and its output dims. Observed through the scene
     the button fires, which holds the same Intensity channel at full. */
  const BUTTON_FUNCTION = 0
  socket.send(JSON.stringify({ type: 'function', id: BUTTON_FUNCTION, action: 'start' }))
  await sleep(600)
  const litByButton = dmx?.[DIM]

  await set(SPOT, 0)
  await sleep(300)
  check('a button lights its scene', dmx?.[DIM] === 255, `dim=${dmx?.[DIM]} (was ${litByButton})`)

  await set(MASTER, 127)
  check('and a submaster dims it without stopping it', dmx?.[DIM] === 127, `dim=${dmx?.[DIM]}`)

  /* And the other order, which is the one that is easy to miss: the submaster
     is already down when the button is pressed. A function that comes up at
     full and only dims on the next submaster move is a light in someone's
     eyes. */
  socket.send(JSON.stringify({ type: 'function', id: BUTTON_FUNCTION, action: 'stop' }))
  await sleep(500)
  await set(MASTER, 127)
  socket.send(JSON.stringify({ type: 'function', id: BUTTON_FUNCTION, action: 'start' }))
  await sleep(700)
  check('a function started under a lowered submaster comes up scaled',
        dmx?.[DIM] === 127, `dim=${dmx?.[DIM]}`)

  socket.send(JSON.stringify({ type: 'function', id: BUTTON_FUNCTION, action: 'stop' }))
  await sleep(500)
  await set(MASTER, 255)
  await set(SPOT, 255)

  /* What the interface is told. A submaster enclosing only a label scales
     nothing, and has to say so rather than offer a control that does nothing. */
  const reported = await (await fetch(`${base}/api/v1/vc`)).json()
  const walk = (w) => [w, ...(w.children ?? []).flatMap(walk)]
  const widgets = Object.fromEntries(
    walk(reported).filter((w) => w.id !== undefined).map((w) => [w.id, w]),
  )

  check(
    'a submaster that scales something is operable',
    widgets[MASTER]?.controllable === true && widgets[MASTER]?.scales >= 2,
    `controllable=${widgets[MASTER]?.controllable} scales=${widgets[MASTER]?.scales}`,
  )
  check(
    'and one that scales nothing says so',
    widgets[8]?.controllable === false && widgets[8]?.scales === 0,
    `controllable=${widgets[8]?.controllable} scales=${widgets[8]?.scales}`,
  )
} finally {
  socket.close()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nSubmaster test passed.')
process.exit(0)
