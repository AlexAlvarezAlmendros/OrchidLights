/**
 * The desk's token on this client: how it arrives, where it lives.
 *
 * The daemon demands a bearer token beyond loopback (and on loopback with
 * --require-auth). A browser has two ways of coming to hold it:
 *
 *  - Handed over in the URL fragment: the desktop shell opens the window at
 *    /#token=..., and a phone can be given the same link. The fragment never
 *    reaches the server or its logs, and it is scrubbed from the address bar
 *    immediately -- a token that stays on screen gets screenshotted, bookmarked
 *    and read over shoulders.
 *  - Typed into the connect screen, for the phone that arrived by bare URL.
 *
 * Either way it is kept in localStorage: an operator authorizes a device once,
 * not once per page load.
 */

const KEY = 'orchid.token'

/** The token this client holds, or null when it has none. */
export function getToken(): string | null {
  return localStorage.getItem(KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token.trim())
}

export function clearToken(): void {
  localStorage.removeItem(KEY)
}

/**
 * Adopt a token carried in the URL fragment, scrubbing it from the address
 * bar. Call once, before anything talks to the daemon.
 *
 * The fragment may carry more than the token (routes live there too), so only
 * the token=... segment is removed and the rest survives verbatim.
 */
export function adoptTokenFromLocation(): void {
  const hash = window.location.hash
  if (hash.includes('token=') === false) return

  const segments = hash.replace(/^#/, '').split('#')
  const kept: string[] = []
  for (const segment of segments) {
    const match = /^token=(.+)$/.exec(segment)
    if (match?.[1] !== undefined) setToken(decodeURIComponent(match[1]))
    else if (segment !== '') kept.push(segment)
  }

  const rest = kept.length > 0 ? `#${kept.join('#')}` : ''
  history.replaceState(null, '', window.location.pathname + window.location.search + rest)
}

/** The Authorization header when this client holds a token; empty when not.
 *  Spread into fetch headers so a tokenless loopback session sends nothing. */
export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token === null ? {} : { Authorization: `Bearer ${token}` }
}
