import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isShell,
  leaveKiosk,
  pickProjectToOpen,
  pickProjectToSave,
  resolveClose,
  takePendingOpen,
  toggleFullscreen,
} from './shell'

interface Invocation {
  command: string
  args?: Record<string, unknown>
}

/** A window with no Tauri planted on it: the page running in a plain browser
 *  (or on a phone), which is the normal case, not the degenerate one. */
function browserWindow(): void {
  vi.stubGlobal('window', {})
}

/** The desktop shell: Tauri's internals answering each command from a table,
 *  recording what crossed the boundary -- that is what the Rust side sees. */
function shellWindow(answers: Record<string, unknown>): Invocation[] {
  const calls: Invocation[] = []
  vi.stubGlobal('window', {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        return Promise.resolve(answers[command])
      },
    },
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('in a plain browser, without the desktop shell', () => {
  it('says so honestly', () => {
    browserWindow()
    expect(isShell()).toBe(false)
  })

  it('rejects the native pickers so the caller offers the browser path', () => {
    // The pickers are the one thing a browser cannot fake; a silent null here
    // would read as "the operator cancelled" and no fallback would ever show.
    browserWindow()
    return Promise.all([
      expect(pickProjectToOpen()).rejects.toThrow(),
      expect(pickProjectToSave()).rejects.toThrow(),
    ])
  })

  it('reports no parked open request', async () => {
    browserWindow()
    await expect(takePendingOpen()).resolves.toBeNull()
  })

  it('swallows the window-level commands quietly', async () => {
    // Ctrl+F11 and the close handshake exist only in the desktop window; a
    // browser tab pressing them must lose nothing and see no error.
    browserWindow()
    await expect(resolveClose()).resolves.toBeUndefined()
    await expect(toggleFullscreen()).resolves.toBeUndefined()
  })

  it('keeps the kiosk door shut', async () => {
    browserWindow()
    await expect(leaveKiosk('1234')).resolves.toBe(false)
    await expect(leaveKiosk(null)).resolves.toBe(false)
  })
})

describe('inside the desktop shell', () => {
  it('knows it is there', () => {
    shellWindow({})
    expect(isShell()).toBe(true)
  })

  it('hands back the path the operator picked', async () => {
    shellWindow({ pick_open_file: '/shows/bolo.qxw', pick_save_file: '/shows/nuevo.qxw' })
    await expect(pickProjectToOpen()).resolves.toBe('/shows/bolo.qxw')
    await expect(pickProjectToSave()).resolves.toBe('/shows/nuevo.qxw')
  })

  it('reads a cancelled dialog as null, not as an error', async () => {
    // Cancelling is a normal outcome; only the missing shell is an error.
    shellWindow({})
    await expect(pickProjectToOpen()).resolves.toBeNull()
    await expect(pickProjectToSave()).resolves.toBeNull()
  })

  it('collects a parked open request once, and empty means none', async () => {
    shellWindow({ take_pending_open: '/parked/show.qxw' })
    await expect(takePendingOpen()).resolves.toBe('/parked/show.qxw')

    // The shell parks "" when nothing waits; the page must not open "".
    shellWindow({ take_pending_open: '' })
    await expect(takePendingOpen()).resolves.toBeNull()
  })

  it('forwards the PIN and only opens the kiosk on an exact yes', async () => {
    const calls = shellWindow({ leave_kiosk: true })
    await expect(leaveKiosk('2468')).resolves.toBe(true)
    expect(calls).toEqual([{ command: 'leave_kiosk', args: { pin: '2468' } }])

    // A shell answering anything but `true` -- false, garbage, undefined --
    // keeps the door shut: the kiosk fails locked, not open.
    shellWindow({ leave_kiosk: 'yes' })
    await expect(leaveKiosk('2468')).resolves.toBe(false)
    shellWindow({})
    await expect(leaveKiosk(null)).resolves.toBe(false)
  })

  it('tells the shell to take the daemon down when the page says go', async () => {
    const calls = shellWindow({})
    await resolveClose()
    expect(calls.map((c) => c.command)).toEqual(['resolve_close'])
  })
})
