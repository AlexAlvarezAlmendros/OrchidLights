import { describe, expect, it } from 'vitest'
import type { Row, VcWidget } from './layout'
import { headingOf, splitHeading, toSections } from './sections'

const widget = (over: Partial<VcWidget>): VcWidget =>
  ({
    type: 'button',
    geometry: { x: 0, y: 0, width: 100, height: 50 },
    children: [],
    ...over,
  }) as VcWidget

const rows = (...groups: VcWidget[][]): Row[] => groups.map((widgets, top) => ({ top, widgets }))

describe('headingOf', () => {
  it('takes the decoration off both ends', () => {
    expect(headingOf(widget({ type: 'label', caption: '— MAESTRO —' }))).toBe('MAESTRO')
    expect(headingOf(widget({ type: 'label', caption: '--- Colores ---' }))).toBe('Colores')
  })

  it('leaves the name alone', () => {
    expect(headingOf(widget({ type: 'label', caption: 'MOVIMIENTO WASHES' }))).toBe(
      'MOVIMIENTO WASHES',
    )
  })

  it('does not eat a dash inside the name', () => {
    expect(headingOf(widget({ type: 'label', caption: '— Front-fill —' }))).toBe('Front-fill')
  })
})

describe('toSections', () => {
  it('opens a section at each label and keeps what follows', () => {
    const result = toSections(
      rows(
        [widget({ type: 'label', caption: '— COLORES —' })],
        [widget({ id: 1, caption: 'ROJO' }), widget({ id: 2, caption: 'AZUL' })],
      ),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('COLORES')
    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['ROJO', 'AZUL'])
  })

  it('puts faders in their own list', () => {
    const result = toSections(
      rows([
        widget({ id: 1, caption: 'FULL ON' }),
        widget({ id: 2, type: 'slider', sliderMode: 'level', caption: 'Spots' }),
      ]),
    )
    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['FULL ON'])
    expect(result[0]?.levels.map((w) => w.caption)).toEqual(['Spots'])
  })

  it('keeps whatever comes before the first label', () => {
    // A console that opens with two buttons and only then names a group must
    // not lose them, which is what dropping the untitled run would do.
    const result = toSections(
      rows(
        [widget({ id: 1, caption: 'BLACKOUT' })],
        [widget({ type: 'label', caption: 'COLORES' })],
        [widget({ id: 2, caption: 'ROJO' })],
      ),
    )
    expect(result).toHaveLength(2)
    expect(result[0]?.title).toBeNull()
    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['BLACKOUT'])
  })

  it('never loses a widget', () => {
    // The property the whole thing rests on: a console rearranged for display
    // that drops a button is a console missing a cue on the night it matters.
    const all = [
      widget({ id: 1 }),
      widget({ type: 'label', caption: 'A' }),
      widget({ id: 2 }),
      widget({ id: 3, type: 'slider', sliderMode: 'submaster' }),
      widget({ type: 'label', caption: 'B' }),
      widget({ id: 4 }),
    ]
    const result = toSections(rows(all))
    const kept = result.flatMap((s) => [...s.controls, ...s.levels]).map((w) => w.id)
    expect(kept.sort()).toEqual([1, 2, 3, 4])
  })

  it('keeps a heading with nothing under it', () => {
    // Tidier to drop, and wrong: a label the operator wrote is in the project,
    // and a view that hides it is a view where something exists and cannot be
    // seen. An odd-looking empty heading is their project saying so.
    const result = toSections(
      rows([widget({ id: 1 })], [widget({ type: 'label', caption: 'VACÍA' })]),
    )
    expect(result).toHaveLength(2)
    expect(result[1]?.title).toBe('VACÍA')
    expect(result[1]?.controls).toHaveLength(0)
  })

  it('treats an empty label as a spacer, not a heading', () => {
    const result = toSections(
      rows([widget({ type: 'label', caption: '   ' })], [widget({ id: 1, caption: 'ROJO' })]),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBeNull()
  })

  it('keeps the order the operator arranged', () => {
    const result = toSections(
      rows([widget({ id: 3, caption: 'C' }), widget({ id: 1, caption: 'A' })]),
    )
    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['C', 'A'])
  })
})

/**
 * A heading and its bracketed aside.
 *
 * The operator writes one label to do two jobs -- "COLORES (Washes + Spots)" --
 * and the point of splitting it is to draw the second half as the caption it
 * already is. What must not happen is a split that eats a word, so every case
 * here is about the text surviving intact.
 */
describe('splitHeading', () => {
  it('takes the aside out of the brackets', () => {
    expect(splitHeading('COLORES (Washes + Spots + Bars + Blinders)')).toEqual({
      title: 'COLORES',
      note: 'Washes + Spots + Bars + Blinders',
    })
  })

  it('leaves a plain heading alone', () => {
    expect(splitHeading('INTENSIDAD POR GRUPO')).toEqual({
      title: 'INTENSIDAD POR GRUPO',
      note: null,
    })
  })

  it('keeps the words exactly as written, case and all', () => {
    // Retyping somebody's label in sentence case is an edit they did not ask
    // for, and on a desk their spelling is the thing they navigate by.
    const { title, note } = splitHeading('PARs Frontales (impares SÓLO)')
    expect(title).toBe('PARs Frontales')
    expect(note).toBe('impares SÓLO')
  })

  it('keeps a heading that is nothing but a bracket', () => {
    // "(sin usar)" is the whole name of that group, not an aside to nothing.
    expect(splitHeading('(sin usar)')).toEqual({ title: '(sin usar)', note: null })
  })

  it('keeps an empty bracket rather than dropping half the line', () => {
    expect(splitHeading('MAESTRO ()')).toEqual({ title: 'MAESTRO ()', note: null })
  })

  it('splits only on a bracket that closes the line', () => {
    // Mid-sentence brackets are part of the sentence.
    expect(splitHeading('Wash (RGB) frontal')).toEqual({
      title: 'Wash (RGB) frontal',
      note: null,
    })
  })

  it('never loses a character', () => {
    for (const heading of [
      'COLORES (Washes + Spots)',
      'MAESTRO',
      '(sin usar)',
      'Wash (RGB) frontal',
      'Blinders (2)',
    ]) {
      const { title, note } = splitHeading(heading)
      const letters = (text: string) => text.replace(/[\s()]/g, '')
      expect(letters(title + (note ?? ''))).toBe(letters(heading))
    }
  })
})
