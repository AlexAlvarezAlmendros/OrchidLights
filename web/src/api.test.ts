/**
 * The REST client, observed at the fetch boundary: the exact URL, method,
 * headers and body the daemon would receive, and what the caller gets back
 * when the daemon answers badly. Nothing here starts a server -- fetch is a
 * stub that records, and localStorage a map, because bare node has neither.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Unauthorized, api } from './api'
import { setToken } from './token'

/** localStorage does not exist on bare node; the token module needs one. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => {
      map.clear()
    },
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

const okJson = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), init)

type FetchStub = Mock<(url: string, init?: RequestInit) => Promise<Response>>
let fetchMock: FetchStub

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => okJson({}))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The last request as the daemon would see it. */
function lastRequest(): { url: string; method: string; headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1)
  if (call === undefined) throw new Error('fetch was never called')
  const [url, init] = call
  return {
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
  }
}

/** The JSON body of the last request, parsed back. */
function sentBody(): unknown {
  const call = fetchMock.mock.calls.at(-1)
  if (call === undefined) throw new Error('fetch was never called')
  return JSON.parse(String(call[1]?.body))
}

describe('authorization', () => {
  it('carries the token on a plain GET once one is set', async () => {
    setToken('secreto-1')
    await api.status()
    expect(lastRequest().headers.Authorization).toBe('Bearer secreto-1')
  })

  it('keeps the token when a request brings its own headers', async () => {
    // The JSON routes merge Content-Type on top of the auth header; a merge
    // that dropped either would lock the operator out or corrupt the body.
    setToken('secreto-2')
    await api.putLayout({ pages: [] })
    const { headers } = lastRequest()
    expect(headers.Authorization).toBe('Bearer secreto-2')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('sends no Authorization header at all on a tokenless session', async () => {
    // Loopback without --require-auth: an empty "Authorization:" would still
    // be a header on the wire. Absence is the contract.
    await api.status()
    expect(lastRequest().headers).not.toHaveProperty('Authorization')
  })
})

describe('failure paths', () => {
  it('turns a 401 into Unauthorized so the shell can show the connect screen', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(api.status()).rejects.toBeInstanceOf(Unauthorized)
  })

  it('does not cry Unauthorized on other failures', async () => {
    // A 403 is "you may not", not "who are you": it must land as a toast,
    // never bounce the operator to the connect screen mid-show.
    fetchMock.mockResolvedValueOnce(okJson({ error: 'prohibido' }, { status: 403 }))
    const failure = await api.status().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(Unauthorized)
  })

  it('propagates the server message verbatim', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ error: 'La función 5 sigue en uso' }, { status: 409 }))
    await expect(api.removeFunction(5)).rejects.toThrow('La función 5 sigue en uso')
  })

  it('falls back to the status line when the error body is not JSON', async () => {
    // A proxy in the middle answers HTML; the client must still say something.
    fetchMock.mockResolvedValueOnce(
      new Response('<html>boom</html>', { status: 502, statusText: 'Bad Gateway' }),
    )
    await expect(api.status()).rejects.toThrow('502 Bad Gateway')
  })

  it('falls back to the status line when the JSON body carries no message', async () => {
    fetchMock.mockResolvedValueOnce(okJson({}, { status: 404, statusText: 'Not Found' }))
    await expect(api.status()).rejects.toThrow('404 Not Found')
  })

  it('hands the parsed payload back to the caller', async () => {
    const daemon = {
      name: 'OrchidLights',
      version: '5.0.0',
      apiVersion: 3,
      fixtures: 8,
      functions: 21,
      universes: 2,
      runningFunctions: 1,
      outputPlugins: ['ArtNet'],
      blackout: false,
    }
    fetchMock.mockResolvedValueOnce(okJson(daemon))
    await expect(api.status()).resolves.toEqual(daemon)
  })
})

describe('endpoint contracts', () => {
  it('reads the daemon status from /api/v1/status', async () => {
    await api.status()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/status', method: 'GET' })
  })

  it('reads the console tree and the layout from their own routes', async () => {
    await api.vc()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/vc', method: 'GET' })
    await api.layout()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/layout', method: 'GET' })
  })

  it('writes the layout back with PUT and the exact page structure', async () => {
    await api.putLayout({ pages: [{ id: 1, rows: [[10, 11], [12]] }] })
    expect(lastRequest()).toMatchObject({ url: '/api/v1/layout', method: 'PUT' })
    expect(sentBody()).toEqual({ pages: [{ id: 1, rows: [[10, 11], [12]] }] })
  })

  it('lists remote clients and kicks one by its id', async () => {
    await api.remote()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/remote', method: 'GET' })
    await api.kickRemote(4)
    expect(lastRequest()).toMatchObject({ url: '/api/v1/remote/clients/4', method: 'DELETE' })
  })

  it('saves the project with a bare POST', async () => {
    await api.saveProject()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/project/save', method: 'POST' })
  })

  it('pins live values with PUT and releases them with DELETE on the same route', async () => {
    await api.setLive([{ fixture: 1, channel: 0, value: 255 }])
    expect(lastRequest()).toMatchObject({ url: '/api/v1/live', method: 'PUT' })
    expect(sentBody()).toEqual({ values: [{ fixture: 1, channel: 0, value: 255 }] })
    await api.releaseLive()
    expect(lastRequest()).toMatchObject({ url: '/api/v1/live', method: 'DELETE' })
  })

  it('flips blackout by method, not by body', async () => {
    await api.blackout(true)
    expect(lastRequest()).toMatchObject({ url: '/api/v1/blackout', method: 'POST' })
    await api.blackout(false)
    expect(lastRequest()).toMatchObject({ url: '/api/v1/blackout', method: 'DELETE' })
  })

  it('stops everything with the fade the operator chose, zero by default', async () => {
    await api.stopAll()
    expect(sentBody()).toEqual({ fadeMs: 0 })
    await api.stopAll(2000)
    expect(lastRequest()).toMatchObject({ url: '/api/v1/stop', method: 'POST' })
    expect(sentBody()).toEqual({ fadeMs: 2000 })
  })

  it('creates a function from its type and name, nothing invented', async () => {
    await api.createFunction('Chaser', 'Intro')
    expect(lastRequest()).toMatchObject({ url: '/api/v1/functions', method: 'POST' })
    expect(sentBody()).toEqual({ type: 'Chaser', name: 'Intro' })
  })

  it('patches a function with only the fields the caller changed', async () => {
    // A PATCH that quietly filled the other timings with zeros would rewrite
    // the function; the daemon must receive exactly what was asked.
    await api.patchFunction(7, { fadeIn: 200 })
    expect(lastRequest()).toMatchObject({ url: '/api/v1/functions/7', method: 'PATCH' })
    expect(sentBody()).toEqual({ fadeIn: 200 })
  })

  it('asks for a forced delete only when the caller forces it', async () => {
    await api.removeFunction(5)
    expect(lastRequest()).toMatchObject({ url: '/api/v1/functions/5', method: 'DELETE' })
    await api.removeFunction(5, true)
    expect(lastRequest().url).toBe('/api/v1/functions/5?force=true')
  })

  it('URL-encodes names that carry spaces', async () => {
    await api.modifierCurve('Exponential Medium')
    expect(lastRequest().url).toBe('/api/v1/modifiers/Exponential%20Medium')
    await api.manufacturers('mac aura')
    expect(lastRequest().url).toBe('/api/v1/library?q=mac%20aura')
  })

  it('omits the search parameter when there is nothing to search', async () => {
    await api.manufacturers()
    expect(lastRequest().url).toBe('/api/v1/library')
  })

  it('asks for the waveform at the default resolution', async () => {
    await api.waveform(3)
    expect(lastRequest().url).toBe('/api/v1/functions/3/waveform?points=200')
  })

  it('uploads an asset as a raw body under its own name', async () => {
    // Not JSON: the daemon writes the bytes straight to disk, and the name
    // travels in the query so a space in a filename cannot break the route.
    const file = new File(['bytes'], 'intro loop.mp3')
    await api.uploadAsset(file)
    const call = fetchMock.mock.calls.at(-1)
    expect(call?.[0]).toBe('/api/v1/assets?name=intro%20loop.mp3')
    expect(call?.[1]?.method).toBe('POST')
    expect(call?.[1]?.body).toBe(file)
    expect(lastRequest().headers).not.toHaveProperty('Content-Type')
  })
})
