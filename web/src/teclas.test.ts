/**
 * @vitest-environment jsdom
 *
 * This file borrows jsdom even though teclas.ts is pure logic: both functions
 * take a real KeyboardEvent, and typingSomewhere asks what kind of element the
 * event landed on. Stubbing four element classes in node would test the stubs.
 */
import { describe, expect, it } from 'vitest'
import { keySequenceOf, typingSomewhere } from './teclas'

/** A keydown as the browser would deliver it. */
function press(
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {},
): string | null {
  return keySequenceOf(new KeyboardEvent('keydown', { key, ...mods }))
}

describe('keySequenceOf', () => {
  it('spells a bare letter uppercase, the way the .qxw stores it', () => {
    // The binding is matched by string equality against QKeySequence text, so
    // "a" pressed to capture and "A" delivered with caps lock on must come out
    // as the same spelling.
    expect(press('a')).toBe('A')
    expect(press('A')).toBe('A')
  })

  it('prefixes modifiers in one fixed order', () => {
    // Matching is string equality; if the order ever wobbled, the key that
    // captured the binding would no longer be the key that fires it.
    expect(press('k', { ctrlKey: true })).toBe('Ctrl+K')
    expect(press('k', { ctrlKey: true, altKey: true })).toBe('Ctrl+Alt+K')
    expect(press('k', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })).toBe(
      'Ctrl+Alt+Shift+Meta+K',
    )
  })

  it('handles function keys, bare and chorded', () => {
    // F-keys are the classic QLC+ scene bindings (Ctrl+F1..F12 on the frame).
    expect(press('F1')).toBe('F1')
    expect(press('F12', { ctrlKey: true })).toBe('Ctrl+F12')
    expect(press('F1', { shiftKey: true })).toBe('Shift+F1')
  })

  it('returns null while the chord is only half pressed', () => {
    // Holding Ctrl on the way to Ctrl+F1 fires a keydown of its own; binding
    // it would make every chord impossible to enter.
    expect(press('Control', { ctrlKey: true })).toBeNull()
    expect(press('Shift', { shiftKey: true })).toBeNull()
    expect(press('Alt', { altKey: true })).toBeNull()
    expect(press('Meta', { metaKey: true })).toBeNull()
  })

  it('renames the keys QKeySequence spells differently from the browser', () => {
    // The file is shared with QLC+ itself, so its spelling wins: a binding
    // saved here must fire when the same project is opened over there.
    expect(press(' ')).toBe('Space')
    expect(press('ArrowUp')).toBe('Up')
    expect(press('ArrowLeft')).toBe('Left')
    expect(press('Escape')).toBe('Esc')
    expect(press('Delete')).toBe('Del')
    expect(press('PageDown')).toBe('PgDown')
  })

  it('keeps Shift on letters and named keys but not on symbols', () => {
    // Qt writes Shift+A for a shifted letter but bakes the shift into a
    // symbol: pressing Shift+1 arrives as "!" and is stored as "!".
    expect(press('A', { shiftKey: true })).toBe('Shift+A')
    expect(press(' ', { shiftKey: true })).toBe('Shift+Space')
    expect(press('!', { shiftKey: true })).toBe('!')
  })

  it('spells digits and their chords plainly', () => {
    expect(press('1')).toBe('1')
    expect(press('1', { ctrlKey: true })).toBe('Ctrl+1')
  })
})

/** Dispatch a keydown on a target and hand back the event, target attached. */
function keyOn(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true })
  target.dispatchEvent(event)
  return event
}

/** jsdom never implemented isContentEditable (whatwg/jsdom#1670), so the
 *  answer a real browser would give is pinned on the node by hand. */
function editability<T extends HTMLElement>(element: T, value: boolean): T {
  Object.defineProperty(element, 'isContentEditable', { value })
  return element
}

describe('typingSomewhere', () => {
  it('treats form fields as owning the keyboard', () => {
    // An operator typing a caption must not fire the Space bound to the
    // master while doing it.
    expect(typingSomewhere(keyOn(document.createElement('input')))).toBe(true)
    expect(typingSomewhere(keyOn(document.createElement('textarea')))).toBe(true)
    expect(typingSomewhere(keyOn(document.createElement('select')))).toBe(true)
  })

  it('treats a contenteditable region as owning the keyboard', () => {
    const region = editability(document.createElement('div'), true)
    expect(typingSomewhere(keyOn(region))).toBe(true)
  })

  it('lets shortcuts through from ordinary elements', () => {
    // Focus parked on a button or a plain div is exactly where mid-show
    // shortcuts are supposed to work.
    expect(typingSomewhere(keyOn(editability(document.createElement('button'), false)))).toBe(false)
    expect(typingSomewhere(keyOn(editability(document.createElement('div'), false)))).toBe(false)
  })

  it('lets shortcuts through when the event has no element at all', () => {
    // A keydown that reached the document (nothing focused) is the normal
    // state of a console mid-show.
    expect(typingSomewhere(keyOn(document))).toBe(false)
  })
})
