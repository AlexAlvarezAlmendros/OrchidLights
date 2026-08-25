/**
 * Palettes, tested as the operator meets them: a counted list, honest when
 * empty, and an Aplicar that resolves exactly the chosen fixtures through the
 * palette's id -- the indirection that lets «Corporativo» retint every look
 * that carries it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FixtureState, type PaletteState, api } from './api'
import { Palettes } from './paletas'

vi.mock('./api', () => ({
  api: {
    palettes: vi.fn(),
    createPalette: vi.fn(),
    patchPalette: vi.fn(),
    removePalette: vi.fn(),
    applyPalette: vi.fn(),
  },
}))

const palette = (over: Partial<PaletteState> = {}): PaletteState => ({
  id: 7,
  name: 'Corporativo',
  type: 'Color',
  values: ['#ff8800'],
  fanning: { type: 'Flat', layout: 'XAscending', amount: 100, value: null },
  ...over,
})

const fixture = (id: number, name: string): FixtureState => ({
  id,
  name,
  universe: 1,
  address: 1,
  channels: 6,
  resolved: true,
})

function mount(over: Partial<ComponentProps<typeof Palettes>> = {}) {
  const onError = vi.fn()
  render(<Palettes fixtures={[]} onError={onError} {...over} />)
  return { onError }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.palettes).mockResolvedValue({ palettes: [] })
  vi.mocked(api.createPalette).mockResolvedValue({ id: 9 })
  vi.mocked(api.patchPalette).mockResolvedValue({ id: 7 })
  vi.mocked(api.removePalette).mockResolvedValue({ removed: 1 })
  vi.mocked(api.applyPalette).mockResolvedValue({ applied: 2 })
})

describe('Palettes', () => {
  it('counts the palettes in the summary and lists them by name and type', async () => {
    vi.mocked(api.palettes).mockResolvedValue({
      palettes: [palette(), palette({ id: 8, name: 'Frente', type: 'PanTilt', values: [10, 20] })],
    })
    mount()

    expect(await screen.findByText('Corporativo')).toBeInTheDocument()
    expect(screen.getByText('Palettes (2)')).toBeInTheDocument()
    expect(screen.getByText('Frente')).toBeInTheDocument()
    expect(screen.getByText('PanTilt')).toBeInTheDocument()
  })

  it('shows the colour a Color palette holds', async () => {
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    const { container } = render(<Palettes fixtures={[]} onError={vi.fn()} />)

    await screen.findByText('Corporativo')
    // The swatch is how the operator recognises the palette without opening it.
    expect(container.querySelector('.palette-swatch')).toHaveStyle({ background: '#ff8800' })
  })

  it('admits an empty library instead of pretending', async () => {
    mount()

    expect(
      await screen.findByText('Sin palettes: crea una y las escenas podrán referenciarla.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Palettes (0)')).toBeInTheDocument()
  })

  it('treats a failed listing as an empty library, not a crash', async () => {
    vi.mocked(api.palettes).mockRejectedValue(new Error('sin conexión'))
    mount()

    expect(await screen.findByText(/Sin palettes/)).toBeInTheDocument()
    expect(screen.getByText('Palettes (0)')).toBeInTheDocument()
  })

  it('creates a colour palette seeded white, trims the name, and clears the field', async () => {
    const user = userEvent.setup()
    mount()

    const name = screen.getByLabelText('Nombre')
    // No name, no palette: an unnamed palette cannot be referenced by eye.
    expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled()
    await user.type(name, '   ')
    expect(screen.getByRole('button', { name: 'Crear' })).toBeDisabled()

    await user.clear(name)
    await user.type(name, '  Corporativo  ')
    await user.click(screen.getByRole('button', { name: 'Crear' }))

    expect(api.createPalette).toHaveBeenCalledWith({
      type: 'Color',
      name: 'Corporativo',
      values: ['#ffffff'],
    })
    await waitFor(() => expect(name).toHaveValue(''))
    // The list is re-read from the daemon, not patched locally.
    await waitFor(() => expect(api.palettes).toHaveBeenCalledTimes(2))
  })

  it('seeds a multi-slot type with one zero per slot', async () => {
    const user = userEvent.setup()
    mount()

    await user.selectOptions(screen.getByLabelText('Tipo'), 'PanTilt')
    await user.type(screen.getByLabelText('Nombre'), 'Frente')
    await user.click(screen.getByRole('button', { name: 'Crear' }))

    // Pan and Tilt are two numbers; a single zero would be a malformed palette.
    expect(api.createPalette).toHaveBeenCalledWith({
      type: 'PanTilt',
      name: 'Frente',
      values: [0, 0],
    })
  })

  it('deletes by id and re-reads the list', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes)
      .mockResolvedValueOnce({ palettes: [palette()] })
      .mockResolvedValueOnce({ palettes: [] })
    mount()

    await user.click(await screen.findByRole('button', { name: 'Borrar Corporativo' }))

    expect(api.removePalette).toHaveBeenCalledWith(7)
    // The daemon's answer is the truth: the row goes when the reload says so.
    expect(await screen.findByText(/Sin palettes/)).toBeInTheDocument()
    expect(screen.queryByText('Corporativo')).toBeNull()
  })

  it('reports a refused deletion and keeps the row', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    vi.mocked(api.removePalette).mockRejectedValue(new Error('la usa la escena 3'))
    const { onError } = mount()

    await user.click(await screen.findByRole('button', { name: 'Borrar Corporativo' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('la usa la escena 3'))
    expect(screen.getByText('Corporativo')).toBeInTheDocument()
  })

  it('applies onto the chosen fixtures with the palette id', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    mount({ fixtures: [fixture(1, 'Spot izq'), fixture(2, 'Spot der')] })

    await user.click(await screen.findByRole('button', { name: 'Corporativo' }))

    // Every fixture starts chosen: applying to the whole rig is the common case.
    await user.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(api.applyPalette).toHaveBeenCalledWith(7, [1, 2])

    // Unticking narrows the application to what stays ticked.
    await user.click(screen.getByRole('checkbox', { name: 'Spot izq' }))
    await user.click(screen.getByRole('button', { name: 'Aplicar' }))
    expect(api.applyPalette).toHaveBeenLastCalledWith(7, [2])
  })

  it('cannot apply onto nothing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    mount({ fixtures: [fixture(1, 'Spot izq')] })

    await user.click(await screen.findByRole('button', { name: 'Corporativo' }))
    await user.click(screen.getByRole('checkbox', { name: 'Spot izq' }))

    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeDisabled()
  })

  it('offers no application when the rig has no fixtures', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    mount({ fixtures: [] })

    await user.click(await screen.findByRole('button', { name: 'Corporativo' }))

    // A button that could only ever apply to nothing would be a lie.
    expect(screen.queryByRole('button', { name: 'Aplicar' })).toBeNull()
  })

  it('patches a number slot keeping its siblings, by palette id', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({
      palettes: [palette({ id: 8, name: 'Frente', type: 'PanTilt', values: [10, 20] })],
    })
    mount()

    await user.click(await screen.findByRole('button', { name: 'Frente' }))
    const slot = screen.getByLabelText('Valor 1')
    fireEvent.change(slot, { target: { value: '99' } })
    fireEvent.blur(slot)

    // The whole array travels: dropping the untouched slot would zero Tilt.
    expect(api.patchPalette).toHaveBeenCalledWith(8, { values: [99, 20] })
  })

  it('edits the fanning and hides its geometry while flat', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({ palettes: [palette()] })
    mount()

    await user.click(await screen.findByRole('button', { name: 'Corporativo' }))

    // Flat means no fan: layout and amount would configure nothing.
    expect(screen.queryByLabelText('Reparto')).toBeNull()
    expect(screen.queryByLabelText('Cantidad %')).toBeNull()

    await user.selectOptions(screen.getByLabelText('Abanico'), 'Linear')
    expect(api.patchPalette).toHaveBeenCalledWith(7, { fanning: { type: 'Linear' } })
  })

  it('shows the fan geometry once the fanning is not flat', async () => {
    const user = userEvent.setup()
    vi.mocked(api.palettes).mockResolvedValue({
      palettes: [
        palette({
          fanning: { type: 'Linear', layout: 'XAscending', amount: 60, value: '#000000' },
        }),
      ],
    })
    mount()

    await user.click(await screen.findByRole('button', { name: 'Corporativo' }))

    expect(screen.getByLabelText('Reparto')).toBeInTheDocument()
    expect(screen.getByLabelText('Cantidad %')).toBeInTheDocument()
  })
})
