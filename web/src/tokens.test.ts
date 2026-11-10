import { describe, expect, it } from 'vitest'
import { THEMES } from './tema'
import css from './theme.css?raw'

/**
 * The colour tokens, held to the contrast they promise.
 *
 * A colour that looks right on the designer's monitor and fails on a phone in
 * a dark room is the most ordinary way a screen becomes unreadable, and the
 * least visible one in review. So the stylesheet is read here, block by block,
 * and every pair of a text role and a background role is measured with the
 * WCAG formula -- the same one Apple's Accessibility Inspector uses.
 */

/** The custom properties declared directly in the first block that opens
 *  with `selector {`. Only literal hex values: aliases are someone else's. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no block ${selector}`)
  const body = css.slice(start, css.indexOf('\n}', start))
  const tokens: Record<string, string> = {}
  for (const match of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[match[1] as string] = (match[2] as string).toLowerCase()
  }
  return tokens
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const BACKGROUNDS = ['bg-base', 'bg-elevated-1', 'bg-elevated-2', 'bg-elevated-3']

/* Everything that is ever set as the colour of text. */
const TEXT = ['label-1', 'label-2', 'accent-text', 'live', 'danger', 'warning']

const themes = {
  Claro: block('[data-theme="light"]'),
  Gris: block('[data-theme="grey"]'),
  Oscuro: block(':root,\n[data-theme="stage"],\n[data-theme="light"] .plan-frame'),
  Pase: block('[data-theme="blackout"]'),
}

describe('the colour tokens', () => {
  for (const [name, tokens] of Object.entries(themes)) {
    describe(name, () => {
      it('declares every role this test measures', () => {
        for (const role of [...BACKGROUNDS, ...TEXT, 'label-3', 'edge']) {
          expect(tokens[role], role).toMatch(/^#[0-9a-f]{6}$/)
        }
      })

      for (const text of TEXT) {
        it(`${text} reads at 4.5:1 or better on every background`, () => {
          for (const background of BACKGROUNDS) {
            const ratio = contrast(tokens[text] as string, tokens[background] as string)
            expect(ratio, `${text} on ${background}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
              4.5,
            )
          }
        })
      }

      /* A placeholder is not information, but it still has to be found. */
      it('label-3 clears 2.3:1, enough to find a placeholder', () => {
        for (const background of BACKGROUNDS) {
          const ratio = contrast(tokens['label-3'] as string, tokens[background] as string)
          expect(ratio, background).toBeGreaterThanOrEqual(2.3)
        }
      })
    })
  }

  for (const [name, tokens] of Object.entries(themes)) {
    it(`${name}: the label on the prominent button reads at 4.5:1`, () => {
      const ratio = contrast(tokens['on-accent'] as string, tokens['accent-fill'] as string)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('Oscuro: the secondary text stays well above the floor, 6:1 at its worst', () => {
    const tokens = themes.Oscuro
    for (const background of BACKGROUNDS) {
      expect(
        contrast(tokens['label-2'] as string, tokens[background] as string),
      ).toBeGreaterThanOrEqual(6)
    }
  })

  /* Rods see green and blue. The pass is built from the red primary alone. */
  it('Pase: every literal colour is pure red, with no green and no blue', () => {
    const start = css.indexOf('[data-theme="blackout"] {')
    const body = css.slice(start, css.indexOf('\n}', start))
    const hexes = [...body.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase())
    expect(hexes.length).toBeGreaterThan(10)
    for (const hex of hexes) expect(hex.slice(3), hex).toBe('0000')

    const rgbs = [...body.matchAll(/rgb\((\d+) (\d+) (\d+)/g)]
    for (const [whole, , g, b] of rgbs) {
      if (whole.startsWith('rgb(0 0 0')) continue
      expect([g, b], whole).toEqual(['0', '0'])
    }
  })

  /* Asked for by the system, more contrast means every control edge is
     visible on its own: WCAG's 3:1 for the boundary of a component. */
  describe('with prefers-contrast', () => {
    const start = css.indexOf('@media (prefers-contrast: more)')
    const media = css.slice(start, css.indexOf('\n}\n', start))
    /** A token as the media block redeclares it for one theme. */
    const raised = (selector: string, role: string) => {
      const at = media.indexOf(`${selector} {`)
      if (at < 0) return undefined
      const body = media.slice(at, media.indexOf('}', at))
      return new RegExp(`--${role}:\\s*(#[0-9a-f]{6})`).exec(body)?.[1]
    }
    const selectors = {
      Claro: '[data-theme="light"]',
      Gris: '[data-theme="grey"]',
      Oscuro: ':root:not([data-theme="blackout"], [data-theme="light"], [data-theme="grey"])',
      Pase: '[data-theme="blackout"]',
    } as const

    for (const [name, selector] of Object.entries(selectors)) {
      const tokens = themes[name as keyof typeof themes]
      it(`${name}: every edge clears 3:1 against every background`, () => {
        const edge = raised(selector, 'edge')
        expect(edge, `${name} declares no edge`).toBeDefined()
        for (const background of BACKGROUNDS) {
          expect(
            contrast(edge as string, tokens[background] as string),
            background,
          ).toBeGreaterThanOrEqual(3)
        }
      })

      it(`${name}: the text it raises still reads at 4.5:1`, () => {
        for (const role of ['label-2', 'accent-text']) {
          const value = raised(selector, role)
          if (value === undefined) continue
          for (const background of BACKGROUNDS) {
            expect(
              contrast(value, tokens[background] as string),
              `${role} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
      })
    }
  })

  /* A theme offered in Ajustes and missing here would paint the defaults
     and call itself something else. */
  it('every theme the settings offer is drawn by the stylesheet', () => {
    for (const theme of THEMES) expect(css, theme).toContain(`[data-theme="${theme}"]`)
  })

  it('the measure itself is right: black on white is 21:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })
})
