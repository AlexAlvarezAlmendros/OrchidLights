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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/* A fresh profile per run. Without one, headless Chrome keeps a default
   profile across runs and the app's service worker keeps serving whatever
   bundle it cached last time -- a broken build stays broken for every run
   after it, and a fixed one looks broken too. Found the hard way. */
const profile = mkdtempSync(join(tmpdir(), 'orchid-ui-'))

const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--user-data-dir=${profile}`,
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
      /* OUR page, not just any page: a stale headless Chrome squatting on the
         debug port serves its own about:blank, and a suite that connects to it
         fails every check against an app that is running fine. */
      const page = targets.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith(url),
      )
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

  /* JavaScript dialogs get answered, the way the human they are for would.
     Found the hard way: with unsaved edits and real user activation (the
     pointer-driven fader tests count), the beforeunload guard makes
     Page.reload raise a confirmation dialog -- and an unanswered dialog
     stalls the reload's own response, hanging the suite at 900 s with no
     failure to read. Accepting is the choice the assertion needs; a test that
     wants the other answer can install its own handler. */
  if (message.method === 'Page.javascriptDialogOpening') {
    ws.send(
      JSON.stringify({
        id: nextId++,
        method: 'Page.handleJavaScriptDialog',
        params: { accept: true },
      }),
    )
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
// Without Page.enable the dialog-opening event never arrives, the answer
// below never runs, and a beforeunload dialog stalls every load after it.
await send('Page.enable')

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

/* A real pointer, driven through the browser rather than through the DOM.
 *
   This exists because of a bug that a synthetic test could not see: setting an
   input's value and firing a change event goes straight to React and works
   perfectly whatever shape the element is on screen. A leftover rule had left
   the range a 32-pixel square in the corner of its track, so every fader in the
   app answered on about a tenth of itself -- and the assertion that was
   supposed to guard exactly that passed, every run, because it never touched
   the thing with a pointer.

   Anything about whether a control can be *used* goes through here. */
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  })

async function dragAcross(box, from, to) {
  const y = box.y + box.height / 2
  const at = (f) => box.x + box.width * f
  await mouse('mousePressed', at(from), y)
  await sleep(100)
  await mouse('mouseMoved', at((from + to) / 2), y)
  await sleep(100)
  await mouse('mouseMoved', at(to), y)
  await sleep(150)
  await mouse('mouseReleased', at(to), y)
  await sleep(600)
}

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

  /* The whole chain, with a real pointer at one end and held channels at the
     other: press, drag, release on the intensity bar, then ask the daemon what
     it is holding.

     Everything else about faders in this suite drives the input through the
     DOM, and that is precisely the path a broken control still satisfies: for
     one release every fader in the app answered on a 32-pixel square in the
     corner of its own track, drew the right number, and no assertion moved.
     A pointer is the only thing that can tell the difference. */
  const grabbed = await evaluate(`(async () => {
    const plan = await (await fetch('/api/v1/plan')).json()
    const lit = (plan.fixtures ?? []).find(f => f.resolved && f.roles?.intensity !== undefined)
    if (!lit) return 'none'

    // Put it on the plan if it is not already, so there is a lamp to choose.
    if (lit.x === undefined || lit.x === null) {
      await fetch('/api/v1/plan/fixtures/' + lit.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 2, y: 2 }),
      })
      await new Promise(r => setTimeout(r, 900))
    }

    const lamp = document.querySelector('.lamp[data-fixture="' + lit.id + '"]')
    if (!lamp) return 'the lamp is not on the plan'
    const b = lamp.getBoundingClientRect()
    for (const type of ['pointerdown', 'pointerup']) {
      lamp.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 11, clientX: b.left + 4, clientY: b.top + 4,
      }))
    }
    await new Promise(r => setTimeout(r, 700))

    const track = document.querySelector('.selection .track')
    if (!track) return 'no intensity bar in the panel'
    const t = track.getBoundingClientRect()
    return JSON.stringify({ id: lit.id, channel: lit.roles.intensity,
      x: t.x, y: t.y, width: t.width, height: t.height })
  })()`)

  if (grabbed === 'none') {
    check('an intensity bar can be dragged with a pointer', true, 'none')
  } else {
    let held = grabbed
    try {
      const box = JSON.parse(grabbed)
      await dragAcross(box, 0.02, 0.6)
      held = await evaluate(`(async () => {
        const live = await (await fetch('/api/v1/live')).json()
        const value = live.values.find(v => v.fixture === ${box.id}
          && v.channel === ${box.channel})
        if (!value) return 'the drag held nothing at all'
        // 60% of the way along a 0-255 bar, give or take the thumb's own width.
        if (value.value < 120 || value.value > 175) return 'held ' + value.value + ', wanted ~153'
        await fetch('/api/v1/live', { method: 'DELETE' })
        return 'ok'
      })()`)
    } catch (error) {
      held = String(error).slice(0, 200)
    }
    check('an intensity bar can be dragged with a pointer', held === 'ok', held)
  }

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

  /* And the console is drawn as a screen rather than as somebody's pixel
     positions: sections, a grid of equal controls, faders in a column of their
     own. Their order survives it -- the grid flows in document order -- and so
     does every widget, which is the part that matters. */
  const drawn = await evaluate(`(async () => {
    const board = document.querySelector('.board')
    if (!board) return 'no board'

    const vc = await (await fetch('/api/v1/vc')).json()
    const walk = w => [w, ...(w.children ?? []).flatMap(walk)]
    const all = walk(vc).filter(w => w.type !== 'virtualconsole' && w.type !== 'frame')

    /* Nothing may be lost by regrouping. A console rearranged for display that
       drops a button is a console missing a cue on the night it matters. */
    const labels = all.filter(w => w.type === 'label' && (w.caption || '').trim())
    const others = all.filter(w => w.type !== 'label')
    /* Only the top level: what is inside a frame is drawn by the frame. */
    const top = [...document.querySelectorAll('.board .widget')]
      .filter(w => w.parentElement?.closest('.widget.frame') === null)
    const titles = document.querySelectorAll('.board .section').length

    /* Every top-level label is a heading. One inside a frame is that frame's,
       and is drawn by it. */
    const topLabels = labels.filter(l =>
      walk(vc).some(w => w === l) &&
      (vc.children ?? []).some(f => (f.children ?? []).includes(l) || f === l))
    if (labels.length > 0 && titles === 0) return 'no headings for ' + labels.length + ' labels'
    if (titles < topLabels.length) return 'headings: ' + titles + ' of ' + topLabels.length
    if (top.length === 0 && others.length > 0) return 'nothing was drawn'

    /* Faders live in the column, not in the grid.
     *
       Asked of the screen rather than of the project: a frame draws its own
       children with their own layout, so a fader inside one is that frame's
       business and never reaches a section. Counting every fader in the tree
       said the column was missing when it was simply not theirs. */
    const loose = [...document.querySelectorAll('.board .widget.fader')]
      .filter(f => f.closest('.widget.frame') === null)
    if (loose.length > 0) {
      if (!document.querySelector('.levels')) return 'no levels column for ' + loose.length + ' faders'
      if (loose.some(f => f.closest('.levels') === null)) return 'a fader is loose in the grid'
    }

    /* The drawn track has to cover its own control.
     *
       A range that is smaller than the bar drawn over it is a fader that
       answers on part of itself, and the part that does nothing looks exactly
       like the part that does. Measured rather than assumed -- this is the
       shape the pointer meets. */
    const bar = loose.find(f => f.getAttribute('data-usable') === 'true')
    if (bar) {
      const input = bar.querySelector('input[type=range]')
      const fill = bar.querySelector('.fill')
      if (!fill || !bar.querySelector('.thumb')) return 'the fader has no drawn track'
      if (getComputedStyle(input).opacity !== '0') return 'the range is drawn twice'

      const t = bar.querySelector('.track').getBoundingClientRect()
      const i = input.getBoundingClientRect()
      if (i.width < t.width - 4 || i.height < t.height - 4) {
        return 'the grab area is ' + Math.round(i.width) + 'x' + Math.round(i.height)
          + ' inside a ' + Math.round(t.width) + 'x' + Math.round(t.height) + ' track'
      }
    }

    /* Equal cards: the old flex rows stretched whatever was alone on a line,
       so two colours left over from a row of eight became half-width slabs. */
    const cards = [...document.querySelectorAll('.grid > .widget')]
    if (cards.length > 2) {
      const widths = new Set(cards.map(c => Math.round(c.getBoundingClientRect().width)))
      if (widths.size > 3) return 'the cards are ' + widths.size + ' different widths'
    }

    /* Arranging brings the operator's rows back, because rows are what is
       being arranged. */
    ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Ordenar')?.click()
    await new Promise(r => setTimeout(r, 700))
    if (document.querySelector('.board')) return 'arrange mode still draws the designed layout'
    if (!document.querySelector('.row')) return 'arrange mode lost the rows'
    ;[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Listo'))?.click()
    await new Promise(r => setTimeout(r, 700))
    if (!document.querySelector('.board')) return 'the designed layout did not come back'

    return 'ok'
  })()`)
  check('the console is drawn as sections, a grid and a column of faders', drawn === 'ok', drawn)

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

    /* And it reaches the screen, which is a different question.
     *
       Asking whether the custom property was set proves only that a string
       arrived somewhere; the operator's question is whether the colour is
       visible on the card. So this reads the pixels the stripe is actually
       painted with -- the pill on a button, the inset edge on anything else --
       and either one has to come back orange. */
    const drawn = [...document.querySelectorAll('.widget')]
      .find(w => w.style.getPropertyValue('--tint') === 'rgb(255, 136, 0)'
              || w.style.getPropertyValue('--tint') === '#ff8800')
    if (!drawn) return 'the colour did not reach the widget'

    const orange = 'rgb(255, 136, 0)'
    const pill = getComputedStyle(drawn, '::before').backgroundColor
    const edge = getComputedStyle(drawn).backgroundImage
    if (pill !== orange && !edge.includes(orange)) {
      return 'the colour is set but not drawn on .' + drawn.className
        + ': pill ' + pill + ', edge ' + edge
    }

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

  /* Every kind of widget shows the colour it was given.
   *
     The stripe is drawn as a background layer, which means any rule that sets
     the `background` shorthand on a widget erases it -- and a card with no
     stripe looks exactly like a card that was never given a colour, so there is
     nothing to notice. It has happened three times: on the selected widget in
     edit mode, on frames, on labels.

     Rather than wait for a project that happens to have a coloured one of each,
     this paints every widget on the screen and asks each of them back. The
     colour is put on and taken off in the browser; nothing is written to the
     project. */
  const striped = await evaluate(`(async () => {
    const orange = 'rgb(255, 136, 0)'
    const bare = new Set()
    let seen = 0

    const sweep = () => {
      const widgets = [...document.querySelectorAll('.widget')]
      seen += widgets.length
      for (const w of widgets) w.style.setProperty('--tint', orange)
      for (const w of widgets) {
        const pill = getComputedStyle(w, '::before').backgroundColor
        const edge = getComputedStyle(w).backgroundImage
        if (pill !== orange && !edge.includes(orange)) {
          bare.add(w.className.split(' ').filter(c => c !== 'widget').join('.') || 'widget')
        }
      }
      for (const w of widgets) w.style.removeProperty('--tint')
    }

    /* Both modes, because they do not draw the same set. A label is a section
       heading while the console is being run and only becomes a widget again
       while it is being arranged -- so a sweep of run mode alone never sees
       one, and a label was one of the three that lost its stripe. */
    sweep()
    const arrange = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Ordenar')
    if (arrange) {
      arrange.click()
      await new Promise(r => setTimeout(r, 900))
      sweep()
      const done = [...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Listo')
      if (done) done.click()
      await new Promise(r => setTimeout(r, 900))
    }

    if (seen === 0) return 'no widgets to look at'
    return bare.size === 0 ? 'ok' : [...bare].join(', ') + ' draw no stripe'
  })()`)
  check('every kind of widget shows the colour it was given', striped === 'ok', striped)

  /* The four button actions, each doing what its project says.
   *
     For one release all four were pressed as toggles: a Blackout button
     started function 4294967295, the daemon answered `error`, and the client
     dropped the message. Skips ('none') on projects without action buttons --
     vc-actions.qxw is the one that has them all. */
  const actions = await evaluate(`(async () => {
    const byCaption = (text) => [...document.querySelectorAll('.widget.button')]
      .find(b => b.textContent.trim() === text)
    const status = async () => (await (await fetch('/api/v1/status')).json())
    const wait = (ms) => new Promise(r => setTimeout(r, ms))

    /* Whatever an earlier test was doing, this one is about pressing, and
       pressing happens in run mode. */
    const done = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim().startsWith('Listo'))
    if (done) {
      done.click()
      await wait(800)
    }

    const flash = byCaption('Ráfaga')
    const black = byCaption('Apagón')
    const stopAll = byCaption('Todo quieto')
    if (!flash && !black && !stopAll) return 'none'
    if (!flash || !black || !stopAll) return 'only some action buttons drew'

    /* Flash: light while held, out on release. */
    const before = await status()
    flash.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 21 }))
    await wait(700)
    const during = await status()
    if (during.runningFunctions !== before.runningFunctions + 1) {
      return 'flash press did not start the scene: before=' + before.runningFunctions
        + ' during=' + during.runningFunctions + ' class=' + flash.className
    }
    flash.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21 }))
    await wait(700)
    if ((await status()).runningFunctions !== 0) return 'flash release left the scene running'

    /* Blackout: the desk goes dark, the button says so, and pressing it again
       brings the desk back -- the half that used to be impossible. */
    black.click()
    await wait(700)
    if ((await status()).blackout !== true) return 'the blackout button did not black out'
    if (black.getAttribute('aria-pressed') !== 'true') return 'blackout engaged but its button does not show it'
    black.click()
    await wait(700)
    if ((await status()).blackout !== false) return 'pressing it again did not release the blackout'

    /* Stop-all: everything running stops with one press. */
    const toggle = byCaption('Alterna')
    if (toggle) {
      toggle.click()
      await wait(700)
      if ((await status()).runningFunctions === 0) return 'could not start something to stop'
      stopAll.click()
      await wait(900)
      if ((await status()).runningFunctions !== 0) return 'stop-all left something running'
    }

    return 'ok'
  })()`)
  check('button actions act as their project says', actions === 'none' || actions === 'ok', actions)

  /* The top-bar blackout is a toggle that tells the truth on every screen. */
  const blackoutBar = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const find = () => [...document.querySelectorAll('.showbar button')]
      .find(b => b.textContent.includes('BLACKOUT') || b.textContent.includes('SALIR DE BLACKOUT'))
    const button = find()
    if (!button) return 'no blackout button in the bar'

    button.click()
    await wait(700)
    const engaged = await (await fetch('/api/v1/status')).json()
    if (engaged.blackout !== true) return 'the bar button did not engage blackout'
    if (!find().textContent.includes('SALIR')) return 'engaged, but the button still reads BLACKOUT'

    find().click()
    await wait(700)
    const released = await (await fetch('/api/v1/status')).json()
    if (released.blackout !== false) return 'could not leave blackout from the bar'
    if (find().textContent.includes('SALIR')) return 'released, but the button still reads SALIR'
    return 'ok'
  })()`)
  check('blackout can be entered and left from the bar', blackoutBar === 'ok', blackoutBar)

  /* The daemon's refusals reach the operator's eyes.
   *
     A press that does nothing and says nothing teaches the operator the desk
     is broken -- this exact class of message used to be dropped on the floor
     in the WS client. The trigger is real: a button whose function was
     deleted still draws (the console says it exists), pressing it is refused,
     and the refusal must surface. */
  const surfaced = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const toggle = [...document.querySelectorAll('.widget.button')]
      .find(b => b.textContent.trim() === 'Alterna')
    if (!toggle) return 'none'

    const gone = await fetch('/api/v1/functions/1?force=true', { method: 'DELETE' })
    if (!gone.ok) return 'could not delete the function: ' + gone.status
    await wait(700)

    toggle.click()
    await wait(900)
    const toast = document.querySelector('.toast')
    return toast ? 'ok' : 'the refusal never reached the screen'
  })()`)
  check('a refused press is said out loud', surfaced === 'none' || surfaced === 'ok', surfaced)

  /* The Grand Master dock: the badge opens a panel whose fader and modes
     drive the daemon's one true GM -- verified against the API, because the
     panel showing 50% while the engine scales by nothing is precisely the
     lie this desk is organized against. */
  const gmDock = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const badge = document.querySelector('.gm-badge')
    if (!badge) return 'no GM badge in the bar'
    badge.click()
    await wait(400)

    const slider = document.querySelector('.gm-panel input[type=range]')
    if (!slider) return 'the panel has no fader'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(slider, '128')
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(600)

    let state = await (await fetch('/api/v1/grandmaster')).json()
    if (state.value !== 128) return 'the fader said 128, the engine says ' + state.value
    if (!badge.textContent.includes('50')) return 'the badge does not show 50%: ' + badge.textContent

    const mode = [...document.querySelectorAll('.gm-panel select')]
      .find(s => [...s.options].some(o => o.value === 'All'))
    if (!mode) return 'no channel-mode selector'
    const optionSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    optionSetter.call(mode, 'All')
    mode.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(600)
    state = await (await fetch('/api/v1/grandmaster')).json()
    if (state.channelMode !== 'All') return 'the mode did not reach the engine: ' + state.channelMode

    // Back where it was -- and back to the BYTES it was: each persisted mode
    // change joined the console's undo history, and only undo removes the
    // <Properties><GrandMaster> nodes a mode flip materializes in projects
    // that never carried them. The round-trip guard is what catches anything
    // less.
    await fetch('/api/v1/grandmaster', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 255, channelMode: 'Intensity' }),
    })
    await fetch('/api/v1/vc/undo', { method: 'POST' })
    await fetch('/api/v1/vc/undo', { method: 'POST' })
    document.body.click()
    return 'ok'
  })()`)
  check('the grand master dock drives the engine', gmDock === 'ok', gmDock)

  /* STOP ALL: honest at rest (disabled with nothing running) and effective
     in motion (one press ends everything). */
  const stopAll = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const stop = document.querySelector('.stopall > .danger')
    if (!stop) return 'no STOP button'
    const status = async () => (await (await fetch('/api/v1/status')).json())

    if ((await status()).runningFunctions === 0 && !stop.disabled) {
      return 'nothing runs, yet STOP invites a press'
    }

    const list = await (await fetch('/api/v1/functions')).json()
    const startable = list.find(f => f.type === 'Scene' || f.type === 'Chaser')
    if (!startable) return 'none'

    await fetch('/api/v1/functions/' + startable.id + '/start', { method: 'POST' })
    await wait(800)
    if (stop.disabled) return 'a function runs, yet STOP is disabled'

    stop.click()
    await wait(900)
    if ((await status()).runningFunctions !== 0) return 'STOP left something running'
    return 'ok'
  })()`)
  check('STOP ALL is honest at rest and total in motion', stopAll === 'none' || stopAll === 'ok', stopAll)

  /* The Mesa (Simple Desk) view: raw channels, held and released, verified
     against the daemon -- the screen must show the engine's grip, not its
     own memory of clicks. */
  const mesa = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const tab = [...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === 'Mesa')
    if (!tab) return 'no Mesa in the rail'
    tab.click()
    await wait(1200)

    const grid = document.querySelector('.mesa-grid')
    if (!grid) return 'the desk never drew'
    const first = grid.querySelector('.mesa-channel')
    if (!first) return 'no channels in the grid'

    /* Hold channel 2 at 180 through the drawn slider. */
    const second = grid.querySelectorAll('.mesa-channel')[1]
    const slider = second.querySelector('input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(slider, '180')
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(700)

    const held = await (await fetch('/api/v1/simpledesk/1')).json()
    if (held.held['2'] !== 180) return 'the engine does not hold what the screen set: ' + JSON.stringify(held.held)
    if (second.getAttribute('data-held') !== 'true') return 'held on the engine, not shown on the screen'

    /* The release control appears only on held channels, and works. */
    if (first.querySelector('.mesa-release')) return 'an unheld channel offers release'
    const release = second.querySelector('.mesa-release')
    if (!release) return 'the held channel offers no release'
    release.click()
    await wait(700)
    const after = await (await fetch('/api/v1/simpledesk/1')).json()
    if (after.held['2'] !== undefined) return 'release did not release'

    /* The keypad drives the same engine. */
    const field = document.querySelector('.mesa-keypad input')
    if (!field) return 'no keypad'
    setter.call(field, '5 AT 100')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    ;[...document.querySelectorAll('.mesa-keypad button')]
      .find(b => b.textContent.trim() === 'ENTER').click()
    await wait(700)
    const typed = await (await fetch('/api/v1/simpledesk/1')).json()
    if (typed.held['5'] !== 100) return 'the keypad command never reached the engine'

    await fetch('/api/v1/simpledesk/1', { method: 'DELETE' })
    ;[...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === 'Consola')?.click()
    await wait(700)
    return 'ok'
  })()`)
  check('the desk holds, shows and releases through the engine', mesa === 'ok', mesa)

  /* The Mesa is the DMX monitor too: the same frames off the wire, read as
     raw DMX or percent, and grouped by lamp in the fixture view. Nothing here
     is a second data path -- every number is the stream the desk already
     draws, which is why an injected desk value must appear in all three
     readings. */
  const monitor = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const tab = [...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === 'Mesa')
    if (!tab) return 'no Mesa in the rail'
    tab.click()
    await wait(1000)

    /* A known value on the wire, held by the desk itself. */
    await fetch('/api/v1/simpledesk/1/channels', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { '1': 255 } }),
    })
    await wait(900)

    const cell = document.querySelector('.mesa-grid .mesa-channel .mesa-value')
    if (!cell) return 'no channel values drawn'
    if (cell.textContent.trim() !== '255') {
      return 'channel 1 shows ' + cell.textContent + ', the wire says 255'
    }

    /* Percent is a reading of the same number, not another number. */
    const pct = [...document.querySelectorAll('.mesa-modes button')]
      .find(b => b.textContent.trim() === '%')
    if (!pct) return 'no percent toggle'
    pct.click()
    await wait(400)
    if (cell.textContent.trim() !== '100%') return 'percent shows ' + cell.textContent

    /* The fixture view: one box per lamp of this universe, no more, no less. */
    const fixturesBtn = [...document.querySelectorAll('.mesa-modes button')]
      .find(b => b.textContent.trim() === 'Fixtures')
    if (!fixturesBtn) return 'no fixtures toggle'
    fixturesBtn.click()
    await wait(900)

    const fixtures = (await (await fetch('/api/v1/fixtures')).json())
      .filter(f => f.universe === 1).sort((a, b) => a.address - b.address)
    const boxes = document.querySelectorAll('.mesa-fixturebox')
    if (boxes.length !== fixtures.length) {
      return boxes.length + ' boxes for ' + fixtures.length + ' fixtures'
    }
    if (fixtures.length === 0) {
      /* An empty universe must say so, not show a silent void. */
      if (!document.querySelector('.mesa-empty')) return 'no fixtures and no explanation'
    } else {
      /* Abs reads the DMX address; Rel reads 1..n within the lamp. */
      const firstCell = boxes[0].querySelector('.mesa-fxchannel .mesa-address')
      if (firstCell.textContent.trim() !== String(fixtures[0].address)) {
        return 'abs shows ' + firstCell.textContent + ' for address ' + fixtures[0].address
      }
      ;[...document.querySelectorAll('.mesa-modes button')]
        .find(b => b.textContent.trim() === 'Rel').click()
      await wait(300)
      if (firstCell.textContent.trim() !== '1') return 'rel shows ' + firstCell.textContent

      /* A cell is a door back to the desk: clicking opens the channel view. */
      boxes[0].querySelector('.mesa-fxchannel').click()
      await wait(400)
      if (!document.querySelector('.mesa-grid')) return 'the cell did not open the channel view'
    }

    await fetch('/api/v1/simpledesk/1', { method: 'DELETE' })
    return 'ok'
  })()`)
  check('the monitor reads the frames in DMX, percent and by fixture', monitor === 'ok', monitor)

  /* The dump button: wears the live count, refuses when there is nothing a
     scene could say, and freezes exactly the held value when pressed. */
  const dump = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const badge = document.querySelector('.dump-badge')
    if (!badge) return 'no dump button in the bar'

    /* Open both hands first, so "nothing held" is a fact and not a hope. */
    await fetch('/api/v1/live', { method: 'DELETE' })
    await fetch('/api/v1/simpledesk/1', { method: 'DELETE' })
    await wait(700)
    if (!badge.disabled) return 'nothing to dump, yet the button invites a press'

    const fixtures = await (await fetch('/api/v1/fixtures')).json()
    if (fixtures.length === 0) return 'none'
    const target = fixtures[0]
    const before = new Set((await (await fetch('/api/v1/functions')).json())
      .filter(f => f.type === 'Scene').map(f => f.id))

    await fetch('/api/v1/live', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [{ fixture: target.id, channel: 0, value: 200 }] }),
    })
    await wait(900)

    if (badge.disabled) return 'a value is held, yet the button refuses'
    if (!badge.textContent.includes('1')) {
      return 'the badge does not wear the count: ' + badge.textContent
    }
    badge.click()
    await wait(400)
    const panel = document.querySelector('.dump-panel')
    if (!panel) return 'the badge opened no panel'
    ;[...panel.querySelectorAll('button')].find(b => b.textContent.trim() === 'Volcar').click()
    await wait(900)

    const made = (await (await fetch('/api/v1/functions')).json())
      .find(f => f.type === 'Scene' && !before.has(f.id))
    if (!made) return 'no scene appeared'
    const body = await (await fetch('/api/v1/functions/' + made.id + '/body')).json()
    const value = body.values.find(v => v.fixture === target.id && v.channel === 0)
    if (!value || value.value !== 200) {
      return 'the scene does not carry the held value: ' + JSON.stringify(body.values)
    }

    /* Clean up the grip and the frozen scene. */
    await fetch('/api/v1/live', { method: 'DELETE' })
    await fetch('/api/v1/functions/' + made.id, { method: 'DELETE' })
    return 'ok'
  })()`)
  check('the dump freezes exactly what is held', dump === 'ok' || dump === 'none', dump)

  /* External input, through the screen: the Patch view's Entrada/Feedback
     selects must actually patch, the editor's Aprender must bind to the next
     control that moves, and a captured key must fire the widget from the
     keyboard. The Loopback plugin closes the wire, exactly as in
     input-smoke.sh -- when the daemon has no plugins, everything here says so
     and steps aside. */
  const patchIn = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const io = await (await fetch('/api/v1/io')).json()
    if (!io.inputPlugins.some(p => p.name === 'Loopback')) return 'none'

    ;[...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === 'Patch')?.click()
    await wait(1000)

    let card = [...document.querySelectorAll('.card')]
      .find(c => c.querySelector('.chip')?.textContent === 'U2')
    if (!card) {
      /* One-universe projects grow a second one through the same button the
         operator would use. Remembered, so the cleanup can take it back. */
      ;[...document.querySelectorAll('button')]
        .find(b => b.textContent.trim() === '+ Añadir universo')?.click()
      await wait(1000)
      card = [...document.querySelectorAll('.card')]
        .find(c => c.querySelector('.chip')?.textContent === 'U2')
      if (!card) return 'adding a universe grew no U2 card'
      window.__orchidF9AddedU2 = true
    }
    const selectOf = (label) => [...card.querySelectorAll('label.field')]
      .find(l => l.querySelector('span')?.textContent === label)?.querySelector('select')

    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const pick = async (label) => {
      const select = selectOf(label)
      if (!select) return label + ' select missing'
      const option = [...select.options].find(o => o.textContent.includes('Loopback'))
      if (!option) return label + ' offers no Loopback'
      setter.call(select, option.value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(800)
      return 'ok'
    }

    let step = await pick('Salida')
    if (step !== 'ok') return step
    step = await pick('Entrada')
    if (step !== 'ok') return step

    /* The feedback select only exists once an input is patched: a feedback
       line with no input is a promise to nobody. */
    if (!selectOf('Feedback')) return 'no Feedback select after patching the input'
    step = await pick('Feedback')
    if (step !== 'ok') return step

    const u2 = (await (await fetch('/api/v1/universes')).json()).find(u => u.id === 2)
    if (u2?.input?.plugin !== 'Loopback' || u2?.feedback?.plugin !== 'Loopback') {
      return 'the screen patched but the daemon disagrees: ' + JSON.stringify({ input: u2?.input, feedback: u2?.feedback })
    }
    return 'ok'
  })()`)
  check('the Patch view patches input and feedback', patchIn === 'ok' || patchIn === 'none', patchIn)

  let learnedWidget = 'none'
  if (patchIn === 'ok') {
    /* Aprender: the binding is learned by moving the control, not typed. */
    const learned = await evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      ;[...document.querySelectorAll('.rail-item')]
        .find(b => b.textContent.trim() === 'Consola')?.click()
      await wait(900)

      const walk = w => [w, ...(w.children ?? []).flatMap(walk)]

      /* A button of our own, over any function that still runs -- created
         and later deleted whole, the same add-and-remove the suite already
         proves leaves the console byte-identical. Hunting an existing button
         broke on the chapter that deletes a function on purpose. */
      const fn = (await (await fetch('/api/v1/functions')).json())
        .find(f => f.type === 'Scene' || f.type === 'Chaser')
      if (!fn) return 'none'
      const made = await (await fetch('/api/v1/vc/widgets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'button', caption: 'PulsadorF9', functionId: fn.id }),
      })).json()
      if (made.id === undefined) return 'could not create the button: ' + JSON.stringify(made)
      const target = { id: Number(made.id), functionId: fn.id, caption: 'PulsadorF9' }
      await wait(900)

      ;[...document.querySelectorAll('button')]
        .find(b => b.textContent.trim().startsWith('Editar'))?.click()
      await wait(700)

      /* Edit mode decorates every widget with its type label, so the text
         reads "PulsadorF9button" -- matched by its caption prefix. */
      const drawn = [...document.querySelectorAll('.widget.button')]
        .find(w => w.textContent.trim().startsWith(target.caption))
      if (!drawn) return 'the created button is not on screen'
      drawn.click()
      await wait(900)

      const panel = document.querySelector('.editor')
      if (!panel) return 'the editor never opened'
      const external = panel.querySelector('details.external-input')
      if (!external) return 'no external input panel'
      external.open = true
      await wait(200)

      ;[...external.querySelectorAll('button')]
        .find(b => b.textContent.startsWith('Aprender'))?.click()
      await wait(300)

      /* Move the control: a desk grip on the looped universe IS the wing. */
      await fetch('/api/v1/simpledesk/2/channels', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { '1': 255 } }),
      })
      await wait(1400)

      const after = walk(await (await fetch('/api/v1/vc')).json())
        .find(w => w.id === target.id)
      if (after?.input?.universe !== 1 || after?.input?.channel !== 0) {
        return 'the binding never landed: ' + JSON.stringify(after?.input)
      }

      /* And the key, captured rather than typed. */
      ;[...panel.querySelectorAll('button')]
        .find(b => b.textContent.startsWith('Capturar'))?.click()
      await wait(200)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6' }))
      await wait(1200)
      const keyed = walk(await (await fetch('/api/v1/vc')).json())
        .find(w => w.id === target.id)
      if (keyed?.key !== 'F6') return 'the key never landed: ' + JSON.stringify(keyed?.key)

      /* Let the wire go BEFORE leaving: a held grip is a held press. */
      await fetch('/api/v1/simpledesk/2', { method: 'DELETE' })
      ;[...document.querySelectorAll('button')]
        .find(b => b.textContent.trim().startsWith('Listo'))?.click()
      await wait(700)
      return 'ok:' + target.id + ':' + target.functionId
    })()`)
    learnedWidget = learned
    check('Aprender binds and Capturar keys, into the file', learned.startsWith('ok:') || learned === 'none', learned)
  }

  if (learnedWidget.startsWith('ok:')) {
    const functionId = Number(learnedWidget.split(':')[2])
    /* The captured key fires the widget from run mode -- same path as a tap. */
    const keyFires = await evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const runs = async () => (await (await fetch('/api/v1/functions')).json())
        .find(f => f.id === ${functionId})?.running === true

      const pressed = new KeyboardEvent('keydown', { key: 'F6', cancelable: true })
      window.dispatchEvent(pressed)
      await wait(1200)
      if (!(await runs())) {
        /* Once more before declaring it dead: a keyup between chapters can
           leave edge state mid-air. */
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F6' }))
        await wait(300)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6' }))
        await wait(1500)
      }
      if (!(await runs())) {
        const walk = (w) => [w, ...(w.children ?? []).flatMap(walk)]
        const widget = walk(await (await fetch('/api/v1/vc')).json())
          .find(w => w.id === ${Number(learnedWidget.split(':')[1])})
        return 'the key pressed nothing: ' + JSON.stringify({
          key: widget?.key,
          action: widget?.action,
          matched: pressed.defaultPrevented,
        })
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F6' }))

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6' }))
      await wait(1200)
      if (await runs()) return 'the second press did not toggle it off'
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F6' }))

      /* The button leaves whole, bindings and all -- the add-and-remove the
         round-trip guard already proves is byte-clean. */
      await fetch('/api/v1/vc/widgets/${Number(learnedWidget.split(':')[1])}', { method: 'DELETE' })
      await wait(700)
      const walkAll = (w) => [w, ...(w.children ?? []).flatMap(walkAll)]
      const leftover = walkAll(await (await fetch('/api/v1/vc')).json())
        .find(w => w.id === ${Number(learnedWidget.split(':')[1])})
      if (leftover !== undefined) return 'the button did not leave'

      /* And the loop itself -- or the whole universe, where the chapter
         grew one to work in. */
      if (window.__orchidF9AddedU2 === true) {
        await fetch('/api/v1/universes/2', { method: 'DELETE' })
      } else {
        await fetch('/api/v1/universes/2', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ output: { plugin: '', line: '' }, input: { plugin: '', line: '' }, feedback: { plugin: '', line: '' } }),
        })
      }
      return 'ok'
    })()`)
    check('the captured key fires the widget at runtime', keyFires === 'ok', keyFires)
  }

  /* The function organizer and the chaser editor: search that filters,
     folders that appear, per-step speeds and a shuffle whose result is a
     permutation the daemon can repeat back. Fixtures of its own, cleaned up
     whole. */
  const organizer = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const json = { 'Content-Type': 'application/json' }
    const make = async (body) => (await (await fetch('/api/v1/functions', {
      method: 'POST', headers: json, body: JSON.stringify(body) })).json()).id
    const sceneA = await make({ type: 'Scene', name: 'BaseF10A' })
    const sceneB = await make({ type: 'Scene', name: 'BaseF10B' })
    const sceneC = await make({ type: 'Scene', name: 'BaseF10C' })
    const chaser = await make({ type: 'Chaser', name: 'PruebaF10' })
    for (const fn of [sceneA, sceneB, sceneC]) {
      await fetch('/api/v1/functions/' + chaser + '/steps', {
        method: 'POST', headers: json, body: JSON.stringify({ function: fn }) })
    }

    ;[...document.querySelectorAll('.rail-item')]
      .find(b => b.textContent.trim() === 'Funciones')?.click()
    await wait(900)

    const cleanup = async () => {
      for (const fn of [chaser, sceneA, sceneB, sceneC]) {
        await fetch('/api/v1/functions/' + fn + '?force=true', { method: 'DELETE' })
      }
    }

    try {
      /* Search narrows the list to what matches. */
      const search = [...document.querySelectorAll('input')]
        .find(i => i.placeholder === 'Nombre de función')
      if (!search) return 'no search box'
      const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setInput.call(search, 'PruebaF10')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(500)
      const rows = [...document.querySelectorAll('.table-row')]
      if (rows.length !== 1) return rows.length + ' rows for a unique name'

      /* Open the editor. */
      rows[0].querySelector('button.linkish')?.click()
      await wait(700)
      const editor = [...document.querySelectorAll('article.card')]
        .find(c => c.querySelector('header strong')?.textContent === 'PruebaF10')
      if (!editor) return 'the editor never opened'

      /* Per-step mode through the select, checked against the daemon. */
      const modeSelect = [...editor.querySelectorAll('label.field')]
        .find(l => l.querySelector('span')?.textContent === 'Entrada'
                && l.querySelector('select'))?.querySelector('select')
      if (!modeSelect) return 'no fade-in mode select'
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setSelect.call(modeSelect, 'perstep')
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(700)
      let body = await (await fetch('/api/v1/functions/' + chaser + '/body')).json()
      if (body.fadeInMode !== 'perstep') return 'the mode never reached the daemon: ' + body.fadeInMode

      /* A per-step fade written through its input. */
      const stepTime = editor.querySelector('.step-time')
      if (!stepTime) return 'per-step mode shows no per-step inputs'
      setInput.call(stepTime, '500')
      stepTime.dispatchEvent(new Event('input', { bubbles: true }))
      /* React hears blur as focusout; a bare blur event commits nothing. */
      stepTime.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await wait(700)
      body = await (await fetch('/api/v1/functions/' + chaser + '/body')).json()
      if (body.steps[0].fadeIn !== 500) {
        return 'the step fade never landed: ' + JSON.stringify(body.steps[0])
      }

      /* Shuffle: the same steps in a genuinely different order. Random may
         deal the identity, so up to five clicks get to disagree with the
         original -- five identities out of 3! orders is not luck, it is a
         button that does nothing. */
      const original = body.steps.map(s => s.function).join(',')
      let changed = false
      for (let round = 0; round < 5 && !changed; round++) {
        ;[...editor.querySelectorAll('button')]
          .find(b => b.textContent.trim() === 'Barajar')?.click()
        await wait(700)
        body = await (await fetch('/api/v1/functions/' + chaser + '/body')).json()
        const kept = body.steps.map(s => s.function).sort().join(',')
        if (kept !== [sceneA, sceneB, sceneC].sort().join(',')) {
          return 'the shuffle lost steps: ' + kept
        }
        changed = body.steps.map(s => s.function).join(',') !== original
      }
      if (!changed) return 'five shuffles never changed the order'

      /* The folder, and its headline in the list. */
      const folderInput = [...editor.querySelectorAll('label.field')]
        .find(l => l.querySelector('span')?.textContent === 'Carpeta')?.querySelector('input')
      if (!folderInput) return 'no folder field'
      setInput.call(folderInput, 'CarpetaF10')
      folderInput.dispatchEvent(new Event('input', { bubbles: true }))
      folderInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await wait(800)
      const listed = (await (await fetch('/api/v1/functions')).json())
        .find(f => f.id === chaser)
      if (listed.path !== 'CarpetaF10') return 'the folder never landed: ' + listed.path
      if (![...document.querySelectorAll('.folder-title')]
        .some(h => h.textContent.includes('CarpetaF10'))) {
        return 'the folder heading never appeared'
      }

      return 'ok'
    } finally {
      document.querySelector('article.card header button[aria-label="Cerrar"]')?.click()
      await wait(300)
      /* Leave the view as found: a filter left behind empties the list for
         whoever comes next. */
      const searchBox = [...document.querySelectorAll('input')]
        .find(i => i.placeholder === 'Nombre de función')
      if (searchBox) {
        const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setInput.call(searchBox, '')
        searchBox.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await cleanup()
    }
  })()`)
  check('the organizer and the chaser editor act for real', organizer === 'ok', organizer)

  /* The matrix and EFX editors' new controls, checked against the daemon:
     the blend select, the bake button, the mass-offset spreader. Rig of its
     own, removed whole. */
  const matrixUi = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const json = { 'Content-Type': 'application/json' }
    const post = async (path, body) => (await (await fetch('/api/v1' + path, {
      method: 'POST', headers: json, body: JSON.stringify(body) })).json())

    const before = new Set((await (await fetch('/api/v1/fixtures')).json()).map(f => f.id))
    await post('/fixtures', { manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 400 })
    await post('/fixtures', { manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 405 })
    const mine = (await (await fetch('/api/v1/fixtures')).json())
      .filter(f => !before.has(f.id)).map(f => f.id)
    const group = (await post('/fixture-groups', { name: 'PanelF11', fixtures: mine })).id
    const matrix = (await post('/functions', { type: 'RGBMatrix', name: 'LienzoF11' })).id
    await fetch('/api/v1/functions/' + matrix + '/body', { method: 'PUT', headers: json,
      body: JSON.stringify({ fixtureGroup: group, algorithm: 'Plain Color', colors: ['#ff0000'] }) })
    const efx = (await post('/functions', { type: 'EFX', name: 'OndaF11' })).id
    await fetch('/api/v1/functions/' + efx + '/body', { method: 'PUT', headers: json,
      body: JSON.stringify({ fixtures: mine }) })

    const cleanup = async () => {
      for (const id of [matrix, efx]) {
        await fetch('/api/v1/functions/' + id + '?force=true', { method: 'DELETE' })
      }
      await fetch('/api/v1/fixture-groups/' + group, { method: 'DELETE' })
      for (const id of mine) await fetch('/api/v1/fixtures/' + id, { method: 'DELETE' })
    }

    try {
      ;[...document.querySelectorAll('.rail-item')]
        .find(b => b.textContent.trim() === 'Funciones')?.click()
      await wait(900)

      /* A leftover filter from any earlier chapter empties the list. */
      const searchBox = [...document.querySelectorAll('input')]
        .find(i => i.placeholder === 'Nombre de función')
      if (searchBox && searchBox.value !== '') {
        const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setInput.call(searchBox, '')
        searchBox.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(400)
      }

      const openEditor = async (name) => {
        /* Retried: a functions broadcast re-renders the list, and a click on
           a node React just replaced lands on nothing. */
        for (let attempt = 0; attempt < 3; attempt++) {
          const row = [...document.querySelectorAll('.table-row')]
            .find(r => r.querySelector('button.linkish')?.textContent === name)
          row?.querySelector('button.linkish')?.click()
          await wait(800)
          const card = [...document.querySelectorAll('article.card')]
            .find(c => c.querySelector('header strong')?.textContent === name)
          if (card) return card
        }
        return undefined
      }

      const editor = await openEditor('LienzoF11')
      if (!editor) return 'the matrix editor never opened'

      const blend = [...editor.querySelectorAll('label.field')]
        .find(l => l.querySelector('span')?.textContent === 'Mezcla')?.querySelector('select')
      if (!blend) return 'no blend select'
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setSelect.call(blend, 'Mask')
      blend.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(700)
      let shape = await (await fetch('/api/v1/functions/' + matrix + '/body')).json()
      if (shape.blendMode !== 'Mask') return 'the blend never landed: ' + shape.blendMode

      const beforeBake = (await (await fetch('/api/v1/functions')).json()).length
      ;[...editor.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Congelar en secuencia')?.click()
      await wait(1000)
      const afterBake = (await (await fetch('/api/v1/functions')).json())
      if (afterBake.length !== beforeBake + 2) {
        return 'the bake made ' + (afterBake.length - beforeBake) + ' functions, wanted 2'
      }
      /* Sequence before scene: deleting the bound scene first cascades and
         the second delete answers 404 into the console-error net. */
      for (const made of afterBake.slice(-2).reverse()) {
        await fetch('/api/v1/functions/' + made.id + '?force=true', { method: 'DELETE' })
      }

      const efxEditor = await openEditor('OndaF11')
      if (!efxEditor) {
        return 'the EFX editor never opened: ' + JSON.stringify({
          rows: [...document.querySelectorAll('.table-row')]
            .map(r => r.querySelector('button.linkish')?.textContent).slice(0, 12),
          cards: [...document.querySelectorAll('article.card')]
            .map(c => c.querySelector('header strong')?.textContent),
          search: [...document.querySelectorAll('input')]
            .find(i => i.placeholder === 'Nombre de función')?.value ?? '(no box)',
          apiCount: (await (await fetch('/api/v1/functions')).json()).length,
          hint: document.querySelector('.setup .hint')?.textContent?.slice(0, 60) ?? null,
        })
      }
      ;[...efxEditor.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Repartir offsets')?.click()
      await wait(800)
      shape = await (await fetch('/api/v1/functions/' + efx + '/body')).json()
      const offsets = (shape.heads ?? []).map(h => h.offset)
      if (offsets.join(',') !== '0,180') return 'the spread never landed: ' + offsets.join(',')

      return 'ok'
    } finally {
      /* Close the editor first: one left open refetches the body of the
         function the cleanup just deleted, and the 404 lands in the
         console-error net. */
      document.querySelector('article.card header button[aria-label="Cerrar"]')?.click()
      await wait(300)
      await cleanup()
    }
  })()`)
  check('the matrix and EFX editors act for real', matrixUi === 'ok', matrixUi)

  /* The channel tools and the script checker, through the screen: a gel
     picked from the book writes its EXACT RGB into the scene, and the
     checker points at the line the engine refuses. */
  const toolsUi = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const json = { 'Content-Type': 'application/json' }
    const post = async (path, body) => (await (await fetch('/api/v1' + path, {
      method: 'POST', headers: json, body: JSON.stringify(body) })).json())

    const gels = await (await fetch('/api/v1/colorfilters')).json()
    if (!gels.filters.some(f => f.name === 'Named RGB')) return 'none'

    const before = new Set((await (await fetch('/api/v1/fixtures')).json()).map(f => f.id))
    await post('/fixtures', { manufacturer: 'Generic', model: 'Generic RGBW', mode: 'RGBW', universe: 1, address: 300 })
    const bar = (await (await fetch('/api/v1/fixtures')).json()).find(f => !before.has(f.id))
    const scene = (await post('/functions', { type: 'Scene', name: 'GelF12' })).id
    const script = (await post('/functions', { type: 'Script', name: 'GuionF12' })).id
    await fetch('/api/v1/functions/' + script + '/body', { method: 'PUT', headers: json,
      body: JSON.stringify({ data: 'wait:1000\\nesto no es un comando' }) })

    const cleanup = async () => {
      document.querySelector('article.card header button[aria-label="Cerrar"]')?.click()
      await wait(300)
      for (const id of [scene, script]) {
        await fetch('/api/v1/functions/' + id + '?force=true', { method: 'DELETE' })
      }
      await fetch('/api/v1/fixtures/' + bar.id, { method: 'DELETE' })
      const searchBox = [...document.querySelectorAll('input')]
        .find(i => i.placeholder === 'Nombre de función')
      if (searchBox && searchBox.value !== '') {
        const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setInput.call(searchBox, '')
        searchBox.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    try {
      ;[...document.querySelectorAll('.rail-item')]
        .find(b => b.textContent.trim() === 'Funciones')?.click()
      await wait(900)

      const openEditor = async (name) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const row = [...document.querySelectorAll('.table-row')]
            .find(r => r.querySelector('button.linkish')?.textContent === name)
          row?.querySelector('button.linkish')?.click()
          await wait(800)
          const card = [...document.querySelectorAll('article.card')]
            .find(c => c.querySelector('header strong')?.textContent === name)
          if (card) return card
        }
        return undefined
      }

      const editor = await openEditor('GelF12')
      if (!editor) return 'the scene editor never opened'

      const tools = editor.querySelector('details.channel-tools')
      if (!tools) return 'no channel tools'
      tools.open = true
      await wait(300)

      /* Point the tools at OUR bar, then pick Snow from the book. */
      const fixtureSelect = [...tools.querySelectorAll('label.field')]
        .find(l => l.querySelector('span')?.textContent === 'Fixture')?.querySelector('select')
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setSelect.call(fixtureSelect, String(bar.id))
      fixtureSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(700)

      const gelSelect = [...tools.querySelectorAll('label.field')]
        .find(l => l.querySelector('span')?.textContent?.startsWith('Gelatinas'))
        ?.querySelector('select')
      if (!gelSelect) return 'no gel book on an RGB fixture'
      const snow = [...gelSelect.options].find(o => o.textContent.startsWith('Snow'))
      if (!snow) return 'Snow is not in the book'
      setSelect.call(gelSelect, snow.value)
      gelSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(900)

      const bodyNow = await (await fetch('/api/v1/functions/' + scene + '/body')).json()
      const values = {}
      for (const v of bodyNow.values ?? []) values[v.channel] = v.value
      /* Snow is #FFFAFA: R 255, G 250, B 250 -- EXACTLY. */
      if (values[0] !== 255 || values[1] !== 250 || values[2] !== 250) {
        return 'the gel did not write its exact RGB: ' + JSON.stringify(bodyNow.values)
      }

      /* The script checker, on a script with a known bad line. */
      const scriptEditor = await openEditor('GuionF12')
      if (!scriptEditor) return 'the script editor never opened'
      ;[...scriptEditor.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Comprobar sintaxis')?.click()
      await wait(800)
      const verdict = [...scriptEditor.querySelectorAll('.hint')]
        .map(h => h.textContent).join(' ')
      if (!verdict.includes('2')) return 'the checker never pointed at line 2: ' + verdict

      return 'ok'
    } finally {
      await cleanup()
    }
  })()`)
  check('the gel writes exact RGB and the checker points at the line',
    toolsUi === 'ok' || toolsUi === 'none', toolsUi)

  /* The desktop shell's close question, answered by the page.
   *
     The shell (when there is one) prevents the close and dispatches
     orchid-close-request; the page owns the dialog because a native two-button
     dialog cannot offer the three honest answers. Browsers never receive the
     event, so dispatching it synthetically is exactly how the shell path is
     exercised without a shell: the dialog must appear with all three answers,
     and Cancelar must put it away leaving everything as it was. */
  const closeAsk = await evaluate(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    window.dispatchEvent(new CustomEvent('orchid-close-request'))
    await wait(500)

    const dialog = document.querySelector('dialog.gate[aria-label="Cerrar con cambios sin guardar"]')
    if (!dialog) return 'the close question never appeared'

    const labels = [...dialog.querySelectorAll('button')].map(b => b.textContent.trim())
    for (const wanted of ['Guardar y salir', 'Salir sin guardar', 'Cancelar']) {
      if (!labels.includes(wanted)) return 'missing answer: ' + wanted + ' (' + labels.join(', ') + ')'
    }

    ;[...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancelar').click()
    await wait(400)
    if (document.querySelector('dialog.gate[aria-label="Cerrar con cambios sin guardar"]')) {
      return 'Cancelar did not put the question away'
    }
    return 'ok'
  })()`)
  check('the close question offers its three answers', closeAsk === 'ok', closeAsk)

  /* One slider in the app, everywhere.
   *
     The rule this guards is the one that already broke once: a speed dial kept
     the browser's range, and in a grid with no height to constrain it the thing
     rendered as a tall vertical slider through the middle of a row of buttons.
     Nothing failed -- it worked perfectly, it just looked like a different
     program had been pasted in. So the check is structural rather than visual:
     every range in the document is inside a drawn track, on every screen.

     Walked across the views rather than asked once, because a control that only
     appears in the show editor is exactly the one that gets missed. */
  const bare = await evaluate(`(async () => {
    const found = []
    for (const view of ['Consola', 'Funciones', 'Patch', 'Planta']) {
      const tab = [...document.querySelectorAll('.rail-item')]
        .find(b => b.textContent.trim() === view)
      if (!tab) continue
      tab.click()
      await new Promise(r => setTimeout(r, 900))
      for (const input of document.querySelectorAll('input[type=range]')) {
        if (input.closest('.track') === null) {
          found.push(view + ': ' + (input.getAttribute('aria-label') ?? input.className ?? '?'))
        }
      }
    }
    return found.length === 0 ? 'ok' : found.join(', ')
  })()`)
  check('every slider in the app is the same drawn control', bare === 'ok', bare)

  check('no errors in the console', consoleErrors.length === 0, consoleErrors.join(' | '))
} catch (error) {
  check('the run completed', false, error.message)
} finally {
  /* Dead before the sweep: Chrome flushes its profile on exit, and removing
     the directory under a live browser loses the race. */
  const gone = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill()
  await gone
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // A straggler file is a leak of bytes in /tmp, not a failed suite.
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nUI smoke test passed.')
process.exit(0)
