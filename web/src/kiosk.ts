/**
 * The kiosk, as the page keeps it when there is no shell to keep it.
 *
 * Inside the desktop window the shell owns the door: it goes fullscreen, hands
 * the window an operator's key, closes the daemon's access mask and checks the
 * PIN (see shell.ts). A phone or a tablet in a browser has none of that, so
 * here the kiosk is three things this device can do alone:
 *
 *  - the flag in the URL, so a reload -- or the tablet rebooting into its
 *    bookmark -- comes back as a kiosk;
 *  - the browser's own fullscreen, where it has one;
 *  - a PIN chosen on the way in and kept on this device.
 *
 * That makes it a guard against a curious hand, not a lock: whoever can edit
 * the URL or clear the site data is out. What a paired phone may actually DO
 * is decided by the daemon, by the role of its key, and none of this changes
 * that.
 */

const PIN_KEY = 'orchid.kiosk-pin'

/** Whether the address says kiosk: `?kiosk=1`, or the same inside the hash. */
export function kioskInLocation(): boolean {
  return (
    new URLSearchParams(window.location.search).get('kiosk') === '1' ||
    window.location.hash.includes('kiosk=1')
  )
}

/** Whether this page closed the door itself, and so can open it again. A
 *  kiosk that arrived by URL alone has no PIN on record and stays shut. */
export function kioskIsOurs(): boolean {
  return window.localStorage.getItem(PIN_KEY) !== null
}

/**
 * Close the door from the page. An empty PIN is a door anybody may open, and
 * is recorded as such.
 *
 * The PIN is kept as typed: hashing needs crypto.subtle, which a desk reached
 * over plain http on a LAN does not have, and a hash of four digits protects
 * nothing from somebody already reading this device's storage.
 */
export function enterBrowserKiosk(pin: string): void {
  window.localStorage.setItem(PIN_KEY, pin)

  const url = new URL(window.location.href)
  url.searchParams.set('kiosk', '1')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)

  /* Best effort, and only inside the gesture that asked for it: an iPhone has
     no fullscreen for a page, and a browser that refuses still gets the
     kiosk's interface. */
  try {
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  } catch {
    /* A browser too old to return a promise. */
  }
}

/** Open the door this page closed. False when the PIN is wrong, or when the
 *  page never closed it. */
export function leaveBrowserKiosk(pin: string): boolean {
  const expected = window.localStorage.getItem(PIN_KEY)
  if (expected === null || pin !== expected) return false
  window.localStorage.removeItem(PIN_KEY)

  const url = new URL(window.location.href)
  url.searchParams.delete('kiosk')
  const hash = url.hash.replace(/[?&]kiosk=1/, '')
  window.history.replaceState(null, '', url.pathname + url.search + hash)

  if (document.fullscreenElement) {
    try {
      void document.exitFullscreen?.().catch(() => undefined)
    } catch {
      /* Same browser as above. */
    }
  }
  return true
}
