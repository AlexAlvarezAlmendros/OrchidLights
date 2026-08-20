/**
 * The interface in front of a daemon that demands the token.
 *
 *   node auth-client.mjs <base-url> <token>
 *
 * Three arrivals, which are the three ways a real device meets a guarded desk:
 *
 *  - By bare URL: the connect screen appears, and NOTHING else half-works
 *    behind it.
 *  - Typing the token into that screen: the console comes up, and the token
 *    survives a reload (a device is authorized once, not once per page).
 *  - By handover link (#token=...): the console comes up directly, and the
 *    token is scrubbed from the address bar before anyone can read it there.
 *
 * Chrome via the DevTools protocol against the real daemon, same as
 * ui-client.mjs.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const [base, token] = process.argv.slice(2)
if (!base || !token) {
  console.error('usage: auth-client.mjs <base-url> <token>')
  process.exit(2)
}

const failures = []
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const port = Number(process.env.CDP_PORT ?? 9230)

const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function debuggerUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('no debugger')
}

const ws = new WebSocket(await debuggerUrl())
await new Promise((resolve) => ws.addEventListener('open', resolve))

let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id
    pending.set(n, (m) => resolve(m.result))
    ws.send(JSON.stringify({ id: n, method, params }))
  })

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  return result?.result?.value
}

async function goTo(url) {
  await send('Page.navigate', { url })
  await sleep(3500)
}

await send('Page.enable')
await send('Runtime.enable')

/* 1. Bare arrival: the door is locked and says so. */
await goTo(`${base}/`)
const locked = await evaluate(`(() => {
  const gate = document.querySelector('.gate')
  if (!gate) return 'no connect screen'
  // Locked means locked: no console half-drawn behind the gate.
  if (document.querySelector('.widget')) return 'widgets rendered behind the gate'
  return 'ok'
})()`)
check('a bare arrival meets the connect screen and nothing else', locked === 'ok', locked)

/* 2. Typing the token opens the desk, and it stays open across a reload. */
const typed = await evaluate(`(async () => {
  const field = document.querySelector('.gate input[name=token]')
  if (!field) return 'no token field'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(field, ${JSON.stringify(token)})
  field.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('.gate button[type=submit]').click()
  return 'submitted'
})()`)
check('the token can be typed', typed === 'submitted', typed)
await sleep(4000) // the submit reloads the page

const open = await evaluate(`(() => {
  if (document.querySelector('.gate')) return 'still gated'
  if (!document.querySelector('.rail') && !document.querySelector('.showbar')) return 'no console'
  return 'ok'
})()`)
check('with the token the console comes up', open === 'ok', open)

await goTo(`${base}/`)
const survived = await evaluate(
  `(() => document.querySelector('.gate') ? 'gated again' : 'ok')()`,
)
check('the token survives a reload', survived === 'ok', survived)

/* 3. The handover link: straight in, and the address bar keeps no token. */
await evaluate(`localStorage.clear()`)
await goTo(`${base}/#token=${encodeURIComponent(token)}`)
const handed = await evaluate(`(() => {
  if (document.querySelector('.gate')) return 'gated despite the fragment'
  if (window.location.hash.includes('token')) return 'the token is still in the address bar'
  return 'ok'
})()`)
check('a handover link opens the desk and scrubs itself', handed === 'ok', handed)

/* And the desk is genuinely usable, not merely drawn: the functions arrived
   through an authorized fetch. */
const usable = await evaluate(`(async () => {
  const r = await fetch('/api/v1/functions', {
    headers: { Authorization: 'Bearer ' + localStorage.getItem('orchid.token') },
  })
  if (!r.ok) return 'functions: ' + r.status
  return 'ok'
})()`)
check('the stored token authorizes requests', usable === 'ok', usable)

chrome.kill()
process.exit(failures.length === 0 ? 0 : 1)
