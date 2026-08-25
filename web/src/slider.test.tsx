/**
 * The drawn slider, tested for what it promises.
 *
 * The contract of slider.tsx is double: the operator sees a drawn bar whose
 * fill tracks the value, and the platform sees a real range input -- keyboard,
 * screen reader and disabled state included. Both halves are observable, so
 * both are asserted: the fill through the --pct the track paints with, the
 * input through its ARIA role and attributes.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Slider } from './slider'

/** The track element the styles hang off. Null would mean the input escaped
 *  the drawing, which is exactly the leak the component exists to close. */
function trackOf(slider: HTMLElement): HTMLElement {
  const track = slider.closest<HTMLElement>('.track')
  expect(track).not.toBeNull()
  return track as HTMLElement
}

describe('the drawn bar', () => {
  it('keeps the real range input inside the drawn track', () => {
    render(<Slider value={10} onChange={() => {}} />)

    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('type', 'range')

    // The visual parts live alongside the input, under one track: what the
    // operator sees and what the platform drives are the same control.
    const track = trackOf(slider)
    expect(track.querySelector('.fill')).not.toBeNull()
    expect(track.querySelector('.thumb')).not.toBeNull()
  })

  it('paints the fill at the value, as a fraction of the declared range', () => {
    render(<Slider min={0} max={255} value={64} onChange={() => {}} />)

    // 64/255 is 25.09%; the operator reads a quarter bar.
    expect(trackOf(screen.getByRole('slider')).style.getPropertyValue('--pct')).toBe('25%')
  })

  it('assumes the 0..100 range when none is declared', () => {
    render(<Slider defaultValue={50} />)

    expect(trackOf(screen.getByRole('slider')).style.getPropertyValue('--pct')).toBe('50%')
  })

  it('paints an empty bar instead of NaN when the range is degenerate', () => {
    // min === max can happen mid-edit; the bar must not paint garbage.
    render(<Slider min={5} max={5} value={5} onChange={() => {}} />)

    expect(trackOf(screen.getByRole('slider')).style.getPropertyValue('--pct')).toBe('0%')
  })

  it('takes the caller-declared fill colour', () => {
    // The live desk paints green so a bar driving the rig reads as live.
    render(<Slider value={50} onChange={() => {}} fill="green" />)

    expect(trackOf(screen.getByRole('slider')).style.getPropertyValue('--fill-colour')).toBe(
      'green',
    )
  })
})

describe('reporting movement', () => {
  it('hands the new value to the callbacks the caller passed', () => {
    const values: string[] = []
    render(
      <Slider
        min={0}
        max={255}
        defaultValue={0}
        onInput={(e) => values.push((e.target as HTMLInputElement).value)}
      />,
    )

    fireEvent.input(screen.getByRole('slider'), { target: { value: '128' } })

    expect(values).toEqual(['128'])
  })

  it('redraws the fill as an uncontrolled slider moves', () => {
    // Release-only sliders (scene values) still have to show where the finger
    // is between the press and the release.
    render(<Slider min={0} max={100} defaultValue={0} />)

    const slider = screen.getByRole('slider')
    fireEvent.input(slider, { target: { value: '40' } })

    expect(trackOf(slider).style.getPropertyValue('--pct')).toBe('40%')
  })

  it('lets the parent keep the last word on a controlled slider', () => {
    // A controlled slider whose parent ignores the event must snap back: the
    // drawn bar shows the desk's truth, not the rejected gesture.
    render(<Slider min={0} max={100} value={30} onChange={() => {}} />)

    const slider = screen.getByRole('slider')
    fireEvent.input(slider, { target: { value: '80' } })

    expect(trackOf(slider).style.getPropertyValue('--pct')).toBe('30%')
  })
})

describe('disabled state', () => {
  it('passes disabled through to the real input, where keyboards and readers see it', () => {
    render(<Slider value={20} onChange={() => {}} disabled />)

    expect(screen.getByRole('slider')).toBeDisabled()
  })
})
