/**
 * The desk's four themes, one for each amount of light in the room, and the
 * one shortcut between them.
 *
 * Claro, Gris and Oscuro are chosen once for a room: the office where the
 * show is built, the half-light of a get-in, the show itself. The pass is
 * different -- it is switched on and off in the dark, by feel, and coming out
 * of it has to land back on whichever of the other three the room was in, not
 * on a default the operator then has to correct with dark-adapted eyes.
 */

export type Theme = 'light' | 'grey' | 'stage' | 'blackout'

/** In the order the settings offer them: from the most light to the least. */
export const THEMES: readonly Theme[] = ['light', 'grey', 'stage', 'blackout']

/** The browser's own chrome -- the status bar of an installed app, the address
 *  bar on a phone -- painted the base of each theme, since it is the one strip
 *  of screen the stylesheet cannot reach. */
export const CHROME: Record<Theme, string> = {
  light: '#f2f2f7',
  grey: '#333539',
  stage: '#0b0c0f',
  blackout: '#000000',
}

const KEY = 'orchid.theme'
/** The last theme that was not the pass: where Ctrl+Alt+P goes back to. */
const LIT_KEY = 'orchid.theme.lit'

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The theme this device was left in. Dark when it has none, or one this
 *  version does not know: the desk is used in the dark. */
export function storedTheme(): Theme {
  const value = read(KEY)
  return isTheme(value) ? value : 'stage'
}

/** Remembered on this device, along with the last one outside the pass. */
export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme)
    if (theme !== 'blackout') localStorage.setItem(LIT_KEY, theme)
  } catch {
    // Private windows can refuse storage; the theme still applies now.
  }
}

/** Into the pass, or back out of it to the theme the room was in. */
export function togglePass(current: Theme): Theme {
  if (current !== 'blackout') return 'blackout'
  const lit = read(LIT_KEY)
  return isTheme(lit) && lit !== 'blackout' ? lit : 'stage'
}
