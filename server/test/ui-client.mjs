/**
 * Drive the real interface in a real browser.
 *
 *   node ui-client.mjs <url> [screenshot-dir]
 *
 * Chrome's DevTools protocol rather than a test framework: this needs the app
 * as it is actually served -- built, from the daemon, talking to a real engine
 * -- and nothing about a jsdom render would tell us whether that works.
 *
 * The flow is the claim the editing layer makes: add a widget, rename it, point
 * it at a function, and delete it, all by clicking. The caller then checks the
 * project file came back to exactly where it started.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.argv[2]
const shots = process.argv[3]
if (shots) mkdirSync(shots, { recursive: true })

const port = Number(process.env.CDP_PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    '--window-size=1280,900',
    url,
  ],
  { stdio: 'ignore' },
)

async function debuggerUrl() {
  for (let i = 0; i < 75; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is still starting; the port refuses connections until it is not.
    }
    await sleep(200)
  }
  throw new Error('Chrome never opened a debugging port')
}

const ws = new WebSocket(await debuggerUrl())
await new Promise((resolve) => {
  ws.onopen = resolve
})

let nextId = 1
const pending = new Map()
const consoleErrors = []

ws.onmessage = (event) => {
  const message = JSON.parse(event.data)

  if (
    message.method === 'Log.entryAdded' &&
    message.params.entry.level === 'error' &&
    // The daemon serves no favicon, and the browser always asks.
    !message.params.entry.url?.endsWith('/favicon.ico')
  ) {
    consoleErrors.push(message.params.entry.text)
  }

  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message.result)
  }
}

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
await send('Log.enable')

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500))
  }
  return result?.result?.value
}

async function screenshot(name) {
  if (!shots) return
  await sleep(300)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${shots}/${name}.png`, Buffer.from(result.data, 'base64'))
}

const click = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))
    if (!el) return 'no hay botón: ' + ${JSON.stringify(text)}
    el.click()
    return 'ok'
  })()`)

const count = () => evaluate("document.querySelectorAll('.widget').length")

try {
  // The console is fetched, the feed connects, and the layout resolves; none of
  // that is instant against a real engine.
  await sleep(3000)

  const rendered = await count()
  check('the console renders', rendered > 0, `${rendered} widgets`)

  check('edit mode opens', (await click('Editar')) === 'ok')
  await sleep(400)
  await screenshot('01-editing')

  /* A console written by QLC+ 4 carries no widget ids -- the one that ships
     with QLC+ has none at all -- and nothing here can be edited until it does.
     The interface has to say so and offer the fix. */
  const unidentified = await evaluate("document.querySelector('.notice')?.textContent ?? ''")
  if (unidentified) {
    check('the missing ids are reported', /identificador/.test(unidentified))
    check('assigning them', (await click('Asignar identificadores')) === 'ok')
    await sleep(1500)
    check(
      'the warning goes away',
      (await evaluate("document.querySelector('.notice') === null")) === true,
    )
    await screenshot('01b-identified')
  }

  const before = await count()
  check('adding a button', (await click('+ Botón')) === 'ok')
  await sleep(1500)
  check('the widget appears', (await count()) === before + 1)

  const opened = await evaluate("document.querySelector('.editor header strong')?.textContent")
  check('the panel opens on the new widget', opened === 'Botón', opened)
  await screenshot('02-added')

  /* Typed into the field and committed the way a person commits it. React
     listens for focusout rather than blur, which is why the event is spelled
     that way -- dispatching 'blur' here silently does nothing. */
  const renamed = await evaluate(`(async () => {
    const input = document.querySelector('.editor input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Prueba')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 150))
    input.dispatchEvent(new Event('focusout', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    return document.querySelector('.editor header strong').textContent
  })()`)
  check('renaming it', renamed === 'Prueba', renamed)

  const bound = await evaluate(`(async () => {
    const select = [...document.querySelectorAll('.editor select')][0]
    const option = [...select.options].find(o => o.value !== '')
    if (!option) return 'no hay funciones'
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    const now = [...document.querySelectorAll('.editor select')][0]
    return now.value === option.value ? 'ok' : 'no quedó seleccionada: ' + now.value
  })()`)
  check('pointing it at a function', bound === 'ok', bound)
  await screenshot('03-bound')

  /* A refusal has to reach the operator rather than vanish into a console.
     Asked of the widget just created, so it does not depend on what else the
     project happens to contain: a button has no slider mode. */
  const refused = await evaluate(`(async () => {
    const id = document.querySelector('.editor .chip').textContent.split('#')[1].trim()
    const r = await fetch('/api/v1/vc/widgets/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sliderMode: 'Level' }),
    })
    return r.status + ' ' + (await r.json()).error
  })()`)
  check('a button refuses a slider mode', refused.startsWith('400'), refused)

  // That refusal is a 400, and the browser logs every 400 as a network error.
  // Forgetting it here is what keeps the check below about real surprises.
  consoleErrors.length = 0

  check('deleting it', (await click('Eliminar widget')) === 'ok')
  await sleep(1500)
  check('the widget is gone', (await count()) === before)
  await screenshot('04-deleted')

  /* Running a show, which is what a cue list is for. Back in run mode, because
     in edit mode a tap picks the widget rather than operating it. */
  const cues = await evaluate("document.querySelectorAll('.widget.cuelist').length")
  if (cues > 0) {
    check('leaving edit mode', (await click('Listo')) === 'ok')
    await sleep(600)

    const played = await evaluate(`(async () => {
      const list = document.querySelector('.widget.cuelist')
      const steps = list.querySelectorAll('.cuelist-steps li')
      if (steps.length < 2) return 'the cue list has ' + steps.length + ' cues'

      list.querySelector('[aria-label="Reproducir"]').click()
      await new Promise(r => setTimeout(r, 800))

      const at = () => [...list.querySelectorAll('.cuelist-steps li')]
        .findIndex(li => li.dataset.current === 'true')

      const first = at()
      if (first < 0) return 'no cue came up'

      list.querySelector('[aria-label="Siguiente"]').click()
      await new Promise(r => setTimeout(r, 800))
      const second = at()

      list.querySelector('[aria-label="Parar"]')?.click()
      await new Promise(r => setTimeout(r, 500))

      return second === first ? 'next did not advance from cue ' + first
           : at() >= 0 ? 'the list still shows a cue after stopping'
           : 'ok'
    })()`)
    check('the cue list runs and follows the show', played === 'ok', played)
    await screenshot('05-cuelist')
  }

  /* Functions: a console fires them, and this is where they come from. */
  check('the function list opens', (await click('Funciones')) === 'ok')
  await sleep(900)

  const built = await evaluate(`(async () => {
    const rows = () => document.querySelectorAll('.table-row').length
    const before = rows()

    const input = document.querySelector('.setup .card input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Escena de prueba')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 150))

    ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Crear').click()
    await new Promise(r => setTimeout(r, 1200))
    if (rows() !== before + 1) return 'the list did not grow: ' + before + ' -> ' + rows()

    // Created and selected, so its editor is open.
    const panel = document.querySelector('.setup article.card')
    if (!panel) return 'no editor opened for the new function'
    if (!panel.textContent.includes('Escena de prueba')) return 'the editor opened on ' + panel.textContent.slice(0, 40)

    // A brand new scene holds nothing, and says so rather than showing an
    // empty list that reads as an editor that failed to load.
    const empty = panel.textContent.includes('no mueve ningún canal')

    const add = [...panel.querySelectorAll('select')].find(s => s.options[0]?.textContent.startsWith('Añadir canal'))
    if (!add) return 'no channel picker'
    if (add.options.length < 2) return 'the channel picker is empty'

    // A select needs its own setter; the input one throws on one.
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    selectSetter.call(add, add.options[1].value)
    add.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1400))

    const held = document.querySelectorAll('.setup article.card .channels li').length
    return empty && held === 1 ? 'ok' : 'empty=' + empty + ' held=' + held
  })()`)
  check('a scene is created and given a channel', built === 'ok', built)
  await screenshot('06-functions')

  const removed = await evaluate(`(async () => {
    const before = document.querySelectorAll('.table-row').length
    ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Eliminar función').click()
    await new Promise(r => setTimeout(r, 1400))
    const after = document.querySelectorAll('.table-row').length
    return after === before - 1 ? 'ok' : before + ' -> ' + after
  })()`)
  check('and deleted again', removed === 'ok', removed)

  /* The five types whose bodies had no read side at all until now. Created,
     edited and deleted by clicking, because an API nobody can reach from the
     browser is an API that is not finished. */
  const bodies = await evaluate(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const problems = []

    for (const [type, expect] of [['EFX', 'Patrón'], ['RGBMatrix', 'Algoritmo'],
                                  ['Script', 'Programa'], ['Audio', 'Archivo'],
                                  ['Video', 'Archivo o URL']]) {
      const kind = document.querySelector('.setup .card select')
      selectSetter.call(kind, type)
      kind.dispatchEvent(new Event('change', { bubbles: true }))

      const nameField = document.querySelector('.setup .card input')
      setter.call(nameField, 'Prueba ' + type)
      nameField.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 100))

      ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Crear').click()
      await new Promise(r => setTimeout(r, 1400))

      const panel = document.querySelector('.setup article.card')
      if (!panel) { problems.push(type + ': no editor'); continue }
      if (panel.textContent.includes('no es legible') || /not readable/.test(panel.textContent)) {
        problems.push(type + ': reported as unreadable')
      }
      if (!panel.textContent.includes(expect)) {
        problems.push(type + ': no "' + expect + '" field')
      }

      /* An Audio function has to say where it will play. Either it offers the
         outputs, or it says why there are none -- what it must not do is show a
         file field and a volume slider and leave the rest to hope. */
      if (type === 'Audio') {
        const devices = await (await fetch('/api/v1/audio')).json()
        const offered = [...panel.querySelectorAll('select')]
          .some(s => [...s.options].some(o => devices.outputs.includes(o.value)))

        if (devices.canPlay && !offered) problems.push('Audio: no output picker')
        if (!devices.canPlay && !panel.textContent.includes(devices.silentBecause.slice(0, 20))) {
          problems.push('Audio: cannot play and does not say why')
        }
      }

      ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Eliminar función').click()
      await new Promise(r => setTimeout(r, 1200))
    }

    return problems.length === 0 ? 'ok' : problems.join('; ')
  })()`)
  check('every editable type has an editor', bodies === 'ok', bodies)
  await screenshot('06b-bodies')

  /* The patch: universes, their output, and the fixtures in them. This is what
     makes light come out, and until now none of it was reachable from a
     browser at all. */
  check('the patch opens', (await click('Patch')) === 'ok')
  await sleep(1200)

  const universes = await evaluate(
    "document.querySelectorAll('.setup .card > header .chip').length",
  )
  check('universes are listed', universes > 0, `${universes}`)

  // 512 slots, and the ones a fixture holds are coloured. A clash shows up
  // here before it shows up as a light that will not respond.
  const mapped = await evaluate(`(async () => {
    const link = [...document.querySelectorAll('.linkish')][0]
    if (!link) return 'no channel map link'
    link.click()
    await new Promise(r => setTimeout(r, 900))
    const cells = document.querySelectorAll('.channelmap span').length
    const held = document.querySelectorAll('.channelmap span[data-held="true"]').length
    return cells === 512 ? 'ok ' + held + ' held' : cells + ' cells'
  })()`)
  check('the channel map shows 512 channels', mapped.startsWith('ok'), mapped)
  await screenshot('06-patch')

  const patched = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Fixtures'))
    if (!tab) return 'no fixtures tab'
    tab.click()
    await new Promise(r => setTimeout(r, 700))

    const rows = document.querySelectorAll('.table-row').length
    document.querySelector('details.card').open = true
    await new Promise(r => setTimeout(r, 1500))

    const makers = document.querySelectorAll('.setup details select')[0]?.options.length ?? 0
    return rows > 0 && makers > 10 ? 'ok' : rows + ' fixtures, ' + makers + ' manufacturers'
  })()`)
  check('the fixture list and the library are there', patched === 'ok', patched)

  const grouped = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Grupos'))
    if (!tab) return 'no groups tab'
    tab.click()
    await new Promise(r => setTimeout(r, 700))

    const before = document.querySelectorAll('.setup article.card').length

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const input = document.querySelector('.setup .card input')
    setter.call(input, 'Grupo de prueba')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 100))

    ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Crear grupo').click()
    await new Promise(r => setTimeout(r, 1300))
    if (document.querySelectorAll('.setup article.card').length !== before + 1) {
      return 'the group did not appear'
    }

    /* The one just made, which is the last: a project may already have groups,
       and the first one's picker is empty when it already holds everything. */
    const cards = [...document.querySelectorAll('.setup article.card')]
    const mine = cards[cards.length - 1]
    const add = [...mine.querySelectorAll('select')]
      .find(s => s.options[0]?.textContent.startsWith('Añadir fixture'))
    if (!add || add.options.length < 2) return 'no fixture picker in the new group'

    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    selectSetter.call(add, add.options[1].value)
    add.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1300))

    const refreshed = [...document.querySelectorAll('.setup article.card')]
    const last = refreshed[refreshed.length - 1]
    const members = last.querySelectorAll('.channels li').length
    ;[...last.querySelectorAll('button')].find(b => b.textContent.trim() === 'Eliminar').click()
    await new Promise(r => setTimeout(r, 1200))

    return members >= 1 ? 'ok' : 'the fixture did not join the group'
  })()`)
  check('fixture groups can be built from the browser', grouped === 'ok', grouped)
  await screenshot('07-fixtures')

  /* Channels groups, which are a different thing with a similar name: one
     fader over channels picked one at a time. Two selects rather than one --
     fixture, then channel -- because a rig of thirty movers is nine hundred
     channels, and the second one is filled in from the fixture definition
     after a round trip. That asynchrony is the part worth driving in a real
     browser rather than asserting over HTTP. */
  const channelGrouped = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Canales'))
    if (!tab) return 'no channels tab'
    tab.click()
    await new Promise(r => setTimeout(r, 700))

    const cards = () => [...document.querySelectorAll('.setup article.card')]
    const before = cards().length

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const input = document.querySelector('.setup .card input')
    setter.call(input, 'Canales de prueba')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 100))

    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const pick = async (select, index) => {
      selectSetter.call(select, select.options[index].value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 900))
    }

    const fixturePicker = [...document.querySelectorAll('.setup .card select')]
      .find(s => s.options[0]?.textContent.startsWith('Crear con este canal'))
    if (!fixturePicker || fixturePicker.options.length < 2) return 'no fixture picker'
    await pick(fixturePicker, 1)

    /* The channel select only exists once a fixture is chosen, and is empty
       until its channel list has arrived. */
    const channelPicker = [...document.querySelectorAll('.setup .card select')]
      .find(s => s.getAttribute('aria-label') === 'Canal')
    if (!channelPicker) return 'the channel picker never appeared'
    if (channelPicker.options.length < 2) return 'the channel picker stayed empty'
    if (!/^1\./.test(channelPicker.options[1].textContent)) {
      return 'the channels are not named: ' + channelPicker.options[1].textContent
    }
    await pick(channelPicker, 1)
    await new Promise(r => setTimeout(r, 800))

    if (cards().length !== before + 1) return 'the group did not appear'

    const mine = cards()[cards().length - 1]
    const fader = mine.querySelector('.group-fader input[type=range]')
    if (!fader) return 'the group has no fader'
    if (fader.disabled) return 'the fader is disabled on a group that should work'
    if (mine.querySelectorAll('.channels li').length !== 1) return 'the channel is not listed'

    /* Moving it. What reaches the rig is asserted over DMX elsewhere; here the
       question is only whether the control is wired to anything at all. */
    setter.call(fader, '200')
    fader.dispatchEvent(new Event('input', { bubbles: true }))
    fader.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    const shown = mine.querySelector('.fader-value')?.textContent ?? ''
    if (!shown.startsWith('78')) return 'the fader did not move: ' + shown

    ;[...mine.querySelectorAll('button')].find(b => b.textContent.trim() === 'Eliminar').click()
    await new Promise(r => setTimeout(r, 1200))

    return cards().length === before ? 'ok' : 'the group did not go away'
  })()`)
  check('channels groups can be built from the browser', channelGrouped === 'ok', channelGrouped)

  /* Channel modifiers: the curve a channel's values pass through on the way
     out. Driven here because the panel is three round trips deep -- open the
     fixture, read its channels, read the curve of whatever is attached -- and
     each of them can fail in a way that leaves a control that looks operable. */
  const curved = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('Fixtures'))
    if (!tab) return 'no fixtures tab'
    tab.click()
    await new Promise(r => setTimeout(r, 700))

    const row = document.querySelector('.table-row')
    if (!row) return 'no fixtures in this project'

    const toggle = [...row.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('∿'))
    if (!toggle) return 'no curves button'
    toggle.click()
    await new Promise(r => setTimeout(r, 1200))

    const panel = document.querySelector('.modifiers')
    if (!panel) return 'the panel never opened'

    const rows = panel.querySelectorAll('.channels li')
    if (rows.length === 0) return 'the panel lists no channels'

    const select = panel.querySelector('select')
    if (!select) return 'no modifier picker'
    const invert = [...select.options].find(o => o.value === 'Invert')
    if (!invert) return 'the templates did not load: ' + [...select.options].map(o => o.value).join(',')

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'Invert')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1600))

    const after = document.querySelector('.modifiers')
    if (!after) return 'the panel closed itself'
    if (after.querySelector('select').value !== 'Invert') return 'the modifier did not stick'

    /* Drawn, not merely named: the shape is the only thing that tells
       Exponential Medium from Exponential Deep. */
    const curve = after.querySelector('svg.curve polyline')
    if (!curve) return 'the curve was not drawn'
    const points = curve.getAttribute('points').split(' ')
    if (points.length !== 256) return 'the curve has ' + points.length + ' points'

    // Invert: the first point is at the top of the box and the last at the bottom.
    const y = p => Number(p.split(',')[1])
    if (!(y(points[0]) < 1 && y(points[255]) > 99)) {
      return 'the curve drawn is not the one chosen: ' + points[0] + ' .. ' + points[255]
    }

    setter.call(select, '')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1600))

    const cleared = document.querySelector('.modifiers select')
    return cleared && cleared.value === '' ? 'ok' : 'it could not be taken off again'
  })()`)
  check('channel modifiers can be attached from the browser', curved === 'ok', curved)

  /* The show manager. Driven in a real browser because the interesting part is
     a pointer drag: a bar follows the finger optimistically and the move is
     committed on release, and the whole design rests on a refusal putting it
     back where it was. */
  await click('Funciones')
  await sleep(900)

  const timeline = await evaluate(`(async () => {
    const open = [...document.querySelectorAll('.table-row .linkish')].find(b => b.textContent.trim() === 'Pase')
    if (!open) return 'none'      // this project has no show
    open.click()
    await new Promise(r => setTimeout(r, 1200))

    const timeline = document.querySelector('.timeline')
    if (!timeline) return 'the timeline never opened'

    const bars = () => [...document.querySelectorAll('.timeline .bar')]
    if (bars().length !== 2) return 'expected two bars, got ' + bars().length
    if (!bars()[0].textContent.includes('Rojo')) return 'the bars are not labelled: ' + bars()[0].textContent

    /* Second bar starts at 800 ms. At the default zoom of 60 px/s that is
       48 px from the left, and the two must not be drawn on top of each other. */
    const left = b => Number.parseFloat(b.style.left)
    if (!(left(bars()[1]) > left(bars()[0]))) {
      return 'the bars are drawn in the wrong order: ' + left(bars()[0]) + ' / ' + left(bars()[1])
    }

    // Drag the second bar to the right by 120 px, which is two seconds.
    const bar = bars()[1]
    const before = left(bar)
    const box = bar.getBoundingClientRect()
    const at = (type, x) => bar.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, clientX: x, clientY: box.top + box.height / 2,
    }))

    // setPointerCapture on a synthetic pointer id throws in some builds; the
    // component only needs the events, so make it a no-op for this run.
    bar.setPointerCapture = () => {}

    /* No pause between these on purpose. The handlers keep the live drag in a
       ref, so a pointermove that arrives before React has committed the
       pointerdown still counts -- and a short quick drag that begins and ends
       inside one frame is not silently dropped. */
    at('pointerdown', box.left + 10)
    at('pointermove', box.left + 70)
    at('pointermove', box.left + 130)

    /* React batches pointermove, so the commit lands after the handler
       returns; reading synchronously would test the scheduler, not the drag. */
    await new Promise(r => setTimeout(r, 80))

    // Optimistic: it must have moved before anything was sent.
    const during = left(bars()[1])
    at('pointerup', box.left + 130)
    await new Promise(r => setTimeout(r, 1500))

    if (!(during > before)) {
      return 'the bar did not follow the pointer: ' + before + ' -> ' + during
        + ' dragging=' + bars()[1].getAttribute('data-dragging')
        + ' props=' + Object.keys(bar[Object.keys(bar).find(k => k.startsWith('__reactProps'))] || {}).join(',')

    }

    const after = bars()[1]
    if (!after) return 'the bar vanished'
    if (Math.abs(left(after) - (before + 120)) > 8) {
      return 'the move did not stick: ' + before + ' -> ' + left(after)
    }

    // And the daemon agrees, which is the half a drawing cannot fake.
    const body = await (await fetch('/api/v1/functions/3/body')).json()
    const moved = body.tracks[0].functions.find(f => f.name === 'Verde')
    if (!moved || moved.start !== 2800) return 'the daemon has it at ' + moved?.start

    // Put it back, so the project is where the next assertion expects it.
    await fetch('/api/v1/functions/3/items/' + moved.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: 800 }),
    })
    await new Promise(r => setTimeout(r, 900))

    /* And a move onto another bar says so before the finger comes up.
     *
       The daemon refuses overlaps and remains the authority; what is checked
       here is that the refusal is visible while there is still time to do
       something about it, and that letting go there quietly does nothing
       instead of firing a request that will bounce. */
    const both = bars()
    if (both.length !== 2) return 'expected the two bars back, got ' + both.length

    const second = both[1]
    const target = both[0].getBoundingClientRect()
    const secondBox = second.getBoundingClientRect()
    second.setPointerCapture = () => {}
    const onto = (type, x) => second.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 3, clientX: x, clientY: secondBox.top + secondBox.height / 2,
    }))

    const startedAt = left(second)
    onto('pointerdown', secondBox.left + 10)
    onto('pointermove', target.left + 12)
    await new Promise(r => setTimeout(r, 120))

    const dragging = bars()[1]
    if (dragging.getAttribute('data-blocked') !== 'true') {
      return 'the overlap was not shown while dragging'
    }
    if (!dragging.textContent.includes('choca con')) {
      return 'the bar does not name what it would hit: ' + dragging.textContent
    }
    if (bars()[0].getAttribute('data-hit') !== 'true') {
      return 'the bar being landed on is not marked'
    }

    onto('pointerup', target.left + 12)
    await new Promise(r => setTimeout(r, 900))

    if (Math.abs(left(bars()[1]) - startedAt) > 2) {
      return 'letting go over another bar moved it anyway'
    }

    const still = await (await fetch('/api/v1/functions/3/body')).json()
    const verde = still.tracks[0].functions.find(f => f.name === 'Verde')
    if (verde.start !== 800) return 'the daemon has it at ' + verde.start

    return 'ok'
  })()`)
  check('a show timeline can be dragged in the browser', timeline === 'none' || timeline === 'ok', timeline)

  /* Audio: what this machine can listen to and play through.
   *
   * The panel used to say flatly that audio never sounds -- true of the
   * AppImage and false of any machine with a sound server, which is the worst
   * kind of message an interface can carry. Now it asks the daemon, so the test
   * asks the daemon too and checks the screen agrees with it. */
  await click('Patch')
  await sleep(900)

  const sound = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'Audio')
    if (!tab) return 'no audio tab'
    tab.click()
    await new Promise(r => setTimeout(r, 900))

    const cards = [...document.querySelectorAll('.setup article.card')]
    if (cards.length < 2) return 'expected an input card and an output card, got ' + cards.length

    const devices = await (await fetch('/api/v1/audio')).json()
    const shown = document.querySelector('.setup').textContent

    /* The chip is compared exactly, not by substring: "no puede sonar"
       contains "puede sonar", so a panel wired to say the wrong thing passed a
       looser check. */
    const chips = [...document.querySelectorAll('.setup .chip')].map(c => c.textContent.trim())
    const expected = devices.canPlay ? 'puede sonar' : 'no puede sonar'
    if (!chips.includes(expected)) {
      return 'the daemon says ' + expected + ' and the chips say ' + chips.join('/')
    }

    if (devices.canPlay) {
      for (const out of devices.outputs) {
        if (!shown.includes(out)) return 'output missing from the screen: ' + out
      }
    } else {
      if (!devices.silentBecause) return 'the daemon does not say why it cannot play'
      if (!shown.includes(devices.silentBecause.slice(0, 30))) return 'the reason is not on the screen'
    }

    /* The input picker: it exists in the API and nothing offered it until now.
       A control that is not there is not a control. */
    const picker = [...document.querySelectorAll('.setup select')]
      .find(s => [...s.options].some(o => o.value === devices.selected))
    if (devices.inputs.length > 0 && !picker) return 'no input picker for ' + devices.inputs.length + ' inputs'
    if (devices.inputs.length === 0 && !shown.includes('ninguna entrada')) {
      return 'no inputs and the screen does not say so'
    }

    return 'ok'
  })()`)
  check('the audio panel says what the daemon says', sound === 'ok', sound)

  /* The plan. The one assertion worth the whole screen: light a lamp and see
     the marker turn that colour, then put it out and see it go dark. Everything
     else about a plan can be checked over HTTP; this cannot, because the colour
     is computed in the browser from the DMX frames. */
  await click('Planta')
  await sleep(1200)

  const litUp = await evaluate(`(async () => {
    const stage = document.querySelector('.plan-stage')
    if (!stage) return 'the plan never opened'

    /* Nothing is placed in these projects, so the tray is where the fixtures
       are. Putting one on the stage is also the quickest way to check that
       path works. */
    const tray = [...document.querySelectorAll('.tray-item')]
    const barra = tray.find(b => b.textContent.trim() === 'Barra')
    if (!barra) return 'none'          // this project has no RGBW bar
    barra.click()
    await new Promise(r => setTimeout(r, 1200))

    const lamp = document.querySelector('.lamp[data-fixture="2"]')
    if (!lamp) return 'the fixture did not land on the stage'

    /* A channel with a modifier on it is not at 0 when nothing drives it: an
       inverted red at rest puts 255 on the wire, and the plan drawing that lamp
       red is the plan being right. So the rest of this only means anything on a
       fixture with no curves in the way. */
    const detail = await (await fetch('/api/v1/fixtures/2')).json()
    if (detail.channelList.some(c => c.modifier)) return 'none'

    if (lamp.getAttribute('data-dark') !== 'true') {
      return 'a lamp that is off should be drawn dark, not ' + lamp.style.background
    }

    /* Light it. "Rojo" is a scene holding the bar's red channel at full. */
    const functions = await (await fetch('/api/v1/functions')).json()
    const red = functions.find(f => f.name === 'Rojo')
    if (!red) return 'none'
    await fetch('/api/v1/functions/' + red.id + '/start', { method: 'POST' })
    await new Promise(r => setTimeout(r, 1400))

    const after = document.querySelector('.lamp[data-fixture="2"]')
    const shown = after.style.background
    if (after.getAttribute('data-dark') === 'true') {
      return 'the lamp stayed dark while the scene was up'
    }
    /* Exactly red: the bar's red channel is at full and nothing else is, so
       anything with green or blue in it means the roles are wrong. */
    if (shown.split(' ').join('') !== 'rgb(255,0,0)') {
      return 'expected red, drew ' + shown
    }

    await fetch('/api/v1/functions/' + red.id + '/stop', { method: 'POST' })
    await new Promise(r => setTimeout(r, 1400))

    const out = document.querySelector('.lamp[data-fixture="2"]')
    if (out.getAttribute('data-dark') !== 'true') {
      return 'the lamp stayed lit after the scene stopped: ' + out.style.background
    }

    // And the position it was given is the daemon's, not just the browser's.
    const plan = await (await fetch('/api/v1/plan')).json()
    const placed = plan.fixtures.find(f => f.id === 2)
    if (placed?.x === undefined) return 'the daemon does not have it placed'

    await fetch('/api/v1/plan/fixtures/2', { method: 'DELETE' })
    return 'ok'
  })()`)
  check('the plan shows what each lamp is doing', litUp === 'none' || litUp === 'ok', litUp)

  /* And the plan as a place to work: choose lamps, act on them, read the wire.
   *
     This is the assertion the whole direction rests on. A colour picker over a
     drawing of a rig is a toy; the same picker that moves DMX is a desk. The
     only way to tell them apart from outside is to look at the wire. */
  const worked = await evaluate(`(async () => {
    const plan = await (await fetch('/api/v1/plan')).json()
    const bar = plan.fixtures.find(f => f.roles.red !== undefined)
    if (!bar) return 'none'          // nothing here mixes colour

    /* A channel with a curve on it does not put out what was asked for -- an
       inverted red at 255 is 0 on the wire -- and the plan drawing that is the
       plan being right. The numbers below only mean anything without one. */
    const detail = await (await fetch('/api/v1/fixtures/' + bar.id)).json()
    if (detail.channelList.some(c => c.modifier)) return 'none'

    /* Place it and then make the screen re-read the plan, rather than depending
       on whatever the block before left behind. */
    await fetch('/api/v1/plan/fixtures/' + bar.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 2000, y: 2000 }),
    })

    const rail = (name) => [...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === name)
    if (!rail('Patch')) {
      return 'no rail here; items: '
        + [...document.querySelectorAll('.rail-item')].map(b => JSON.stringify(b.textContent)).join(',')
        + ' operator: ' + document.querySelector('.app')?.getAttribute('data-operator')
    }
    rail('Patch').click()
    await new Promise(r => setTimeout(r, 700))
    rail('Planta').click()
    await new Promise(r => setTimeout(r, 1200))

    const find = () => document.querySelector('.lamp[data-fixture="' + bar.id + '"]')
    const lamp = find()
    if (!lamp) return 'the lamp is not on the stage'

    const box = lamp.getBoundingClientRect()
    const tap = (type, x, y) => lamp.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 7, clientX: x, clientY: y,
    }))

    /* A tap chooses; it must not move the lamp. */
    const before = lamp.style.left
    tap('pointerdown', box.left + box.width / 2, box.top + box.height / 2)
    tap('pointerup', box.left + box.width / 2, box.top + box.height / 2)
    await new Promise(r => setTimeout(r, 500))

    const chosen = find()
    if (!chosen) {
      return 'the lamp went away after the tap; on stage: '
        + [...document.querySelectorAll('.lamp')].map(l => l.dataset.fixture).join(',')
        + ' tray: ' + [...document.querySelectorAll('.tray-item')].map(t => t.textContent.trim()).join(',')
    }
    if (chosen.getAttribute('data-chosen') !== 'true') return 'the tap did not choose it'
    if (chosen.style.left !== before) return 'the tap moved it'

    const panel = document.querySelector('.selection')
    if (!panel) return 'no panel for the chosen lamp'
    if (!panel.textContent.includes(bar.name)) return 'the panel does not name it'

    /* Full intensity first, or a colour would be scaled to nothing. */
    const level = panel.querySelector('input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(level, '255')
    level.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 700))

    /* Then a colour, and the wire has to carry it. */
    const swatches = [...panel.querySelectorAll('.swatch')]
    const red = swatches.find(sw => sw.getAttribute('aria-label') === 'Poner #ff2d2d')
    if (!red) return 'no red swatch'
    red.click()
    await new Promise(r => setTimeout(r, 900))

    const live = await (await fetch('/api/v1/live')).json()
    const held = new Map(live.values.filter(v => v.fixture === bar.id).map(v => [v.channel, v.value]))
    if (held.get(bar.roles.red) !== 0xff) return 'red is not held: ' + JSON.stringify(live.values)
    if (held.get(bar.roles.green) !== 0x2d) return 'green is wrong: ' + held.get(bar.roles.green)
    if (bar.roles.white !== undefined && held.get(bar.roles.white) !== 0) {
      return 'the white was left up, so that is pink'
    }

    /* And the lamp on screen agrees, which is the loop closing: the same roles
       that resolved the colour into channels read it back off the frame. */
    let painted = ''
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 120))
      painted = document.querySelector('.lamp[data-fixture="' + bar.id + '"]').style.background
      /* split/join rather than a regex: inside this template literal a
         backslash-s collapses to the letter s, so /\s/ strips letters and
         nothing else. It has cost two assertions already. */
      if (painted.split(' ').join('') === 'rgb(255,45,45)') break
    }
    if (painted.split(' ').join('') !== 'rgb(255,45,45)') {
      return 'the lamp does not show what it is putting out: ' + painted
    }

    /* Letting go puts the channels down rather than leaving them latched. */
    ;[...panel.querySelectorAll('button')].find(b => b.textContent.trim() === 'Soltar').click()
    await new Promise(r => setTimeout(r, 900))
    const after = await (await fetch('/api/v1/live')).json()
    if (after.values.length !== 0) return 'letting go held on to ' + after.values.length

    /* Tapping again lets the lamp go. */
    const still = document.querySelector('.lamp[data-fixture="' + bar.id + '"]')
    const b2 = still.getBoundingClientRect()
    still.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, clientX: b2.left + 4, clientY: b2.top + 4 }))
    still.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8, clientX: b2.left + 4, clientY: b2.top + 4 }))
    await new Promise(r => setTimeout(r, 500))
    if (document.querySelector('.selection')) return 'tapping it again did not let it go'

    await fetch('/api/v1/plan/fixtures/' + bar.id, { method: 'DELETE' })
    return 'ok'
  })()`)
  check('lamps can be chosen on the plan and driven from it', worked === 'none' || worked === 'ok', worked)

  /* The shell: where you are, and what is loaded.
   *
     The four views used to be four buttons in a row of nine, competing with
     the theme toggle and BLACKOUT for the same corner. They are navigation and
     they now live in a rail of their own; the bar above says which show is up
     and whether it has unsaved edits, which is the one question an operator
     with three shows on one daemon cannot answer from anywhere else. */
  const shell = await evaluate(`(async () => {
    const rail = document.querySelector('.rail')
    if (!rail) return 'no rail'

    /* Start from the console, because the two assertions below are about it. */
    const item = (name) => [...rail.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === name)
    item('Consola').click()
    await new Promise(r => setTimeout(r, 900))

    const items = [...rail.querySelectorAll('.rail-item')].map(b => b.textContent.trim())
    for (const view of ['Consola', 'Funciones', 'Patch', 'Planta']) {
      if (!items.includes(view)) return view + ' is not in the rail: ' + items.join('/')
    }

    /* Drawn icons, not emoji: one stroke width on one grid, taking the colour
       of the state they are in. */
    const glyphs = rail.querySelectorAll('.rail-item svg[stroke="currentColor"]')
    if (glyphs.length < 5) return 'the rail items are not drawn: ' + glyphs.length

    const here = [...rail.querySelectorAll('.rail-item')].filter(b => b.getAttribute('aria-pressed') === 'true')
    if (!here.some(b => b.textContent.trim() === 'Consola')) return 'the rail does not say where we are'

    /* The show bar names the show, and the daemon agrees. */
    const project = await (await fetch('/api/v1/project')).json()
    const stem = project.name.replace(/\.qxw$/i, '')
    const bar = document.querySelector('.showbar-id')
    if (!bar) return 'no show bar'
    if (!bar.textContent.includes(stem)) return 'the bar does not name the show: ' + bar.textContent

    /* Navigating from the rail works, and comes back. */
    const go = (name) => item(name).click()
    go('Patch')
    await new Promise(r => setTimeout(r, 900))
    if (!document.querySelector('.setup .tabs')) return 'the rail did not reach the patch'
    go('Consola')
    await new Promise(r => setTimeout(r, 900))
    if (!document.querySelector('main.console')) return 'the rail did not come back'

    return 'ok'
  })()`)
  check('the rail says where you are and the bar says what is loaded', shell === 'ok', shell)

  /* A label widget is a section heading. QLC+ has no other way to write one,
     so operators spell them "— MAESTRO —"; the dashes are a workaround for a
     missing feature, not part of the name. */
  const headings = await evaluate(`(async () => {
    const vc = await (await fetch('/api/v1/vc')).json()
    const walk = w => [w, ...(w.children ?? []).flatMap(walk)]
    const labels = walk(vc).filter(w => w.type === 'label' && (w.caption || '').trim())
    if (labels.length === 0) return 'none'

    const shown = [...document.querySelectorAll('.section')].map(h => h.textContent.trim())
    if (shown.length === 0) return 'no headings for ' + labels.length + ' labels'

    /* Drawn as a heading and not as a widget. */
    if ([...document.querySelectorAll('.widget.label')].length > 0) {
      return 'a label is still drawn as a widget'
    }

    /* And the decoration is gone from the ends without the name changing. */
    const dashed = labels.find(l => /^[\s\u2014\u2013-]/.test(l.caption))
    if (dashed) {
      const bare = dashed.caption.replace(/^[\s\u2014\u2013-]+|[\s\u2014\u2013-]+$/g, '')
      if (!shown.includes(bare)) return 'the dashes were not stripped: ' + shown.join(' / ')
      if (shown.includes(dashed.caption.trim())) return 'the heading kept its dashes'
    }
    return 'ok'
  })()`)
  check('a label reads as the section heading it always was', headings === 'none' || headings === 'ok', headings)

  /* Arranging by dragging, which is the gesture this console is used with far
     more than any other.
   *
     What is checked is the feedback, not just the result: a ghost under the
     finger, a caret where it would land, and the widget actually moving when it
     is let go. A drag that only reveals what it did after the fact is the thing
     this was rewritten to stop being. */
  check('back to the console to arrange it', (await click('Consola')) === 'ok')
  await sleep(800)
  check('arrange mode opens', (await click('Ordenar')) === 'ok')
  await sleep(600)

  const dragged = await evaluate(`(async () => {
    const widgets = () => [...document.querySelectorAll('.widget.arranging')]
    if (widgets().length < 2) return 'none'      // nothing to reorder

    /* By id, not by caption. In Sample.qxw the top level is four frames all
       captioned the same, so comparing the text said nothing had moved when it
       had -- and would have said nothing had moved if it had not, too. */
    const order = () => widgets().map(w => w.dataset.widgetId).join('|')
    if (widgets().some(w => !w.dataset.widgetId)) return 'none'   // a console with no ids
    const before = order()

    const first = widgets()[0]
    const last = widgets()[widgets().length - 1]
    const from = first.getBoundingClientRect()
    const to = last.getBoundingClientRect()

    first.setPointerCapture = () => {}
    const at = (type, x, y) => first.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, clientX: x, clientY: y,
    }))

    at('pointerdown', from.left + 10, from.top + 10)

    /* Under the threshold: nothing has begun, and the sticky path is still on
       the table. A tap that trembles must not turn into a drag. */
    at('pointermove', from.left + 13, from.top + 12)
    await new Promise(r => setTimeout(r, 60))
    if (document.querySelector('.ghost')) return 'a 3px tremble started a drag'

    // Past it: the ghost appears and follows.
    at('pointermove', from.left + 60, from.top + 30)
    await new Promise(r => setTimeout(r, 80))
    const ghost = document.querySelector('.ghost')
    if (!ghost) return 'no ghost once the drag began'
    if (ghost.textContent.trim() !== first.textContent.trim()) {
      return 'the ghost is not the widget: ' + ghost.textContent.trim()
    }
    const firstAt = ghost.getBoundingClientRect().left

    at('pointermove', to.right - 8, to.top + to.height / 2)
    await new Promise(r => setTimeout(r, 80))
    if (document.querySelector('.ghost').getBoundingClientRect().left <= firstAt) {
      return 'the ghost did not follow the pointer'
    }

    /* And the caret says where it would land -- in the place it would land,
       which is the whole point of it. Two positions, because there are two
       carets in the markup and one of them would otherwise never be looked at:
       the one drawn before a widget, and the one at the end of a row. */
    const caretX = () => {
      const c = document.querySelector('.caret')
      return c ? c.getBoundingClientRect().left : null
    }

    at('pointermove', to.left + 4, to.top + to.height / 2)
    await new Promise(r => setTimeout(r, 90))
    const beforeLast = caretX()
    if (beforeLast === null) return 'no caret on the left half of a widget'
    if (beforeLast > to.left + 12) return 'the caret is not in front of that widget'

    at('pointermove', to.right - 8, to.top + to.height / 2)
    await new Promise(r => setTimeout(r, 90))
    const afterLast = caretX()
    if (afterLast === null) return 'no caret past the middle of a widget'
    if (!(afterLast > beforeLast)) {
      return 'the caret did not move with the pointer: ' + beforeLast + ' -> ' + afterLast
    }

    at('pointerup', to.right - 8, to.top + to.height / 2)
    await new Promise(r => setTimeout(r, 500))

    if (document.querySelector('.ghost')) return 'the ghost outlived the drop'
    if (document.querySelector('.caret')) return 'the caret outlived the drop'

    const after = order()
    if (after === before) return 'the widget did not move: ' + after
    if (!after.endsWith(first.dataset.widgetId)) {
      return 'it did not land at the end: ' + before + ' -> ' + after
    }

    /* Escape puts a drag back, which is what makes one safe to start. */
    const other = widgets()[0]
    other.setPointerCapture = () => {}
    const box = other.getBoundingClientRect()
    const on = (type, x, y) => other.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 2, clientX: x, clientY: y,
    }))
    on('pointerdown', box.left + 10, box.top + 10)
    on('pointermove', box.left + 90, box.top + 10)
    await new Promise(r => setTimeout(r, 80))
    if (!document.querySelector('.ghost')) return 'the second drag never began'

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    if (document.querySelector('.ghost')) return 'Escape did not cancel the drag'
    if (order() !== after) return 'Escape moved something'

    return 'ok'
  })()`)
  check('a widget can be dragged into place', dragged === 'none' || dragged === 'ok', dragged)

  check('leaving arrange mode', (await click('Listo')) === 'ok')
  await sleep(500)

  /* Appearance, edited from the browser. Cosmetic on a desk is not decoration:
     a colour bank where every button is grey is one nobody can use in the dark,
     and until now these were the one thing this daemon could read and could not
     change. */
  check('back to the console for the appearance', (await click('Consola')) === 'ok')
  await sleep(800)
  check('edit mode opens again', (await click('Editar')) === 'ok')
  await sleep(600)

  const painted = await evaluate(`(async () => {
    const widget = document.querySelector('.widget')
    if (!widget) return 'no widgets'
    widget.click()
    await new Promise(r => setTimeout(r, 900))

    const panel = document.querySelector('.editor')
    if (!panel) return 'the editor never opened'

    const appearance = panel.querySelector('details.appearance')
    if (!appearance) return 'no appearance panel'
    appearance.open = true

    const colour = appearance.querySelector('input[type=color]')
    if (!colour) return 'no colour picker'

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(colour, '#ff8800')
    colour.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1500))

    /* The daemon is the one that has to agree. A picker that shows orange
       while the file says nothing is exactly the failure this whole codebase
       is arranged against. */
    const vc = await (await fetch('/api/v1/vc')).json()
    const walk = w => [w, ...(w.children ?? []).flatMap(walk)]
    const painted = walk(vc).filter(w => w.background === '#ff8800')
    if (painted.length !== 1) return painted.length + ' widgets came back orange'

    /* And it reaches the screen, which is a different question: the console
       renders the colour through a custom property. */
    const drawn = [...document.querySelectorAll('.widget')]
      .find(w => w.style.getPropertyValue('--widget-bg') === 'rgb(255, 136, 0)'
              || w.style.getPropertyValue('--widget-bg') === '#ff8800')
    if (!drawn) return 'the colour did not reach the widget'

    /* Back to the default, which is not the same as picking a grey that
       matches: QLC+ writes "Default" and each theme renders it its own way. */
    const reset = [...appearance.querySelectorAll('button')]
      .find(b => b.textContent.includes('por defecto'))
    if (!reset) return 'no reset button'
    reset.click()
    await new Promise(r => setTimeout(r, 1500))

    const after = await (await fetch('/api/v1/vc')).json()
    if (walk(after).some(w => w.background === '#ff8800')) return 'the colour did not come off'

    return 'ok'
  })()`)
  check('a widget can be painted from the browser', painted === 'ok', painted)

  /* Edit mode, as a thing to use rather than a thing that works.
   *
     Three small absences that together make a screen feel stuck: nothing says
     what a tap will do now that it no longer fires the widget, the panel cannot
     be put away by tapping the space around it, and Escape does nothing. */
  const usable = await evaluate(`(async () => {
    if (!document.querySelector('.modehint')) return 'no line saying what this mode does'
    const said = document.querySelector('.modehint').textContent
    if (!said.includes('Escape')) return 'it does not mention the way out: ' + said

    const widget = document.querySelector('.widget.arranging')
    if (!widget) return 'no widgets'
    widget.click()
    await new Promise(r => setTimeout(r, 700))
    if (!document.querySelector('.editor')) return 'the panel did not open'
    if (widget.getAttribute('data-selected') !== 'true') return 'the widget is not marked chosen'

    /* Tapping the space around the widgets puts it away. */
    const console_ = document.querySelector('main.console')
    console_.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 4 }))
    await new Promise(r => setTimeout(r, 500))
    if (document.querySelector('.editor')) return 'tapping the background left the panel open'

    // And so does Escape.
    widget.click()
    await new Promise(r => setTimeout(r, 700))
    if (!document.querySelector('.editor')) return 'the panel did not reopen'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(r => setTimeout(r, 500))
    return document.querySelector('.editor') ? 'Escape did not close the panel' : 'ok'
  })()`)
  check('edit mode says what it does and can be put away', usable === 'ok', usable)

  check('leaving edit mode again', (await click('Listo')) === 'ok')
  await sleep(500)

  /* Two people on the same show. An edit made anywhere else has to arrive
     here, or the second phone is quietly showing a console that no longer
     exists -- and the first anyone finds out is mid-cue. */
  check('back to the console', (await click('Consola')) === 'ok')
  await sleep(700)

  const followed = await evaluate(`(async () => {
    /* Adding a widget from outside, exactly as another client would: nothing
       in this page asked for it, so only the broadcast can bring it here.
       Counting rather than reading a caption, because which widgets a console
       happens to show is the project's business. */
    /* Widgets and section headings both: a label arrives as a heading now,
       which is still it arriving. Counting only .widget missed it and read as
       the broadcast being broken. */
    const count = () => document.querySelectorAll('.widget, .section').length
    const before = count()

    const created = await (await fetch('/api/v1/vc/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'label', caption: 'Desde fuera', geometry: { y: 5000 } }),
    })).json()
    if (created.id === undefined) return 'the widget was not created: ' + JSON.stringify(created)

    let arrived = false
    for (let i = 0; i < 40 && !arrived; i++) {
      await new Promise(r => setTimeout(r, 100))
      arrived = count() === before + 1
    }

    // And away again, so the file comparison at the end still holds.
    await fetch('/api/v1/vc/widgets/' + created.id, { method: 'DELETE' })

    let gone = false
    for (let i = 0; i < 40 && !gone; i++) {
      await new Promise(r => setTimeout(r, 100))
      gone = count() === before
    }

    return arrived && gone ? 'ok'
         : !arrived ? 'it never appeared'
         : 'it appeared but never went'
  })()`)
  check('an edit made elsewhere arrives without a reload', followed === 'ok', followed)

  /* Frames, if this console has any. Drawn as an empty box until now, which on
     a console built out of frames meant most of the show was invisible. */
  const framed = await evaluate(`(async () => {
    const vc = await (await fetch('/api/v1/vc')).json()
    const walk = w => [w, ...(w.children ?? []).flatMap(walk)]

    // Frames inside a page, not the page itself.
    const nested = walk(vc)
      .filter(w => ['frame', 'soloframe'].includes(w.type))
      .filter(f => (f.children ?? []).length > 0)
      .slice(1)

    if (nested.length === 0) return 'none'

    const drawn = document.querySelectorAll('.widget.frame').length
    if (drawn === 0) return 'this console has ' + nested.length + ' frames and drew none'

    /* Whatever is inside them has to be on screen, not summarised as a box --
       except the pages a paged frame is not showing, which is the whole point
       of it having pages. */
    const inside = nested
      .flatMap(f => (f.children ?? []).filter(c => (f.pages ?? 0) < 2 || (c.page ?? 0) === (f.currentPage ?? 0)))
      .filter(c => c.caption)
    const showing = [...document.querySelectorAll('.widget')].map(w => w.textContent).join(' ')
    const missing = inside.filter(c => !showing.includes(c.caption))

    return missing.length === 0
      ? 'ok ' + drawn + ' frames, ' + inside.length + ' widgets inside'
      : missing.length + ' widgets are inside a frame and not on screen'
  })()`)
  check(
    'frames show what is in them',
    framed === 'none' || framed.startsWith('ok'),
    framed,
  )

  const paged = await evaluate(`(async () => {
    const vc = await (await fetch('/api/v1/vc')).json()
    const walk = w => [w, ...(w.children ?? []).flatMap(walk)]
    const frame = walk(vc).find(w => (w.pages ?? 0) > 1)
    if (!frame) return 'none'

    const onPage = n => (frame.children ?? []).filter(c => (c.page ?? 0) === n)
    const showing = () => [...document.querySelectorAll('.widget')].map(w => w.textContent).join(' ')

    const first = onPage(0).find(c => c.caption)
    const second = onPage(1).find(c => c.caption)
    if (!first || !second) return 'the paged frame has nothing to compare'

    // A reader that ignores Page draws both pages at once, which looks like one
    // page with twice the buttons.
    if (showing().includes(second.caption)) return 'page 2 is showing while page 1 is selected'

    const tab = [...document.querySelectorAll('.frame-pages button, .pages button')]
      .find(b => b.textContent.trim() === '2')
    if (!tab) return 'no page selector'
    tab.click()
    await new Promise(r => setTimeout(r, 500))

    return showing().includes(second.caption) && !showing().includes(first.caption)
      ? 'ok'
      : 'the page did not change'
  })()`)
  check('a paged frame shows one page at a time', paged === 'none' || paged === 'ok', paged)
  await screenshot('08-frames')

  /* A matrix widget, if this console has one: its fader and its preset bank. */
  const matrix = await evaluate(`(async () => {
    const el = document.querySelector('.widget.matrix')
    if (!el) return 'none'

    const buttons = el.querySelectorAll('.matrix-preset')
    if (buttons.length === 0) return 'the matrix has no presets on screen'

    // The kinds that are not buttons must be shown but not offered.
    const offered = [...buttons].filter(b => !b.disabled).length
    if (offered === buttons.length) return 'every preset is offered, including the knob'

    const fader = el.querySelector('input[type=range]')
    if (!fader) return 'no fader'

    return 'ok ' + offered + '/' + buttons.length + ' offered'
  })()`)
  check('a matrix widget shows its fader and presets', matrix === 'none' || matrix.startsWith('ok'), matrix)

  /* Operator mode, and the app installing.
   *
   * The phone this is for is taped to a truss and gets reopened by somebody who
   * did not put it there, so the mode has to survive a reload -- and everything
   * that edits has to be *gone from the markup*, not hidden with a class: a
   * control that is only invisible is still there for a stray tap. */
  const locked = await evaluate(`(async () => {
    const buttons = () => [...document.querySelectorAll('.showbar button, .rail button')]
      .map(b => b.textContent.trim())

    const enter = [...document.querySelectorAll('.showbar button')].find(b => b.textContent.trim() === 'Operador')
    if (!enter) return 'no operator button'
    enter.click()
    await new Promise(r => setTimeout(r, 600))

    const shown = buttons().join('|')
    for (const gone of ['Editar', 'Ordenar', 'Patch', 'Funciones', 'Planta']) {
      if (shown.includes(gone)) return gone + ' is still there in operator mode: ' + shown
    }
    if (document.querySelector('.app').getAttribute('data-operator') !== 'true') {
      return 'the app is not in operator mode'
    }

    /* And the console is still live: this is a mode that removes editing, not
       one that removes the desk. */
    if (document.querySelectorAll('.widget').length === 0) return 'the console went with it'

    return 'ok'
  })()`)
  check('operator mode leaves only the console', locked === 'ok', locked)

  /* Reloaded, because that is what happens to a phone left on a truss. */
  await send('Page.reload', {})
  await sleep(4000)

  const stuck = await evaluate(`(() => {
    const app = document.querySelector('.app')
    if (!app) return 'the app did not come back'
    if (app.getAttribute('data-operator') !== 'true') return 'operator mode did not survive a reload'
    return 'ok'
  })()`)
  check('and survives a reload', stuck === 'ok', stuck)

  /* Leaving takes a second of deliberate pressure. A tap is what a sleeve does;
     this is a guard against accidents and does not pretend to be a lock. */
  const released = await evaluate(`(async () => {
    const unlock = document.querySelector('.unlock')
    if (!unlock) return 'no unlock button'

    const at = type => unlock.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1 }))

    // A tap does nothing.
    at('pointerdown')
    at('pointerup')
    await new Promise(r => setTimeout(r, 400))
    if (document.querySelector('.app').getAttribute('data-operator') !== 'true') {
      return 'a tap got out of operator mode'
    }

    // A second of it does.
    at('pointerdown')
    await new Promise(r => setTimeout(r, 1400))
    at('pointerup')
    await new Promise(r => setTimeout(r, 400))

    if (document.querySelector('.app').getAttribute('data-operator') === 'true') {
      return 'holding did not get out'
    }
    const shown = [...document.querySelectorAll('.showbar button, .rail button')]
      .map(b => b.textContent.trim()).join('|')
    return shown.includes('Patch') ? 'ok' : 'the rest of the interface did not come back: ' + shown
  })()`)
  check('and takes a press and hold to leave', released === 'ok', released)

  /* Installable: the three files a browser needs at the root, served by the
     daemon itself. */
  const installable = await evaluate(`(async () => {
    const manifest = await fetch('/manifest.webmanifest')
    if (!manifest.ok) return 'no manifest: ' + manifest.status
    const parsed = await manifest.json()
    if (parsed.display !== 'standalone') return 'the manifest does not ask for standalone'
    if (!parsed.icons?.length) return 'the manifest names no icon'

    const icon = await fetch(parsed.icons[0].src)
    if (!icon.ok) return 'the icon the manifest names is not there'

    const worker = await fetch('/sw.js')
    if (!worker.ok) return 'no service worker'

    /* A service worker only controls paths under its own, so this one has to be
       at the root -- and the daemon has to serve it as script, or the browser
       refuses to register it. */
    const type = worker.headers.get('content-type') || ''
    if (!type.includes('javascript')) return 'the worker is served as ' + type

    return 'ok'
  })()`)
  check('the app can be installed to a home screen', installable === 'ok', installable)

  check('no errors in the console', consoleErrors.length === 0, consoleErrors.join(' | '))
} catch (error) {
  check('the run completed', false, error.message)
} finally {
  chrome.kill()
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nUI smoke test passed.')
process.exit(0)
