import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentLang, setLang, t } from './i18n'

/** The node environment has no localStorage; a Map wearing the Storage
 *  interface stands in for it, one fresh instance per test. */
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, value)
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('currentLang', () => {
  it('speaks Spanish out of the box', () => {
    // The app is written in Spanish; a fresh browser with nothing stored must
    // read as the source language, not as a guess.
    expect(currentLang()).toBe('es')
  })

  it('reads anything unexpected in storage as Spanish', () => {
    // A future build may store languages this one does not ship. Falling back
    // beats rendering a console in a language that does not exist yet.
    localStorage.setItem('orchid.lang', 'de')
    expect(currentLang()).toBe('es')
    localStorage.setItem('orchid.lang', '')
    expect(currentLang()).toBe('es')
  })
})

describe('setLang', () => {
  it('persists the choice in storage, not in module state', () => {
    // The choice must survive a reload, which means it must live in
    // localStorage: a different storage (another browser) knows nothing of
    // it, and coming back to the first one finds it again.
    const thisBrowser = localStorage
    setLang('en')
    expect(currentLang()).toBe('en')

    vi.stubGlobal('localStorage', memoryStorage())
    expect(currentLang()).toBe('es')

    vi.stubGlobal('localStorage', thisBrowser)
    expect(currentLang()).toBe('en')
  })
})

describe('t', () => {
  it('leaves the Spanish text alone in Spanish', () => {
    expect(t('Consola')).toBe('Consola')
  })

  it('translates the chrome once English is chosen', () => {
    setLang('en')
    expect(t('Consola')).toBe('Console')
    expect(t('Deshacer')).toBe('Undo')
  })

  it('falls back to the Spanish text for an untranslated string, never a key', () => {
    // Coverage is incremental by design; a string the dictionary has not
    // reached yet must come out as readable Spanish words. An operator
    // mid-show reads words, not identifiers.
    setLang('en')
    expect(t('Cortina de humo trasera')).toBe('Cortina de humo trasera')
  })

  it('returns to Spanish when the choice is switched back', () => {
    setLang('en')
    setLang('es')
    expect(t('Consola')).toBe('Consola')
  })
})
