/**
 * Keyboard bindings, spelled the way QLC+ spells them.
 *
 * A widget's shortcut is stored in the .qxw as QKeySequence text ("Ctrl+F1",
 * "Space", "A") -- the file is shared with QLC+ itself, so the spelling is not
 * ours to invent. One function turns a browser event into that spelling; the
 * editor uses it to capture and the runtime uses it to match, which is what
 * keeps "the key you pressed to bind" and "the key that fires it" the same key.
 */

/** Browser key names that QKeySequence writes differently. */
const NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Delete: 'Del',
  Insert: 'Ins',
  PageUp: 'PgUp',
  PageDown: 'PgDown',
}

/**
 * The QKeySequence text for a key event, or null when the event is only
 * modifiers (a half-pressed chord is not a binding).
 */
export function keySequenceOf(event: KeyboardEvent): string | null {
  const key = event.key
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null

  let name = NAMES[key] ?? key
  if (name.length === 1) name = name.toUpperCase()

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  /* Qt writes Shift+A for a shifted letter but bakes it into symbols ("!").
     Letters and named keys carry the modifier; symbols already are it. */
  if (event.shiftKey && (name.length > 1 || /[A-Z]/.test(name))) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(name)
  return parts.join('+')
}

/** True when the event happened somewhere that owns the keyboard already. */
export function typingSomewhere(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLSelectElement) return true
  return target.isContentEditable
}
