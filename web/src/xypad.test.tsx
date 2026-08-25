/**
 * The XY pad speaks 0..1 on each axis and nothing else: the project decides
 * what a fraction means for each head. So what these tests pin down is the
 * translation from finger to fraction -- where on the surface was touched,
 * clamped to the pad -- and that the dot honestly draws the position the feed
 * reports, not the one the finger last claimed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { VcWidget } from './layout'
import { XYPad } from './xypad'

/* jsdom has no pointer capture; the component leans on it to keep a drag alive
   past the pad's edge, which is a browser concern these tests do not verify. */
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
})

const geometry = { x: 0, y: 0, width: 200, height: 200 }

function pad(over: Partial<VcWidget> = {}): VcWidget {
  return { type: 'xypad', id: 9, caption: 'Cabezas', padHeads: 4, geometry, ...over }
}

/** jsdom lays nothing out, so the surface must be told its size. */
function giveSize(surface: HTMLElement, width = 200, height = 100) {
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  })
}

describe('XYPad', () => {
  it('draws the dot and the readout where the feed says the pad is', () => {
    render(<XYPad widget={pad()} style={{}} position={{ x: 0.25, y: 0.5 }} onMove={vi.fn()} />)

    const surface = screen.getByRole('application')
    // The label reads the position out for a screen reader, in percent.
    expect(surface).toHaveAccessibleName('Cabezas: posición 25, 50')
    expect(screen.getByText('25 · 50')).toBeInTheDocument()
  })

  it('shows a pad that steers no heads honestly, with no surface to touch', () => {
    // Zero heads means a control that does nothing, and it must not pretend.
    render(
      <XYPad widget={pad({ padHeads: 0 })} style={{}} position={{ x: 0, y: 0 }} onMove={vi.fn()} />,
    )

    expect(screen.getByText('sin cabezas')).toBeInTheDocument()
    expect(screen.queryByRole('application')).not.toBeInTheDocument()
  })

  it('treats a widget without an id as unusable too', () => {
    // Every move addresses the widget by id; without one there is nothing to say.
    const { id: _absent, ...anonymous } = pad()
    render(<XYPad widget={anonymous} style={{}} position={{ x: 0, y: 0 }} onMove={vi.fn()} />)

    expect(screen.getByText('sin cabezas')).toBeInTheDocument()
  })

  it('aims at the tapped fraction of the surface', () => {
    const onMove = vi.fn()
    render(<XYPad widget={pad()} style={{}} position={{ x: 0, y: 0 }} onMove={onMove} />)

    const surface = screen.getByRole('application')
    giveSize(surface, 200, 100)
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 50, clientY: 75 })

    expect(onMove).toHaveBeenCalledWith(9, 0.25, 0.75)
  })

  it('keeps aiming while dragging, and clamps when the finger leaves the pad', () => {
    const onMove = vi.fn()
    render(<XYPad widget={pad()} style={{}} position={{ x: 0, y: 0 }} onMove={onMove} />)

    const surface = screen.getByRole('application')
    giveSize(surface, 200, 100)
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 50 })
    expect(onMove).toHaveBeenLastCalledWith(9, 0.5, 0.5)

    // The finger drifts past the corner: the pad pins the heads to its edge
    // instead of sending coordinates the project never promised to honour.
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: -40 })
    expect(onMove).toHaveBeenLastCalledWith(9, 1, 0)
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('stops aiming once the finger lifts', () => {
    const onMove = vi.fn()
    render(<XYPad widget={pad()} style={{}} position={{ x: 0, y: 0 }} onMove={onMove} />)

    const surface = screen.getByRole('application')
    giveSize(surface, 200, 100)
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 50 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 20, clientY: 20 })

    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('ignores a stray move that never began with a press', () => {
    const onMove = vi.fn()
    render(<XYPad widget={pad()} style={{}} position={{ x: 0, y: 0 }} onMove={onMove} />)

    const surface = screen.getByRole('application')
    giveSize(surface, 200, 100)
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 50 })

    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores a tap before the surface has any size, rather than aiming with NaN', () => {
    const onMove = vi.fn()
    render(<XYPad widget={pad()} style={{}} position={{ x: 0, y: 0 }} onMove={onMove} />)

    // jsdom's default rect is all zeroes -- the same shape as a surface the
    // browser has not laid out yet.
    fireEvent.pointerDown(screen.getByRole('application'), {
      pointerId: 1,
      clientX: 50,
      clientY: 50,
    })

    expect(onMove).not.toHaveBeenCalled()
  })

  it('recalls a stored position preset as a move to that position', async () => {
    const onMove = vi.fn()
    const onToggle = vi.fn()
    render(
      <XYPad
        widget={pad({
          padPresets: [{ id: 0, type: 'Position', name: 'Centro escenario', x: 0.3, y: 0.7 }],
        })}
        style={{}}
        position={{ x: 0, y: 0 }}
        onMove={onMove}
        onToggle={onToggle}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Centro escenario' }))
    expect(onMove).toHaveBeenCalledWith(9, 0.3, 0.7)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('fires a function preset instead of moving the pad', async () => {
    const onMove = vi.fn()
    const onToggle = vi.fn()
    render(
      <XYPad
        widget={pad({ padPresets: [{ id: 1, type: 'EFX', name: 'Círculos', function: 55 }] })}
        style={{}}
        position={{ x: 0, y: 0 }}
        onMove={onMove}
        onToggle={onToggle}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Círculos' }))
    expect(onToggle).toHaveBeenCalledWith(55)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('labels a nameless preset with its kind rather than nothing', () => {
    render(
      <XYPad
        widget={pad({ padPresets: [{ id: 2, type: 'Scene', name: '', function: 8 }] })}
        style={{}}
        position={{ x: 0, y: 0 }}
        onMove={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Scene' })).toBeInTheDocument()
  })
})
