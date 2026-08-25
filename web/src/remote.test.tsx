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
import { api } from './api'
import { RemotePanel } from './remote'

vi.mock('./api', () => ({
  api: {
    remote: vi.fn(),
    kickRemote: vi.fn(),
  },
}))

const remote = vi.mocked(api.remote)
const kickRemote = vi.mocked(api.kickRemote)

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
  url: 'http://192.168.1.20:9998/#token=abc123',
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
    await screen.findByText('--listen-all')
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

  it('warns that the URL carries the key only when auth is on and a door exists', async () => {
    remote.mockResolvedValue(state({ listenAll: true, authRequired: true, addresses: [DOOR] }))
    const first = render(<RemotePanel revision={0} />)
    await screen.findByText(/lleva la llave de esta mesa/)
    first.unmount()

    // Same auth, no doors: nothing to share, so no warning either.
    remote.mockResolvedValue(state({ listenAll: false, authRequired: true }))
    render(<RemotePanel revision={0} />)
    await screen.findByText('--listen-all')
    expect(screen.queryByText(/lleva la llave de esta mesa/)).toBeNull()
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
