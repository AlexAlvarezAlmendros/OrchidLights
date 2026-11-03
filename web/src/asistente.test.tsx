/**
 * The assistant's settings, judged on what they send and what they never show.
 *
 * The key goes to the daemon and does not come back, so the tests that matter
 * are about the PUT -- only what changed, a key only when one was typed -- and
 * about who gets a form at all. The API is mocked: HTTP is ai-smoke.sh's.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type AiSettings, api } from './api'
import { AssistantSettings } from './asistente'

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  api: {
    access: vi.fn(),
    aiSettings: vi.fn(),
    setAiSettings: vi.fn(),
    checkAi: vi.fn(),
  },
}))

const access = vi.mocked(api.access)
const aiSettings = vi.mocked(api.aiSettings)
const setAiSettings = vi.mocked(api.setAiSettings)
const checkAi = vi.mocked(api.checkAi)

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

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'anthropic',
    dailyRequests: 300,
    providers: {
      anthropic: {
        model: 'claude-opus-5-5',
        baseUrl: 'https://api.anthropic.com',
        configured: true,
        keyHint: '…1234',
      },
      openai: {
        model: '',
        baseUrl: 'https://api.openai.com/v1',
        configured: false,
        keyHint: '',
      },
    },
    usage: { day: '2026-11-03', requests: 12, inputTokens: 34567, outputTokens: 890 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  access.mockResolvedValue(asRole('master'))
  aiSettings.mockResolvedValue(settings())
  setAiSettings.mockImplementation(async () => settings())
})

describe('the master key', () => {
  it('gets the form, with the key field empty and only a hint of the stored one', async () => {
    render(<AssistantSettings />)

    const key = await screen.findByLabelText('Clave')
    expect(key).toHaveValue('')
    expect(key).toHaveAttribute('type', 'password')
    expect(key).toHaveAttribute('placeholder', 'Guardada …1234')
    expect(screen.getByLabelText('Modelo')).toHaveValue('claude-opus-5-5')
    expect(
      screen.getByText(/Hoy: 12 peticiones · 35k tokens de entrada · 890 de salida/),
    ).toBeVisible()
  })

  it('sends only what changed, and no key nobody typed', async () => {
    const user = userEvent.setup()
    render(<AssistantSettings />)

    const model = await screen.findByLabelText('Modelo')
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()

    await user.clear(model)
    await user.type(model, 'claude-sonnet-5-5')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(setAiSettings).toHaveBeenCalledWith({
      providers: { anthropic: { model: 'claude-sonnet-5-5' } },
    })
  })

  it('sends a typed key, and clears the field once the daemon has it', async () => {
    const user = userEvent.setup()
    render(<AssistantSettings />)

    const key = await screen.findByLabelText('Clave')
    await user.type(key, '  sk-ant-nueva-clave-5678  ')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))

    expect(setAiSettings).toHaveBeenCalledWith({
      providers: { anthropic: { key: 'sk-ant-nueva-clave-5678' } },
    })
    await waitFor(() => expect(screen.getByLabelText('Clave')).toHaveValue(''))
  })

  it('removes the key on purpose, with an empty one', async () => {
    const user = userEvent.setup()
    render(<AssistantSettings />)

    await user.click(await screen.findByRole('button', { name: 'Quitar la clave' }))
    expect(setAiSettings).toHaveBeenCalledWith({ providers: { anthropic: { key: '' } } })
  })

  it('switches the provider, and says where the OpenAI dialect is also spoken', async () => {
    const user = userEvent.setup()
    render(<AssistantSettings />)

    await user.selectOptions(await screen.findByLabelText('Proveedor'), 'openai')
    expect(screen.getByLabelText('Dirección del servicio')).toHaveValue('https://api.openai.com/v1')
    expect(screen.getByLabelText('Clave')).toHaveAttribute(
      'placeholder',
      'Ninguna (un modelo local no la pide)',
    )
    expect(screen.getByText(/Ollama: http:\/\/localhost:11434\/v1/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(setAiSettings).toHaveBeenCalledWith({ provider: 'openai' })
  })

  it('saves before trying, so the test is of the key just typed', async () => {
    const order: string[] = []
    setAiSettings.mockImplementation(async () => {
      order.push('save')
      return settings()
    })
    checkAi.mockImplementation(async () => {
      order.push('check')
      return {
        ok: true,
        provider: 'anthropic',
        status: 200,
        models: ['claude-opus-5-5', 'claude-haiku-5-5'],
      }
    })
    const user = userEvent.setup()
    render(<AssistantSettings />)

    await user.type(await screen.findByLabelText('Clave'), 'sk-ant-otra-clave-0000')
    await user.click(screen.getByRole('button', { name: 'Probar' }))

    expect(await screen.findByText('Funciona · 2 modelos')).toBeVisible()
    expect(order).toEqual(['save', 'check'])
    expect(checkAi).toHaveBeenCalledWith('anthropic')
    // And the models fill the picker.
    const options = document.querySelectorAll('#assistant-models option')
    expect([...options].map((o) => o.getAttribute('value'))).toEqual([
      'claude-opus-5-5',
      'claude-haiku-5-5',
    ])
  })

  it('tries without saving when nothing changed', async () => {
    checkAi.mockResolvedValue({ ok: true, provider: 'anthropic', status: 200, models: [] })
    const user = userEvent.setup()
    render(<AssistantSettings />)

    await user.click(await screen.findByRole('button', { name: 'Probar' }))
    await screen.findByText('Funciona · 0 modelos')
    expect(setAiSettings).not.toHaveBeenCalled()
  })

  it('says a bad key in the provider’s own words, as an alert', async () => {
    checkAi.mockResolvedValue({
      ok: false,
      provider: 'anthropic',
      status: 401,
      error: 'invalid x-api-key',
    })
    const user = userEvent.setup()
    render(<AssistantSettings />)

    await user.click(await screen.findByRole('button', { name: 'Probar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No funciona: invalid x-api-key')
  })

  it('will not save a daily cap that is not a whole number', async () => {
    const user = userEvent.setup()
    render(<AssistantSettings />)

    const cap = await screen.findByLabelText('Peticiones por dispositivo y día')
    await user.clear(cap)
    await user.type(cap, '-3')
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Probar' })).toBeDisabled()
  })
})

describe('anyone else', () => {
  it.each(['open', 'design', 'operate'] as const)(
    'sees how it is set up as %s, and no form the daemon would refuse',
    async (role) => {
      access.mockResolvedValue(asRole(role))
      render(<AssistantSettings />)

      expect(await screen.findByText(/Anthropic · claude-opus-5-5 · listo/)).toBeVisible()
      expect(screen.getByText(/con su llave maestra/)).toBeVisible()
      expect(screen.queryByLabelText('Clave')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
    },
  )

  it('is told when there is no key', async () => {
    access.mockResolvedValue(asRole('design'))
    aiSettings.mockResolvedValue(
      settings({
        providers: {
          ...settings().providers,
          anthropic: { ...settings().providers.anthropic, configured: false, keyHint: '' },
        },
      }),
    )
    render(<AssistantSettings />)

    expect(await screen.findByText(/· sin clave/)).toBeVisible()
  })
})

it('shows nothing against a daemon that has no assistant', async () => {
  aiSettings.mockRejectedValue(new Error('404 Not Found'))
  const { container } = render(<AssistantSettings />)

  await waitFor(() => expect(aiSettings).toHaveBeenCalled())
  expect(container).toBeEmptyDOMElement()
})
