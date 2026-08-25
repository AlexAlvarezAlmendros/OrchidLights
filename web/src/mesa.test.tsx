/**
 * The Simple Desk, exercised the way an operator uses it.
 *
 * `./api` is mocked at the module seam: these tests assert which route each
 * gesture fires and what the grid shows for the frames it is handed. The
 * `frames` prop is the wire itself, so the numbers on screen must be the
 * numbers in the frame -- not an echo of what was asked.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FixtureDetail, type FixtureState, type UniverseState, api } from './api'
import { Mesa } from './mesa'

vi.mock('./api', () => ({
  api: {
    universes: vi.fn(),
    deskHeld: vi.fn(),
    deskSet: vi.fn(),
    deskReleaseChannel: vi.fn(),
    deskReleaseUniverse: vi.fn(),
    deskKeypad: vi.fn(),
    fixture: vi.fn(),
  },
}))

const universe = (id: number, name: string): UniverseState => ({
  id,
  name,
  outputs: [],
  passthrough: false,
  patched: true,
})

const par = (id: number, name: string, address: number, channels: number): FixtureState => ({
  id,
  name,
  universe: 1,
  address,
  channels,
  resolved: true,
})

/** Channel names for the detail route: generic but distinct per index. */
const detailOf = (fixture: FixtureState): FixtureDetail => ({
  ...fixture,
  channelList: Array.from({ length: fixture.channels }, (_, index) => ({
    index,
    name: ['Dimmer', 'Rojo', 'Verde', 'Azul'][index] ?? `Extra ${index}`,
  })),
})

/** A 512-byte frame with a few addresses lit; keys are 0-based indexes. */
function frameWith(values: Record<number, number>): Uint8Array {
  const frame = new Uint8Array(512)
  for (const [index, value] of Object.entries(values)) frame[Number(index)] = value
  return frame
}

type MesaProps = Parameters<typeof Mesa>[0]

function mount(over: Partial<MesaProps> = {}) {
  const onHeld = vi.fn()
  const onError = vi.fn()
  render(<Mesa fixtures={[]} frames={{}} held={{}} onHeld={onHeld} onError={onError} {...over} />)
  return { onHeld, onError }
}

/** Render and let the mount-time fetches (universes, held) settle. */
async function mountSettled(over: Partial<MesaProps> = {}) {
  const handles = mount(over)
  await waitFor(() => expect(api.deskHeld).toHaveBeenCalled())
  return handles
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.universes).mockResolvedValue([universe(1, 'Universo 1'), universe(2, 'Universo 2')])
  vi.mocked(api.deskHeld).mockResolvedValue({ universe: 1, held: {} })
  vi.mocked(api.deskSet).mockResolvedValue({ universe: 1, held: 1 })
  vi.mocked(api.deskReleaseChannel).mockResolvedValue({ released: 1 })
  vi.mocked(api.deskReleaseUniverse).mockResolvedValue({ released: 0 })
  vi.mocked(api.deskKeypad).mockResolvedValue({ universe: 1, applied: [] })
  vi.mocked(api.fixture).mockImplementation(async (id: number) =>
    detailOf(par(id, `Fixture ${id}`, 1, 1)),
  )
})

describe('the grid and the wire', () => {
  it('paints the frame values straight off the wire, one cell per address', async () => {
    // Values sit above 96 so they cannot collide with an address label on
    // the first page of the grid.
    await mountSettled({ frames: { 1: frameWith({ 0: 210, 4: 137 }) } })

    expect(screen.getByText('210')).toBeInTheDocument()
    expect(screen.getByText('137')).toBeInTheDocument()
    expect(screen.getByLabelText('Canal 5')).toHaveValue('137')
  })

  it('shows zero for a universe no frame has arrived for yet', async () => {
    await mountSettled({ frames: {} })

    expect(screen.getByLabelText('Canal 1')).toHaveValue('0')
  })

  it('reads as percentages when asked, rounding the way the monitor does', async () => {
    await mountSettled({ frames: { 1: frameWith({ 0: 255, 1: 128, 2: 64 }) } })

    fireEvent.click(screen.getByRole('button', { name: '%' }))

    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('names the fixture under each address, and says when there is none', async () => {
    await mountSettled({ fixtures: [par(1, 'Cegadora', 1, 3)] })

    // Three cells wear the lamp's name; the other 93 on the page say so too.
    expect(screen.getAllByTitle('Cegadora')).toHaveLength(3)
    expect(screen.getAllByTitle('Sin fixture')).toHaveLength(93)
  })

  it('shows the wire on the label but the hand on the fader for a held channel', async () => {
    // The text is the DMX monitor (what the rig receives); the fader position
    // is the grip. When they disagree, both must be visible.
    await mountSettled({
      frames: { 1: frameWith({ 4: 110 }) },
      held: { 1: { '5': 200 } },
    })

    expect(screen.getByLabelText('Canal 5')).toHaveValue('200')
    expect(screen.getByText('110')).toBeInTheDocument()
  })
})

describe('holding and releasing', () => {
  it('moving a fader asks the daemon to hold the channel and grips it at once', async () => {
    const { onHeld } = await mountSettled()

    fireEvent.change(screen.getByLabelText('Canal 5'), { target: { value: '200' } })

    expect(api.deskSet).toHaveBeenCalledWith(1, { '5': 200 })
    // Optimistic: the hand must not wait for the WS echo.
    expect(onHeld).toHaveBeenCalledWith(1, { '5': 200 })
  })

  it('only a held channel offers release', async () => {
    await mountSettled({ held: { 1: { '5': 128 } } })

    expect(screen.getByRole('button', { name: 'Soltar canal 5' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Soltar canal 1' })).not.toBeInTheDocument()
  })

  it('releasing a channel tells the daemon and drops it from the grip', async () => {
    const { onHeld } = await mountSettled({ held: { 1: { '5': 128 } } })

    fireEvent.click(screen.getByRole('button', { name: 'Soltar canal 5' }))

    expect(api.deskReleaseChannel).toHaveBeenCalledWith(1, 5)
    expect(onHeld).toHaveBeenCalledWith(1, {})
  })

  it('counts the grip and can free the whole universe at once', async () => {
    const { onHeld } = await mountSettled({ held: { 1: { '5': 1, '9': 2 } } })

    expect(screen.getByText('2 en mano')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Soltar universo' }))

    expect(api.deskReleaseUniverse).toHaveBeenCalledWith(1)
    expect(onHeld).toHaveBeenCalledWith(1, {})
  })

  it('disables release-universe while the desk holds nothing here', async () => {
    await mountSettled({ held: {} })

    expect(screen.getByRole('button', { name: 'Soltar universo' })).toBeDisabled()
  })

  it('seeds its grip from the daemon on arrival', async () => {
    vi.mocked(api.deskHeld).mockResolvedValue({ universe: 1, held: { '2': 10 } })

    const { onHeld } = mount()

    await waitFor(() => expect(onHeld).toHaveBeenCalledWith(1, { '2': 10 }))
  })

  it('surfaces a hold the daemon refuses instead of swallowing it', async () => {
    vi.mocked(api.deskSet).mockRejectedValue(new Error('sin permiso'))
    const { onError } = await mountSettled()

    fireEvent.change(screen.getByLabelText('Canal 5'), { target: { value: '200' } })

    await waitFor(() => expect(onError).toHaveBeenCalledWith('sin permiso'))
  })

  it('surfaces a failure to read the current grip', async () => {
    vi.mocked(api.deskHeld).mockRejectedValue(new Error('401'))

    const { onError } = mount()

    await waitFor(() => expect(onError).toHaveBeenCalledWith('401'))
  })
})

describe('the keypad', () => {
  it('sends the order through the daemon parser, uppercased as typed', async () => {
    const user = userEvent.setup()
    await mountSettled()
    const field = screen.getByLabelText('Orden de teclado')

    await user.type(field, '1 at 50')
    // The grammar is the engine's: whatever the hand types, the order reads
    // like the manual.
    expect(field).toHaveValue('1 AT 50')

    await user.keyboard('{Enter}')

    expect(api.deskKeypad).toHaveBeenCalledWith(1, '1 AT 50')
    // Accepted: the field clears and the order joins the history.
    await waitFor(() => expect(field).toHaveValue(''))
    expect(screen.getByRole('button', { name: '1 AT 50' })).toBeInTheDocument()
  })

  it('sends nothing for an empty order', async () => {
    const user = userEvent.setup()
    await mountSettled()

    await user.type(screen.getByLabelText('Orden de teclado'), '{Enter}')

    expect(api.deskKeypad).not.toHaveBeenCalled()
  })

  it('keeps a rejected order in the field and surfaces the parser message', async () => {
    vi.mocked(api.deskKeypad).mockRejectedValue(new Error('orden ilegible'))
    const user = userEvent.setup()
    const { onError } = await mountSettled()
    const field = screen.getByLabelText('Orden de teclado')

    await user.type(field, 'garbage{Enter}')

    await waitFor(() => expect(onError).toHaveBeenCalledWith('orden ilegible'))
    // Not cleared, not remembered: the operator fixes it, not retypes it.
    expect(field).toHaveValue('GARBAGE')
    expect(screen.queryByLabelText('Órdenes recientes')).not.toBeInTheDocument()
  })

  it('builds the order from token keys with single spaces', async () => {
    await mountSettled()

    fireEvent.click(screen.getByRole('button', { name: 'AT' }))
    fireEvent.click(screen.getByRole('button', { name: 'THRU' }))

    expect(screen.getByLabelText('Orden de teclado')).toHaveValue('AT THRU ')
  })

  it('CLR wipes the field and ENTER sends like the key', async () => {
    await mountSettled()
    const field = screen.getByLabelText('Orden de teclado')

    fireEvent.change(field, { target: { value: '7 at full' } })
    fireEvent.click(screen.getByRole('button', { name: 'CLR' }))
    expect(field).toHaveValue('')

    fireEvent.change(field, { target: { value: '7 at full' } })
    fireEvent.click(screen.getByRole('button', { name: 'ENTER' }))
    expect(api.deskKeypad).toHaveBeenCalledWith(1, '7 AT FULL')
  })

  it('collapses repeats in the history and reloads an order on click', async () => {
    await mountSettled()
    const field = screen.getByLabelText('Orden de teclado')

    for (let round = 0; round < 2; round++) {
      fireEvent.change(field, { target: { value: '1 AT 50' } })
      fireEvent.click(screen.getByRole('button', { name: 'ENTER' }))
      await waitFor(() => expect(field).toHaveValue(''))
    }

    // "FULL, FULL, FULL" as one chip is the better history.
    const chips = screen.getAllByRole('button', { name: '1 AT 50' })
    expect(chips).toHaveLength(1)

    const chip = chips[0]
    if (chip === undefined) throw new Error('unreachable')
    fireEvent.click(chip)
    expect(field).toHaveValue('1 AT 50')
  })
})

describe('pages and universes', () => {
  it('pages the 512 addresses in blocks of 96', async () => {
    await mountSettled()

    const pages = screen.getByRole('navigation', { name: 'Páginas de canales' })
    expect(pages.querySelectorAll('button')).toHaveLength(6)
    expect(screen.getByRole('button', { name: '1–96' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '97–192' }))

    expect(screen.getByLabelText('Canal 97')).toBeInTheDocument()
    expect(screen.queryByLabelText('Canal 1')).not.toBeInTheDocument()
  })

  it('jumps to the page a fixture lives on through "Ir a"', async () => {
    await mountSettled({ fixtures: [par(1, 'Lejana', 100, 2)] })

    fireEvent.change(screen.getByLabelText('Ir a'), { target: { value: '100' } })

    expect(screen.getByRole('button', { name: '97–192' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Canal 100')).toBeInTheDocument()
  })

  it('switching universe re-seeds the grip and shows that universe frames', async () => {
    await mountSettled({
      frames: { 1: frameWith({ 0: 10 }), 2: frameWith({ 0: 99 }) },
    })
    await screen.findByRole('option', { name: 'Universo 2' })

    fireEvent.change(screen.getByLabelText('Universo'), { target: { value: '2' } })

    await waitFor(() => expect(api.deskHeld).toHaveBeenCalledWith(2))
    expect(screen.getByText('99')).toBeInTheDocument()
  })

  it('keeps working when the universe list cannot be fetched', async () => {
    // The desk predates the list: an empty selector must not take the grid
    // down with it, and the failure is not worth an error banner.
    vi.mocked(api.universes).mockRejectedValue(new Error('sin red'))

    const { onError } = await mountSettled({ frames: { 1: frameWith({ 0: 242 }) } })

    expect(screen.getByText('242')).toBeInTheDocument()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('the fixture view', () => {
  const rig = [par(1, 'Móvil', 1, 3), par(2, 'Cegadora', 4, 2)]

  it('groups the same frames by lamp, channels named by the detail route', async () => {
    await mountSettled({ fixtures: rig, frames: { 1: frameWith({ 0: 255, 3: 40 }) } })

    fireEvent.click(screen.getByRole('button', { name: 'Fixtures' }))

    expect(screen.getByText('Móvil')).toBeInTheDocument()
    expect(screen.getByText('@1')).toBeInTheDocument()
    // Names arrive lazily from the detail route and land on the tooltip.
    expect(await screen.findByTitle('Dimmer · DMX 1')).toBeInTheDocument()
    // Same wire, different grouping: Cegadora's first cell is address 4.
    expect(screen.getByTitle('Dimmer · DMX 4')).toHaveTextContent('40')
  })

  it('numbers channels per lamp under Rel, per universe under Abs', async () => {
    await mountSettled({ fixtures: rig })
    fireEvent.click(screen.getByRole('button', { name: 'Fixtures' }))

    const cell = await screen.findByTitle('Dimmer · DMX 4')
    expect(cell).toHaveTextContent('4')

    fireEvent.click(screen.getByRole('button', { name: 'Rel' }))

    expect(cell).toHaveTextContent('1')
  })

  it('clicking a cell drops back onto the desk with the hand on that page', async () => {
    await mountSettled({ fixtures: [par(3, 'Lejana', 100, 1)] })
    fireEvent.click(screen.getByRole('button', { name: 'Fixtures' }))

    fireEvent.click(await screen.findByTitle('Dimmer · DMX 100'))

    expect(screen.getByLabelText('Canal 100')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '97–192' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says plainly when the universe has no fixtures', async () => {
    await mountSettled({ fixtures: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Fixtures' }))

    expect(
      screen.getByText('Sin fixtures en este universo: no hay cajas que agrupar.'),
    ).toBeInTheDocument()
  })

  it('falls back to numbered channels when the detail route fails, and says so', async () => {
    vi.mocked(api.fixture).mockRejectedValue(new Error('perdido'))
    const { onError } = await mountSettled({ fixtures: [par(1, 'Móvil', 1, 1)] })

    fireEvent.click(screen.getByRole('button', { name: 'Fixtures' }))

    // No name to show, but the cell still works under its generic title.
    expect(await screen.findByTitle('Canal 1 · DMX 1')).toBeInTheDocument()
    await waitFor(() => expect(onError).toHaveBeenCalledWith('perdido'))
  })
})
