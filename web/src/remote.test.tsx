/**
 * The remote-access screen, judged on its honesty.
 *
 * The panel's whole job is to tell the operator the truth about the network:
 * a QR only for doors that answer, the --listen-all hint when there are none,
 * the live client list with its one control, and a plain "not answering" when
 * the daemon is gone. The API is mocked because these tests are about what the
 * panel shows for each shape of answer, not about HTTP.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Unauthorized, api } from './api'
import { RemotePanel } from './remote'

/* The real module underneath, so Unauthorized is the class the panel tests
   against with instanceof -- a stub class would never match. */
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: {
    remote: vi.fn(),
    kickRemote: vi.fn(),
    devices: vi.fn(),
    pairDevice: vi.fn(),
    updateDevice: vi.fn(),
    revokeDevice: vi.fn(),
  },
}))

const remote = vi.mocked(api.remote)
const kickRemote = vi.mocked(api.kickRemote)
const devices = vi.mocked(api.devices)
const pairDevice = vi.mocked(api.pairDevice)
const updateDevice = vi.mocked(api.updateDevice)
const revokeDevice = vi.mocked(api.revokeDevice)

type RemoteState = Awaited<ReturnType<typeof api.remote>>
type Client = RemoteState['clients'][number]

function state(over: Partial<RemoteState> = {}): RemoteState {
  return {
    listenAll: false,
    port: 9998,
    authRequired: false,
    localUrl: 'http://127.0.0.1:9998/',
    addresses: [],
    clients: [],
    ...over,
  }
}

function client(over: Partial<Client> = {}): Client {
  return {
    id: 7,
    address: '192.168.1.30',
    connectedAt: '2026-08-25T20:15:00',
    authenticated: true,
    trusted: false,
    universes: 0,
    ...over,
  }
}

const DOOR = {
  interface: 'wlan0',
  ip: '192.168.1.20',
  url: 'http://192.168.1.20:9998/',
}

const TRUSS = {
  id: 3,
  name: 'Truss',
  role: 'operate' as const,
  created: '2026-10-17T18:00:00Z',
  lastSeen: null,
  connections: 0,
}

/** What since() will print for a timestamp on this machine: the panel shows
 *  local wall-clock time, so the expectation is computed the same way. */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

beforeEach(() => {
  /* Reset wipes the queued one-shot answers a previous test left behind. */
  vi.resetAllMocks()
  localStorage.clear()
  devices.mockResolvedValue({ devices: [] })
})

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
}

describe('network doors', () => {
  it('shows no QR on loopback, and says how to open the desk instead', async () => {
    remote.mockResolvedValue(state({ listenAll: false }))
    render(<RemotePanel revision={0} />)

    // The flag is the actionable part of the message: it must appear verbatim.
    await screen.findAllByText('--listen-all')
    expect(screen.getByText('http://127.0.0.1:9998/')).toBeInTheDocument()

    // A QR to a URL that does not answer is worse than none.
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows one QR and one copyable URL per reachable door', async () => {
    remote.mockResolvedValue(state({ listenAll: true, addresses: [DOOR] }))
    render(<RemotePanel revision={0} />)

    const qr = await screen.findByRole('img', { name: 'Código QR de acceso' })
    expect(qr).toHaveClass('qr')
    expect(screen.getByText(DOOR.url)).toBeInTheDocument()
    expect(screen.getByText(DOOR.ip)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copiar URL' })).toBeInTheDocument()
  })

  it('admits when listen-all is on but the machine has no address', async () => {
    remote.mockResolvedValue(state({ listenAll: true, addresses: [] }))
    render(<RemotePanel revision={0} />)

    await screen.findByText(/no tiene ninguna dirección de red/)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says the door carries no key, and points at pairing, only when auth is on', async () => {
    remote.mockResolvedValue(state({ listenAll: true, authRequired: true, addresses: [DOOR] }))
    const first = render(<RemotePanel revision={0} />)
    await screen.findByText(/no lleva llave: empareja el móvil/)
    first.unmount()

    // Same auth, no doors: nothing to share, so no note either.
    remote.mockResolvedValue(state({ listenAll: false, authRequired: true }))
    render(<RemotePanel revision={0} />)
    await screen.findAllByText('--listen-all')
    expect(screen.queryByText(/no lleva llave: empareja el móvil/)).toBeNull()
  })
})

describe('copying the join URL', () => {
  it('puts the URL on the clipboard and says so on the button', async () => {
    remote.mockResolvedValue(state({ listenAll: true, addresses: [DOOR] }))
    const user = userEvent.setup()
    /* After setup(): user-event installs its own clipboard stub there, and
       the test needs to see the call with its own eyes. */
    const writeText = vi.fn(() => Promise.resolve())
    stubClipboard(writeText)
    render(<RemotePanel revision={0} />)

    await user.click(await screen.findByRole('button', { name: 'Copiar URL' }))

    expect(writeText).toHaveBeenCalledWith(DOOR.url)
    expect(await screen.findByRole('button', { name: 'Copiada' })).toBeInTheDocument()
  })

  it('does not claim "Copiada" when the clipboard refused', async () => {
    // Plain http on a phone has no clipboard API; pretending would be a lie.
    remote.mockResolvedValue(state({ listenAll: true, addresses: [DOOR] }))
    const user = userEvent.setup()
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    stubClipboard(writeText)
    render(<RemotePanel revision={0} />)

    await user.click(await screen.findByRole('button', { name: 'Copiar URL' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByText('Copiada')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copiar URL' })).toBeInTheDocument()
  })
})

describe('who is on the desk', () => {
  it('lists each client with its address and the local time it arrived', async () => {
    const arrived = '2026-08-25T20:15:00'
    remote.mockResolvedValue(
      state({
        clients: [
          client({ id: 1, address: '192.168.1.30', connectedAt: arrived }),
          client({ id: 2, address: '192.168.1.31', trusted: true, universes: 2 }),
        ],
      }),
    )
    render(<RemotePanel revision={0} />)

    // The count in the heading is part of the answer to "who is on my desk".
    await screen.findByText('Conectados · 2')

    const plain = screen.getByText('192.168.1.30').closest('li')
    expect(plain).not.toBeNull()
    expect(plain).toHaveTextContent(`desde las ${clock(arrived)}`)
    expect(plain).not.toHaveTextContent('con llave')
    expect(plain).not.toHaveTextContent('DMX')

    const keyed = screen.getByText('192.168.1.31').closest('li')
    expect(keyed).toHaveTextContent('con llave')
    expect(keyed).toHaveTextContent('2 DMX')
  })

  it('shows an unparseable timestamp as-is rather than "Invalid Date"', async () => {
    remote.mockResolvedValue(state({ clients: [client({ connectedAt: 'hace un rato' })] }))
    render(<RemotePanel revision={0} />)

    const row = (await screen.findByText('192.168.1.30')).closest('li')
    expect(row).toHaveTextContent('desde las hace un rato')
  })

  it('says plainly when nobody else is connected', async () => {
    remote.mockResolvedValue(state())
    render(<RemotePanel revision={0} />)

    await screen.findByText('Nadie más está conectado ahora mismo.')
  })

  it('kicks a client through the API and redraws the list from the answer', async () => {
    remote
      .mockResolvedValueOnce(state({ clients: [client({ id: 42 })] }))
      .mockResolvedValueOnce(state({ clients: [] }))
    kickRemote.mockResolvedValue({ closed: 1 })

    const user = userEvent.setup()
    render(<RemotePanel revision={0} />)

    const row = (await screen.findByText('192.168.1.30')).closest('li')
    expect(row).not.toBeNull()
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Desconectar' }))

    expect(kickRemote).toHaveBeenCalledWith(42)
    // The list is refetched, not locally edited: the daemon owns the truth.
    await screen.findByText('Nadie más está conectado ahora mismo.')
    expect(remote).toHaveBeenCalledTimes(2)
  })

  it('still refetches when the kick failed, so the list never goes stale', async () => {
    // The client may have already left on its own; the cure for a failed kick
    // is the same as for a successful one -- ask the daemon again.
    remote
      .mockResolvedValueOnce(state({ clients: [client({ id: 42 })] }))
      .mockResolvedValueOnce(state({ clients: [] }))
    kickRemote.mockRejectedValue(new Error('gone'))

    const user = userEvent.setup()
    render(<RemotePanel revision={0} />)

    await user.click(await screen.findByRole('button', { name: 'Desconectar' }))

    await screen.findByText('Nadie más está conectado ahora mismo.')
    expect(remote).toHaveBeenCalledTimes(2)
  })
})

describe('staying current', () => {
  it('refetches when the revision prop bumps', async () => {
    // The live feed bumps `revision` when a connection comes or goes; the
    // panel must go back to the daemon instead of trusting what it drew.
    remote
      .mockResolvedValueOnce(state({ clients: [] }))
      .mockResolvedValueOnce(state({ clients: [client({ address: '10.0.0.9' })] }))

    const view = render(<RemotePanel revision={0} />)
    await screen.findByText('Nadie más está conectado ahora mismo.')

    view.rerender(<RemotePanel revision={1} />)

    await screen.findByText('10.0.0.9')
    expect(remote).toHaveBeenCalledTimes(2)
  })

  it('tells the operator when the engine is not answering', async () => {
    remote.mockRejectedValue(new Error('ECONNREFUSED'))
    render(<RemotePanel revision={0} />)

    await screen.findByText('El motor no responde')
  })

  it('recovers from a failure once the engine answers again', async () => {
    remote.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(state())

    const view = render(<RemotePanel revision={0} />)
    await screen.findByText('El motor no responde')

    view.rerender(<RemotePanel revision={1} />)

    await screen.findByText('Acceso desde la red')
    expect(screen.queryByText('El motor no responde')).toBeNull()
  })
})

describe('paired devices', () => {
  it('pairs a phone and shows its QR once, with its own key aboard', async () => {
    remote.mockResolvedValue(state({ listenAll: true, authRequired: true, addresses: [DOOR] }))
    pairDevice.mockResolvedValue({
      ...TRUSS,
      key: 'k'.repeat(64),
      urls: [{ ...DOOR, url: `${DOOR.url}#token=${'k'.repeat(64)}` }],
      localUrl: `http://127.0.0.1:9998/#token=${'k'.repeat(64)}`,
    })
    const user = userEvent.setup()
    render(<RemotePanel revision={0} />)

    await user.type(await screen.findByLabelText('Nombre'), 'Truss')
    await user.click(screen.getByRole('button', { name: 'Emparejar' }))

    expect(pairDevice).toHaveBeenCalledWith('Truss', 'operate')
    const card = (await screen.findByText(/solo se enseña ahora/)).closest('article')
    expect(card).not.toBeNull()
    expect(card).toHaveTextContent(`#token=${'k'.repeat(64)}`)
    expect(within(card as HTMLElement).getByRole('img')).toHaveClass('qr')

    // Once dismissed, the key is gone from the screen for good.
    await user.click(screen.getByRole('button', { name: 'Hecho' }))
    expect(screen.queryByText(/solo se enseña ahora/)).toBeNull()
  })

  it('tells a device that pairing happens at the desk, instead of failing', async () => {
    remote.mockResolvedValue(state())
    devices.mockRejectedValue(new Unauthorized())
    render(<RemotePanel revision={0} />)

    await screen.findByText(/se emparejan desde el equipo de la mesa/)
    expect(screen.queryByRole('button', { name: 'Emparejar' })).toBeNull()
  })

  it('revokes on the second press, never the first', async () => {
    remote.mockResolvedValue(state())
    devices.mockResolvedValue({ devices: [TRUSS] })
    revokeDevice.mockResolvedValue({ revoked: 3, closed: 0 })
    const user = userEvent.setup()
    render(<RemotePanel revision={0} />)

    await user.click(await screen.findByRole('button', { name: 'Revocar' }))
    expect(revokeDevice).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '¿Revocar?' }))
    expect(revokeDevice).toHaveBeenCalledWith(3)
  })

  it('changes a role through the API', async () => {
    remote.mockResolvedValue(state())
    devices.mockResolvedValue({ devices: [TRUSS] })
    updateDevice.mockResolvedValue({ ...TRUSS, role: 'design' })
    const user = userEvent.setup()
    render(<RemotePanel revision={0} />)

    await user.selectOptions(await screen.findByLabelText('Rol de Truss'), 'design')
    expect(updateDevice).toHaveBeenCalledWith(3, { role: 'design' })
  })

  it('names the device behind a connection, and its role', async () => {
    remote.mockResolvedValue(
      state({ clients: [client({ role: 'operate', device: 'Truss', deviceId: 3 })] }),
    )
    render(<RemotePanel revision={0} />)

    const row = (await screen.findByText('192.168.1.30')).closest('li')
    expect(row).toHaveTextContent('Truss (Operar)')
  })
})
