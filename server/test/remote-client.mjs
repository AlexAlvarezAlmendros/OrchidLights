// The WebSocket half of remote-smoke.sh: connections appear in the list,
// a kick reaches the wire as a normal close with its reason, and everyone
// still connected hears that the room changed.
//
//   node server/test/remote-client.mjs <base-url> <token>

const [base, token] = process.argv.slice(2)
if (!base || !token) {
  console.error('usage: remote-client.mjs <base-url> <token>')
  process.exit(2)
}

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

setTimeout(() => fail('timed out'), 15000).unref?.()

const authHeaders = { Authorization: `Bearer ${token}` }
const remote = async () => {
  const response = await fetch(`${base}/api/v1/remote`, { headers: authHeaders })
  if (!response.ok) fail(`GET /remote answered ${response.status}`)
  return response.json()
}

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'authenticated') resolve(ws)
    }
    ws.onerror = () => reject(new Error('socket error'))
  })

const watcher = await connect()
const victim = await connect()

// Coalesced into the flush like every other event: give it a beat.
await new Promise((r) => setTimeout(r, 700))

let state = await remote()
if (state.clients.length !== 2) fail(`2 connected, listed ${state.clients.length}`)
for (const client of state.clients) {
  if (client.trusted !== true) fail(`a token-bearing client listed untrusted: ${JSON.stringify(client)}`)
  if (!client.address) fail(`a client with no address: ${JSON.stringify(client)}`)
}

// The watcher must hear the room change; the victim must hear the door.
const victimIds = state.clients.map((c) => c.id)
const kicked = Math.max(...victimIds)

const closed = new Promise((resolve) => {
  victim.onclose = (event) => resolve(event)
  watcher.onclose = (event) => resolve(event)
})
const heard = new Promise((resolve) => {
  watcher.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'remote') resolve(message)
  }
})

const del = await fetch(`${base}/api/v1/remote/clients/${kicked}`, {
  method: 'DELETE',
  headers: authHeaders,
})
if (!del.ok) fail(`DELETE answered ${del.status}`)

const closeEvent = await closed
if (closeEvent.code !== 1000) fail(`close code ${closeEvent.code}, wanted 1000`)
if (!closeEvent.reason.includes('operador')) fail(`close reason: "${closeEvent.reason}"`)

const roomChange = await heard
if (typeof roomChange.clients !== 'number') fail(`remote event with no count: ${JSON.stringify(roomChange)}`)

await new Promise((r) => setTimeout(r, 500))
state = await remote()
if (state.clients.length !== 1) fail(`after the kick: listed ${state.clients.length}, wanted 1`)
if (state.clients[0].id === kicked) fail('the kicked id is still listed')

// An id that is nobody: refused, not absorbed.
const missing = await fetch(`${base}/api/v1/remote/clients/999999`, {
  method: 'DELETE',
  headers: authHeaders,
})
if (missing.status !== 404) fail(`DELETE of nobody answered ${missing.status}, wanted 404`)

watcher.close()
console.log('remote-client: ok')
process.exit(0)
