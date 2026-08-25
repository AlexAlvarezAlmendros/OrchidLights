/**
 * The dump button, tested from the operator's side of the desk.
 *
 * What matters here is honesty: the button wears the live count and refuses
 * to press when there is nothing to record, the panel says how many values go
 * in and how many stay out, and the request body carries exactly what the
 * operator chose -- no invented name, no silently-dropped filter.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FunctionState, api } from './api'
import { DumpButton } from './volcado'

vi.mock('./api', () => ({
  api: {
    dumpState: vi.fn(),
    dumpToScene: vi.fn(),
  },
}))

const fn = (id: number, name: string, type: string): FunctionState => ({
  id,
  name,
  type,
  running: false,
})

function mount(over: Partial<ComponentProps<typeof DumpButton>> = {}) {
  const onError = vi.fn()
  const onDone = vi.fn()
  render(
    <DumpButton count={3} bare={0} functions={[]} onError={onError} onDone={onDone} {...over} />,
  )
  return { onError, onDone }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.dumpState).mockResolvedValue({ count: 3, bare: 0, groups: [] })
  vi.mocked(api.dumpToScene).mockResolvedValue({ scene: 1, written: 3 })
})

describe('DumpButton', () => {
  it('refuses to press with nothing held, and says why', async () => {
    const user = userEvent.setup()
    mount({ count: 0 })

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'La mesa no sujeta nada que una escena pueda decir')

    // A disabled button must not open the panel either.
    await user.click(button)
    expect(screen.queryByText(/valores listos/)).toBeNull()
  })

  it('wears the live count so the operator knows what a press would record', () => {
    mount({ count: 12 })

    const button = screen.getByRole('button')
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent('12')
    expect(button).toHaveAttribute('title', 'Volcar lo sujeto a una escena')
  })

  it('counts what goes in and SAYS what stays out', async () => {
    const user = userEvent.setup()
    mount({ count: 5, bare: 2 })

    await user.click(screen.getByRole('button'))

    expect(screen.getByText(/5 valores listos para volcar/)).toBeInTheDocument()
    // Held values on unpatched addresses cannot enter a scene; they must be
    // announced, never silently dropped.
    expect(screen.getByText('2 quedan fuera')).toBeInTheDocument()
  })

  it('does not warn about exclusions when nothing is left out', async () => {
    const user = userEvent.setup()
    mount({ count: 5, bare: 0 })

    await user.click(screen.getByRole('button'))

    expect(screen.getByText(/5 valores listos para volcar/)).toBeInTheDocument()
    expect(screen.queryByText(/quedan fuera/)).toBeNull()
  })

  it('dumps to a fresh scene, letting the daemon name it when the field is blank', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpToScene).mockResolvedValue({ scene: 7, written: 12 })
    const { onDone } = mount()

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    // No name key at all: an empty string would overwrite the daemon default.
    expect(api.dumpToScene).toHaveBeenCalledWith({ nonZeroOnly: true })
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Volcado: 12 valores a la escena #7'))
    // Done means done: the panel closes.
    expect(screen.queryByText(/valores listos/)).toBeNull()
  })

  it('sends the trimmed name when the operator gives one', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button'))
    await user.type(screen.getByLabelText('Nombre'), '  Bienvenida  ')
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    expect(api.dumpToScene).toHaveBeenCalledWith({ name: 'Bienvenida', nonZeroOnly: true })
  })

  it('offers only scenes as overwrite targets', async () => {
    const user = userEvent.setup()
    mount({
      functions: [fn(4, 'Bienvenida', 'Scene'), fn(5, 'Persecución', 'Chaser')],
    })

    await user.click(screen.getByRole('button'))

    // A chaser has no channel values to overwrite; offering it would be a lie.
    expect(screen.getByRole('option', { name: 'Sobre «Bienvenida»' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Persecución/ })).toBeNull()
  })

  it('overwrites the chosen scene by id, hiding the name field', async () => {
    const user = userEvent.setup()
    mount({ functions: [fn(4, 'Bienvenida', 'Scene')] })

    await user.click(screen.getByRole('button'))
    await user.selectOptions(screen.getByLabelText('Destino'), '4')

    // Overwriting keeps the scene's name; asking for one would be confusing.
    expect(screen.queryByLabelText('Nombre')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Volcar' }))
    expect(api.dumpToScene).toHaveBeenCalledWith({ sceneId: 4, nonZeroOnly: true })
  })

  it('passes the include-zeros choice through', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByLabelText('Solo valores distintos de cero'))
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    expect(api.dumpToScene).toHaveBeenCalledWith({ nonZeroOnly: false })
  })

  it('offers channel-group filters, translated, and sends the raw group names', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpState).mockResolvedValue({
      count: 3,
      bare: 0,
      groups: ['Intensity', 'Colour', 'Weird'],
    })
    mount()

    await user.click(screen.getByRole('button'))

    // The operator reads Spanish; an unknown group falls back to its raw name
    // rather than disappearing.
    const intensity = await screen.findByLabelText('Intensidad')
    expect(screen.getByLabelText('Color')).not.toBeChecked()
    expect(screen.getByLabelText('Weird')).toBeInTheDocument()
    expect(intensity).not.toBeChecked()

    await user.click(intensity)
    await user.click(screen.getByLabelText('Weird'))
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    // The daemon speaks QLC+'s group names, not the translation.
    expect(api.dumpToScene).toHaveBeenCalledWith({
      nonZeroOnly: true,
      groups: ['Intensity', 'Weird'],
    })
  })

  it('shows no filter when there is only one group to choose from', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpState).mockResolvedValue({ count: 3, bare: 0, groups: ['Intensity'] })
    mount()

    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(api.dumpState).toHaveBeenCalled())

    // A filter with a single option filters nothing; it would only add noise.
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('keeps the dump usable when the group survey fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpState).mockRejectedValue(new Error('sin conexión'))
    mount()

    await user.click(screen.getByRole('button'))
    await waitFor(() => expect(api.dumpState).toHaveBeenCalled())

    expect(screen.getByText(/valores listos/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Volcar' }))
    expect(api.dumpToScene).toHaveBeenCalledWith({ nonZeroOnly: true })
  })

  it('reports a failed dump and keeps the panel open for a retry', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpToScene).mockRejectedValue(new Error('El motor no responde'))
    const { onError, onDone } = mount()

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('El motor no responde'))
    expect(onDone).not.toHaveBeenCalled()
    // The operator keeps their choices; closing would throw them away.
    expect(screen.getByText(/valores listos/)).toBeInTheDocument()
  })

  it('stringifies a rejection that is not an Error', async () => {
    const user = userEvent.setup()
    vi.mocked(api.dumpToScene).mockRejectedValue('cable suelto')
    const { onError } = mount()

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Volcar' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('cable suelto'))
  })

  it('closes when the operator clicks elsewhere', async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText(/valores listos/)).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByText(/valores listos/)).toBeNull())
  })
})
