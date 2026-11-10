// El asistente en un navegador de verdad, contra la mesa de verdad.
//
//   node server/test/ai-ui-client.mjs <url-de-la-mesa> <captura.png>
//
// Abre la pantalla del asistente, escribe un encargo, lo manda y espera a que
// termine el turno. Lo que imprime es lo que vio: los pasos de herramienta que
// se pintaron, los avisos y los errores de la consola. ai-ui-smoke.sh decide
// si eso está bien; este fichero solo mira.

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [base, shot] = process.argv.slice(2)
const url = `${base}/#/asistente`
const port = 9400 + Math.floor(Math.random() * 400)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* Un perfil nuevo cada vez: con el de siempre, el service worker sirve el
   bundle que cacheó la última vez. */
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'orchid-ai-ui-'))}`,
    `--remote-debugging-port=${port}`,
    '--window-size=1280,1000',
    url,
  ],
  { stdio: 'ignore' },
)

let target
for (let i = 0; i < 75 && !target; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    target = targets.find((t) => t.type === 'page' && t.url.startsWith(base))
  } catch {}
  await sleep(200)
}
if (!target) {
  chrome.kill()
  console.error('Chrome no abrió el puerto de depuración')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => {
  ws.onopen = resolve
})

let nextId = 1
const pending = new Map()
const errors = []
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    const { text, url: where } = message.params.entry
    if (!where?.endsWith('/favicon.ico')) errors.push(where ? `${text} (${new URL(where).pathname})` : text)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails.exception?.description ?? 'excepción')
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
    ?.result?.value

await send('Log.enable')
await send('Runtime.enable')

const done = async (result) => {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  if (shot && image.result?.data) writeFileSync(shot, Buffer.from(image.result.data, 'base64'))
  console.log(JSON.stringify({ ...result, errors }, null, 1))
  chrome.kill()
  process.exit(result.ok ? 0 : 1)
}

/* La pantalla carga en diferido: los dos SDKs viajan en su propio trozo. */
let ready = false
for (let i = 0; i < 100 && !ready; i++) {
  ready = await evaluate(`!!document.querySelector('textarea[aria-label="Mensaje"]')`)
  if (!ready) await sleep(200)
}
if (!ready) {
  await done({ ok: false, reason: 'la pantalla del asistente no apareció' })
}

await evaluate(`document.querySelector('textarea[aria-label="Mensaje"]').focus()`)
await send('Input.insertText', { text: 'Pon una escena de prueba en la sala' })
const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Enviar')
  if (!b || b.disabled) return false
  b.click()
  return true
})()`)
if (!clicked) await done({ ok: false, reason: 'el botón Enviar no estaba o no respondía' })

let state = null
for (let i = 0; i < 150; i++) {
  state = await evaluate(`(() => ({
    text: document.querySelector('.chat-log')?.innerText ?? '',
    tools: [...document.querySelectorAll('.chat-tool')].map((t) => ({
      estado: t.dataset.estado,
      linea: t.querySelector('summary')?.innerText.replace(/\\s+/g, ' ').trim(),
    })),
    notices: [...document.querySelectorAll('.chat-notice')].map((n) => n.innerText),
    busy: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Parar'),
  }))()`)
  if (!state.busy && (state.text.includes('Hecho: una escena nueva.') || state.notices.length > 0)) break
  await sleep(200)
}

await done({
  ok: state?.text.includes('Hecho: una escena nueva.') === true,
  tools: state?.tools ?? [],
  notices: state?.notices ?? [],
  busy: state?.busy,
})
