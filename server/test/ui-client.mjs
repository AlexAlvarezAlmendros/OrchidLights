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
  await screenshot('07-fixtures')

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
