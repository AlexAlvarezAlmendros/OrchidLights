/**
 * The desktop shell, seen from the page.
 *
 * When this interface runs inside the OrchidLights desktop window, Tauri
 * plants `__TAURI_INTERNALS__` on `window` and the shell registers a pair of
 * commands for the one thing a browser cannot do: native file dialogs over
 * the whole disk. Everything else stays identical between the window and a
 * phone -- that is the point of the architecture -- so this module is small
 * and must stay small.
 *
 * In a browser every function here says so honestly: `isShell()` is false and
 * the pickers reject, and the caller offers the browser path instead (the
 * projects directory, which the daemon serves by name).
 */

interface TauriInternals {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
}

function internals(): TauriInternals | null {
  const candidate = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  return candidate ?? null
}

export function isShell(): boolean {
  return internals() !== null
}

/** Native "open project" dialog. Resolves to an absolute path, or null when
 *  the operator cancelled. Rejects outside the shell. */
export async function pickProjectToOpen(): Promise<string | null> {
  const tauri = internals()
  if (tauri === null) throw new Error('No hay carcasa de escritorio')
  const path = await tauri.invoke('pick_open_file')
  return typeof path === 'string' ? path : null
}

/** Native "save as" dialog, same contract. */
export async function pickProjectToSave(): Promise<string | null> {
  const tauri = internals()
  if (tauri === null) throw new Error('No hay carcasa de escritorio')
  const path = await tauri.invoke('pick_save_file')
  return typeof path === 'string' ? path : null
}

/** The page's answer to the close question was "go": the shell takes the
 *  daemon down tidy and ends. Saving, if asked for, already happened -- the
 *  page saves through the daemon, where saving lives. */
export async function resolveClose(): Promise<void> {
  const tauri = internals()
  if (tauri === null) return
  await tauri.invoke('resolve_close')
}
