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

  it('strips en dashes, em dashes and mixed runs alike', () => {
    // Operators reach for whatever dash their keyboard offers; the workaround
    // is the padding, not the particular Unicode point they landed on.
    expect(headingOf(widget({ type: 'label', caption: '– Colores –' }))).toBe('Colores')
    expect(headingOf(widget({ type: 'label', caption: '—-— MAESTRO' }))).toBe('MAESTRO')
    expect(headingOf(widget({ type: 'label', caption: 'FX –—-' }))).toBe('FX')
  })

  it('keeps an en dash that is part of the name while shedding the padding', () => {
    expect(headingOf(widget({ type: 'label', caption: '– AÑOS 80–90 –' }))).toBe('AÑOS 80–90')
  })

  it('reads a label with no caption at all as empty', () => {
    expect(headingOf(widget({ type: 'label' }))).toBe('')
  })

  it('reduces a label that is nothing but dashes to nothing', () => {
    // "———" is a horizontal rule someone drew, not a group named after
    // punctuation.
    expect(headingOf(widget({ type: 'label', caption: '———' }))).toBe('')
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

  it('treats a dashes-only label as a spacer, like an empty one', () => {
    // Cleaning turns "———" into nothing, and nothing is not a heading: the
    // groups either side of a drawn rule belong together.
    const result = toSections(
      rows([widget({ id: 1 })], [widget({ type: 'label', caption: '———' })], [widget({ id: 2 })]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.controls.map((w) => w.id)).toEqual([1, 2])
  })

  it('lets a label mid-row close one group and open the next', () => {
    // Sections follow document order, not row boundaries: a label dragged into
    // the middle of a row splits the run exactly where it stands.
    const result = toSections(
      rows([
        widget({ id: 1, caption: 'ROJO' }),
        widget({ type: 'label', caption: 'FX' }),
        widget({ id: 2, caption: 'STROBE' }),
      ]),
    )

    expect(result).toHaveLength(2)
    expect(result[0]?.title).toBeNull()
    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['ROJO'])
    expect(result[1]?.title).toBe('FX')
    expect(result[1]?.controls.map((w) => w.caption)).toEqual(['STROBE'])
  })

  it('opens back-to-back labels as separate sections, the first left empty', () => {
    // Two headings in a row happen when a group was emptied. Both labels are in
    // the project; both must be on screen, one of them with nothing under it.
    const result = toSections(
      rows(
        [widget({ type: 'label', caption: 'A' }), widget({ type: 'label', caption: 'B' })],
        [widget({ id: 1 })],
      ),
    )

    expect(result.map((s) => s.title)).toEqual(['A', 'B'])
    expect(result[0]?.controls).toHaveLength(0)
    expect(result[1]?.controls.map((w) => w.id)).toEqual([1])
  })

  it('sends every slider mode to the levels column, whatever the mode is', () => {
    // Level, submaster or adjust: it is the shape that will not sit in a grid
    // of buttons, not the particular job the fader does.
    const result = toSections(
      rows([
        widget({ id: 1, type: 'slider', sliderMode: 'level', caption: 'Spots' }),
        widget({ id: 2, type: 'slider', sliderMode: 'submaster', caption: 'Master' }),
        widget({ id: 3, type: 'slider', sliderMode: 'adjust', caption: 'Velocidad' }),
      ]),
    )

    expect(result[0]?.levels.map((w) => w.caption)).toEqual(['Spots', 'Master', 'Velocidad'])
    expect(result[0]?.controls).toHaveLength(0)
  })

  it('keeps pressable widgets of every kind with the controls', () => {
    const result = toSections(
      rows([
        widget({ id: 1, type: 'cuelist', caption: 'Show' }),
        widget({ id: 2, type: 'xypad', caption: 'Movers' }),
        widget({ id: 3, type: 'frame', caption: 'Looks' }),
      ]),
    )

    expect(result[0]?.controls.map((w) => w.caption)).toEqual(['Show', 'Movers', 'Looks'])
    expect(result[0]?.levels).toHaveLength(0)
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

  it('leaves nested brackets whole rather than guessing where they split', () => {
    // "(A (B))" has no unambiguous name/aside boundary. Splitting it wrong
    // rewrites the label; not splitting it merely draws it long, as QLC+ does.
    expect(splitHeading('GRUPO (A (B))')).toEqual({ title: 'GRUPO (A (B))', note: null })
    expect(splitHeading('FX ((doble))')).toEqual({ title: 'FX ((doble))', note: null })
  })

  it('splits on the bracket that closes the line even when an earlier one exists', () => {
    expect(splitHeading('A (B) (C)')).toEqual({ title: 'A (B)', note: 'C' })
  })

  it('keeps a bracket holding only spaces, like an empty one', () => {
    expect(splitHeading('COLORES ( )')).toEqual({ title: 'COLORES ( )', note: null })
  })

  it('keeps a heading that is a lone empty bracket', () => {
    expect(splitHeading('()')).toEqual({ title: '()', note: null })
  })

  it('never loses a character', () => {
    for (const heading of [
      'COLORES (Washes + Spots)',
      'MAESTRO',
      '(sin usar)',
      'Wash (RGB) frontal',
      'Blinders (2)',
      'GRUPO (A (B))',
      'A (B) (C)',
    ]) {
      const { title, note } = splitHeading(heading)
      const letters = (text: string) => text.replace(/[\s()]/g, '')
      expect(letters(title + (note ?? ''))).toBe(letters(heading))
    }
  })
})
