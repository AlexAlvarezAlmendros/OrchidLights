/**
 * The matrix widget is a fader plus a bank of presets, and the presets carry
 * the repo's honesty rule in their `applicable` flag: colours and animations
 * are buttons, while knobs, images and text are shown but never offered,
 * because a control that looks live and does nothing is the failure this
 * project exists to avoid. The tests hold the component to that contract.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { VcWidget } from './layout'
import { MatrixWidget } from './matrix'

const geometry = { x: 0, y: 0, width: 200, height: 200 }

function matrix(over: Partial<VcWidget> = {}): VcWidget {
  return { type: 'matrix', id: 11, caption: 'Bloque LED', functionId: 30, geometry, ...over }
}

/* The daemon's preset vocabulary: Color1..Color5 slots, their Knob and Reset
   forms, Animation, Image and Text. `applicable` is what it computes for each. */
const bank: NonNullable<VcWidget['presets']> = [
  { id: 0, type: 'Color1', color: '#ff0000', applicable: true },
  { id: 1, type: 'Color2Knob', color: '#00ff00', applicable: false },
  { id: 2, type: 'Animation', resource: 'Fill', applicable: true },
  { id: 3, type: 'Image', resource: 'logo.gif', applicable: false },
  { id: 4, type: 'Color1Reset', applicable: true },
]

describe('MatrixWidget', () => {
  it('shows a widget with no matrix honestly, with nothing to ride', () => {
    const { functionId: _absent, ...unassigned } = matrix()
    render(
      <MatrixWidget
        widget={unassigned}
        style={{}}
        value={0}
        onLevel={vi.fn()}
        onPreset={vi.fn()}
      />,
    )

    expect(screen.getByText('sin matriz')).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('treats a widget without an id the same way', () => {
    const { id: _absent, ...anonymous } = matrix()
    render(
      <MatrixWidget widget={anonymous} style={{}} value={0} onLevel={vi.fn()} onPreset={vi.fn()} />,
    )

    expect(screen.getByText('sin matriz')).toBeInTheDocument()
  })

  it('draws the fader at the level the feed reports', () => {
    render(
      <MatrixWidget
        widget={matrix()}
        style={{}}
        value={128}
        onLevel={vi.fn()}
        onPreset={vi.fn()}
      />,
    )

    const fader = screen.getByRole('slider', { name: 'Bloque LED: intensidad' })
    expect((fader as HTMLInputElement).value).toBe('128')
  })

  it('sends a fader move as a level on this widget', () => {
    const onLevel = vi.fn()
    render(
      <MatrixWidget widget={matrix()} style={{}} value={0} onLevel={onLevel} onPreset={vi.fn()} />,
    )

    fireEvent.change(screen.getByRole('slider'), { target: { value: '200' } })
    expect(onLevel).toHaveBeenCalledWith(11, 200)
  })

  it('offers colour and animation presets, and applies them by id', async () => {
    const onPreset = vi.fn()
    render(
      <MatrixWidget
        widget={matrix({ presets: bank })}
        style={{}}
        value={0}
        onLevel={vi.fn()}
        onPreset={onPreset}
      />,
    )

    // The animation preset wears its script's name.
    await userEvent.click(screen.getByRole('button', { name: 'Fill' }))
    expect(onPreset).toHaveBeenCalledWith(11, 2)

    // The reset form is a button too: it clears the colour slot.
    await userEvent.click(screen.getByRole('button', { name: '↺' }))
    expect(onPreset).toHaveBeenCalledWith(11, 4)
  })

  it('shows knobs and images but keeps them dead, so they cannot lie', async () => {
    const onPreset = vi.fn()
    render(
      <MatrixWidget
        widget={matrix({ presets: bank })}
        style={{}}
        value={0}
        onLevel={vi.fn()}
        onPreset={onPreset}
      />,
    )

    const knob = screen.getByTitle('#00ff00')
    const image = screen.getByRole('button', { name: 'logo.gif' })
    expect(knob).toBeDisabled()
    expect(image).toBeDisabled()

    // user-event refuses disabled targets the way a browser does.
    await userEvent.click(image).catch(() => {})
    expect(onPreset).not.toHaveBeenCalled()
  })

  it('labels a colour preset with the colour itself, not the word for it', () => {
    render(
      <MatrixWidget
        widget={matrix({ presets: bank })}
        style={{}}
        value={0}
        onLevel={vi.fn()}
        onPreset={vi.fn()}
      />,
    )

    // On a bank of eight the label is the swatch: background colour, no text.
    const swatch = screen.getByTitle('#ff0000')
    expect(swatch).toHaveStyle({ background: '#ff0000' })
    expect(swatch).toHaveTextContent('')
    expect(swatch).toBeEnabled()
  })

  it('draws no preset bank when the widget has none', () => {
    render(
      <MatrixWidget widget={matrix()} style={{}} value={0} onLevel={vi.fn()} onPreset={vi.fn()} />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
