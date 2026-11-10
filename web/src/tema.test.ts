// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { CHROME, THEMES, storeTheme, storedTheme, togglePass } from './tema'

/**
 * Four themes for four rooms, and the pass in and out of them by feel.
 */
describe('the themes', () => {
  beforeEach(() => localStorage.clear())

  it('start dark: the desk is used in the dark', () => {
    expect(storedTheme()).toBe('stage')
  })

  it('come back as they were left, and forget what this version does not know', () => {
    storeTheme('light')
    expect(storedTheme()).toBe('light')
    localStorage.setItem('orchid.theme', 'sepia')
    expect(storedTheme()).toBe('stage')
  })

  it('leave the pass for the theme the room was in, not for a default', () => {
    storeTheme('grey')
    expect(togglePass('grey')).toBe('blackout')
    storeTheme('blackout')
    expect(togglePass('blackout')).toBe('grey')

    storeTheme('light')
    storeTheme('blackout')
    expect(togglePass('blackout')).toBe('light')
  })

  it('leave the pass for the dark one when nothing else was ever chosen', () => {
    storeTheme('blackout')
    expect(togglePass('blackout')).toBe('stage')
  })

  it('each paint the browser chrome with their own base', () => {
    for (const theme of THEMES) expect(CHROME[theme]).toMatch(/^#[0-9a-f]{6}$/)
    expect(CHROME.blackout).toBe('#000000')
  })
})
