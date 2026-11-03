/**
 * The assistant's screen: what it says before it is set up, and what a turn
 * looks like as it happens. The loop and the providers are stood in for --
 * they have their own tests -- and the events are played by hand.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepararAdjunto } from './adjuntos'
import { type Evento, turno } from './agente'
import { type AiSettings, api } from './api'
import Conversacion, { olvidar } from './conversacion'

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: { aiSettings: vi.fn(), access: vi.fn() },
}))
vi.mock('./agente', () => ({ turno: vi.fn(), VUELTAS_MAXIMAS: 40 }))
vi.mock('./adjuntos', () => ({ prepararAdjunto: vi.fn() }))
vi.mock('./proveedores', () => ({
  DialectoAnthropic: vi.fn(),
  DialectoOpenAI: vi.fn(),
  anthropicCliente: vi.fn(),
  openaiCliente: vi.fn(),
}))

const aiSettings = vi.mocked(api.aiSettings)
const access = vi.mocked(api.access)
const correr = vi.mocked(turno)
const preparar = vi.mocked(prepararAdjunto)

function asRole(role: 'open' | 'master' | 'design' | 'operate') {
  return {
    role,
    fixtures: true,
    functions: true,
    vcControl: true,
    vcEditing: true,
    simpleDesk: true,
    show: true,
    io: true,
  }
}

function ajustes(configured: boolean, provider: 'anthropic' | 'openai' = 'anthropic'): AiSettings {
  return {
    provider,
    dailyRequests: 300,
    providers: {
      anthropic: {
        model: 'claude-opus-5-5',
        baseUrl: 'https://api.anthropic.com',
        configured,
        keyHint: '',
      },
      openai: {
        model: 'llama3',
        baseUrl: 'http://localhost:11434/v1',
        configured: false,
        keyHint: '',
      },
    },
    usage: { day: '2026-11-03', requests: 0, inputTokens: 0, outputTokens: 0 },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  access.mockResolvedValue(asRole('master'))
  aiSettings.mockResolvedValue(ajustes(true))
})

afterEach(() => act(() => olvidar()))

describe('before it is set up', () => {
  it('tells the master key where to set it up', async () => {
    aiSettings.mockResolvedValue(ajustes(false))
    render(<Conversacion />)
    expect(await screen.findByText(/Configura el proveedor y la clave en Ajustes/)).toBeVisible()
    expect(screen.queryByLabelText('Mensaje')).toBeNull()
  })

  it('tells anyone else it is set up at the desk', async () => {
    aiSettings.mockResolvedValue(ajustes(false))
    access.mockResolvedValue(asRole('design'))
    render(<Conversacion />)
    expect(await screen.findByText(/Se hace desde su equipo, con la llave maestra/)).toBeVisible()
  })

  it('needs no key for a local OpenAI-style model', async () => {
    aiSettings.mockResolvedValue(ajustes(false, 'openai'))
    render(<Conversacion />)
    expect(await screen.findByLabelText('Mensaje')).toBeVisible()
    expect(screen.getByText(/Compatible con OpenAI · llama3/)).toBeVisible()
  })
})

describe('a turn', () => {
  it('shows what was asked, each step as it happens, and the answer', async () => {
    let jugar: (e: Evento) => void = () => undefined
    let terminar: () => void = () => undefined
    correr.mockImplementation(
      (o) =>
        new Promise<void>((resolve) => {
          jugar = o.evento
          terminar = resolve
        }),
    )
    const user = userEvent.setup()
    render(<Conversacion />)

    await user.type(await screen.findByLabelText('Mensaje'), 'Cuatro PAR en el truss{Enter}')
    expect(correr).toHaveBeenCalledWith(
      expect.objectContaining({ texto: 'Cuatro PAR en el truss', adjuntos: [] }),
    )
    expect(screen.getByText('Cuatro PAR en el truss')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Parar' })).toBeVisible()

    act(() => {
      jugar({ tipo: 'texto', delta: 'Miro el ' })
      jugar({ tipo: 'texto', delta: 'proyecto.' })
      jugar({
        tipo: 'llamada',
        id: 't1',
        nombre: 'aplicar',
        entrada: { documento: { orchidlights: 1 } },
      })
    })
    expect(screen.getByText('Miro el proyecto.')).toBeVisible()
    expect(screen.getByText('trabajando…')).toBeVisible()

    act(() => {
      jugar({
        tipo: 'resultado',
        id: 't1',
        error: false,
        resumen: 'Ha aplicado +4 fixtures',
        cambios: {
          dryRun: false,
          actions: [{ section: 'fixtures', kind: 'create', name: 'Par 1' }],
          created: 4,
          updated: 0,
          deleted: 0,
          undoSteps: 1,
          undoOverflowed: false,
        },
      })
      jugar({ tipo: 'texto', delta: 'Hecho.' })
      jugar({ tipo: 'uso', entrada: 12000, salida: 3000 })
    })
    expect(screen.getByText('Ha aplicado +4 fixtures')).toBeVisible()
    expect(screen.getByText('Aplicar')).toBeVisible()
    // Text after a tool is a new paragraph, not glued to the one before it.
    expect(screen.getByText('Hecho.')).toBeVisible()
    expect(screen.getByText(/12k \/ 3k tokens/)).toBeVisible()

    await act(async () => terminar())
    expect(await screen.findByRole('button', { name: 'Enviar' })).toBeVisible()
  })

  it('stops when asked, and says so', async () => {
    correr.mockImplementation(
      (o) =>
        new Promise<void>((_, reject) => {
          o.contexto.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })),
          )
        }),
    )
    const user = userEvent.setup()
    render(<Conversacion />)

    await user.type(await screen.findByLabelText('Mensaje'), 'hola{Enter}')
    await user.click(screen.getByRole('button', { name: 'Parar' }))
    expect(await screen.findByText('Parado.')).toBeVisible()
  })

  it('says a provider error in the provider’s words', async () => {
    correr.mockRejectedValue(
      Object.assign(new Error('403'), {
        error: {
          type: 'error',
          error: { type: 'permission_error', message: 'Tope diario alcanzado' },
        },
      }),
    )
    const user = userEvent.setup()
    render(<Conversacion />)

    await user.type(await screen.findByLabelText('Mensaje'), 'hola{Enter}')
    expect(await screen.findByText('Error: Tope diario alcanzado')).toBeVisible()
  })

  it('carries attachments with the message, and clears them after', async () => {
    correr.mockResolvedValue(undefined)
    preparar.mockResolvedValue({
      nombre: 'sala.jpg',
      mediaType: 'image/jpeg',
      datos: 'AAA',
      miniatura: 'data:image/jpeg;base64,BBB',
    })
    const user = userEvent.setup()
    const { container } = render(<Conversacion />)

    await screen.findByLabelText('Mensaje')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['x'], 'sala.jpg', { type: 'image/jpeg' }))
    expect(await screen.findByRole('img', { name: 'sala.jpg' })).toBeVisible()

    await user.type(screen.getByLabelText('Mensaje'), 'esta es la sala{Enter}')
    expect(correr).toHaveBeenCalledWith(
      expect.objectContaining({ adjuntos: [expect.objectContaining({ nombre: 'sala.jpg' })] }),
    )
    // The composer is empty again; the photo now belongs to the message.
    expect(container.querySelector('.chat-composer img')).toBeNull()
  })

  it('refuses a PDF the OpenAI dialect cannot read, instead of sending it', async () => {
    aiSettings.mockResolvedValue(ajustes(false, 'openai'))
    const user = userEvent.setup({ applyAccept: false })
    const { container } = render(<Conversacion />)

    await screen.findByLabelText('Mensaje')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File(['%PDF'], 'plano.pdf', { type: 'application/pdf' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/no lee PDF/)
    expect(preparar).not.toHaveBeenCalled()
  })
})
