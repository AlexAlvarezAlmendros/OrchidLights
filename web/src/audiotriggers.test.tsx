/**
 * Audio triggers are a switch and a spectrum. The switch is deliberate --
 * opening a microphone is not a neutral act -- so what matters here is that
 * the toggle says which way it is about to flip, that the daemon's failure to
 * get an input is said out loud, and that the spectrum honestly draws what the
 * feed reports: bar heights from levels, assigned bands marked as watched.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AudioTriggers } from './audiotriggers'
import type { VcWidget } from './layout'

const geometry = { x: 0, y: 0, width: 300, height: 150 }

type Bar = NonNullable<VcWidget['bars']>[number]

/** A bar as the daemon writes it: name, band index, thresholds, and what it drives. */
function bar(index: number, over: Partial<Bar> = {}): Bar {
  return {
    name: `Bar ${index}`,
    index,
    volume: false,
    minThreshold: 51,
    maxThreshold: 204,
    drives: 'function',
    functionId: 12,
    ...over,
  }
}

function triggers(over: Partial<VcWidget> = {}): VcWidget {
  return {
    type: 'audiotriggers',
    id: 5,
    caption: 'Ritmo',
    bands: 4,
    bars: [bar(0), bar(2, { drives: 'dmx', channels: 3 })],
    geometry,
    ...over,
  }
}

function draw(over: Partial<Parameters<typeof AudioTriggers>[0]> = {}) {
  const props = {
    widget: triggers(),
    style: {},
    spectrum: [] as number[],
    volume: 0,
    enabled: false,
    capturing: false,
    onToggle: vi.fn(),
    ...over,
  }
  return { ...render(<AudioTriggers {...props} />), onToggle: props.onToggle }
}

/** The bands, in order. They are drawing, not controls, so no role finds them. */
function bands(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.audio-band'))
}

describe('AudioTriggers', () => {
  it('shows a widget with no assigned bars honestly, with no switch to press', () => {
    // A microphone that could drive nothing is a microphone opened for nothing.
    draw({ widget: triggers({ bars: [] }) })

    expect(screen.getByText('sin barras asignadas')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers to listen while off, and asks the daemon to start', async () => {
    const { onToggle } = draw({ enabled: false })

    const toggle = screen.getByRole('button', { name: 'Escuchar' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(5, true)
  })

  it('says it is listening while on, and asks the daemon to stop', async () => {
    const { onToggle } = draw({ enabled: true, capturing: true })

    const toggle = screen.getByRole('button', { name: 'Escuchando' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith(5, false)
  })

  it('says out loud when the daemon could not open an input', () => {
    // Switched on but not capturing is the daemon's "I tried and could not".
    draw({ enabled: true, capturing: false })

    expect(screen.getByText('No se pudo abrir ninguna entrada de audio.')).toBeInTheDocument()
  })

  it("prefers the daemon's own words for why the input failed", () => {
    draw({ enabled: true, capturing: false, unavailable: 'El dispositivo está en uso' })

    expect(screen.getByText('El dispositivo está en uso')).toBeInTheDocument()
  })

  it('shows no failure while capturing, nor while switched off', () => {
    const { unmount } = draw({ enabled: true, capturing: true })
    expect(screen.queryByText(/No se pudo abrir/)).not.toBeInTheDocument()
    unmount()

    draw({ enabled: false, capturing: false })
    expect(screen.queryByText(/No se pudo abrir/)).not.toBeInTheDocument()
  })

  it('draws each band at the height the feed reports', () => {
    const { container } = draw({ spectrum: [0, 128, 255, 64] })

    const heights = bands(container).map((band) => band.style.height)
    expect(heights).toEqual(['0%', '50%', '100%', '25%'])
  })

  it("draws the widget's own band count, flat, before any spectrum arrives", () => {
    const { container } = draw({ widget: triggers({ bands: 4 }), spectrum: [] })

    const drawn = bands(container)
    expect(drawn).toHaveLength(4)
    for (const band of drawn) {
      expect(band.style.height).toBe('0%')
    }
  })

  it('marks the bands a bar is watching, so an idle band is visibly idle', () => {
    // Bars sit on bands 0 and 2; bands 1 and 3 have nothing listening.
    const { container } = draw({ spectrum: [10, 10, 10, 10] })

    const marked = bands(container).map((band) => band.getAttribute('data-assigned'))
    expect(marked).toEqual(['true', 'false', 'true', 'false'])
  })

  it('does not mark a band whose bar only follows the volume', () => {
    // The volume bar watches the whole signal, not its band's slice.
    const { container } = draw({
      widget: triggers({ bars: [bar(1, { name: 'Volume', volume: true })] }),
      spectrum: [0, 0, 0, 0],
    })

    const marked = bands(container).map((band) => band.getAttribute('data-assigned'))
    expect(marked).toEqual(['false', 'false', 'false', 'false'])
  })

  it('reads out how many bars drive things and the volume the feed reports', () => {
    draw({ volume: 128 })

    expect(screen.getByText('2 barras · vol 50%')).toBeInTheDocument()
  })
})
