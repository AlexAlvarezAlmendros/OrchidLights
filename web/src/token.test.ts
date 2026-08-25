/**
 * The token's whole life on a client: how it arrives in the URL fragment, how
 * it persists across page loads, and how it becomes the Authorization header.
 * Bare node has no localStorage, window or history, so each is a stub -- which
 * also keeps the assertions on what the module does to them, nothing more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptTokenFromLocation, authHeaders, clearToken, getToken, setToken } from './token'

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

/** A page load at the given address; returns the spy on history.replaceState. */
function visit(hash: string, pathname = '/', search = '') {
  const replaceState = vi.fn<(data: unknown, unused: string, url?: string) => void>()
  vi.stubGlobal('window', { location: { hash, pathname, search } })
  vi.stubGlobal('history', { replaceState })
  return replaceState
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stored token', () => {
  it('is absent until somebody sets one', () => {
    expect(getToken()).toBeNull()
  })

  it('persists once set, trimmed of the whitespace a paste drags along', () => {
    setToken('  abc-123\n')
    expect(getToken()).toBe('abc-123')
  })

  it('is gone after clearToken', () => {
    setToken('abc')
    clearToken()
    expect(getToken()).toBeNull()
  })
})

describe('authHeaders', () => {
  it('names the bearer once a token is held', () => {
    setToken('tok')
    expect(authHeaders()).toEqual({ Authorization: 'Bearer tok' })
  })

  it('adds nothing on a tokenless session', () => {
    // The result is spread into fetch headers: it must be empty, not a
    // present-but-undefined Authorization key.
    expect(authHeaders()).toEqual({})
  })
})

describe('adoptTokenFromLocation', () => {
  it('adopts the fragment token and scrubs it from the address bar', () => {
    // The address bar must come out clean: a token left on screen gets
    // screenshotted, bookmarked and read over shoulders.
    const replaceState = visit('#token=secreto', '/desk', '?lang=es')
    adoptTokenFromLocation()
    expect(getToken()).toBe('secreto')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/desk?lang=es')
  })

  it('keeps a route that shares the fragment, verbatim', () => {
    const replaceState = visit('#/mesa#token=abc')
    adoptTokenFromLocation()
    expect(getToken()).toBe('abc')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/mesa')
  })

  it('keeps the route whichever side of the token it rides on', () => {
    const replaceState = visit('#token=abc#/mesa')
    adoptTokenFromLocation()
    expect(getToken()).toBe('abc')
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/mesa')
  })

  it('decodes a token that travelled URL-encoded', () => {
    visit('#token=a%20b%2Bc')
    adoptTokenFromLocation()
    expect(getToken()).toBe('a b+c')
  })

  it('touches nothing when the fragment carries no token', () => {
    const replaceState = visit('#/mesa')
    adoptTokenFromLocation()
    expect(getToken()).toBeNull()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('does not adopt an empty token', () => {
    visit('#token=')
    adoptTokenFromLocation()
    expect(getToken()).toBeNull()
  })

  it('lets the last token win when the fragment names two', () => {
    visit('#token=viejo#token=nuevo')
    adoptTokenFromLocation()
    expect(getToken()).toBe('nuevo')
  })

  it('does not mistake a route query for the handoff token', () => {
    // Only a whole "token=..." segment is the handoff. A "?token=" inside a
    // route belongs to that route and must survive untouched.
    const replaceState = visit('#/connect?token=abc')
    adoptTokenFromLocation()
    expect(getToken()).toBeNull()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/connect?token=abc')
  })
})
