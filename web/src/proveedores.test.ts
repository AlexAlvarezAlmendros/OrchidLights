/**
 * The two dialects, against SDK clients that record what they were asked.
 *
 * Not HTTP -- ai-smoke.sh does the proxy end to end -- but the shape of what
 * each dialect sends, because that is where the money and the safety are:
 * the cached prefix, eager input streaming, thinking and fallback only for
 * the models that take them, attachments in each provider's own blocks, and
 * a history that is only ever appended to.
 */

import Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import type { Herramienta } from './herramientas'
import { DialectoAnthropic, DialectoOpenAI } from './proveedores'

const HERRAMIENTA: Herramienta = {
  nombre: 'ver',
  descripcion: 'Mirar algo',
  esquema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] },
  ejecutar: vi.fn(),
}

const EVENTOS = { texto: vi.fn(), pensando: vi.fn() }

function mensaje(contenido: unknown[], stop: string) {
  return {
    content: contenido,
    stop_reason: stop,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens: 40,
    },
  }
}

function anthropicFalso(respuestas: (() => Promise<unknown>)[]) {
  const pedidos: Record<string, unknown>[] = []
  const pendientes = [...respuestas]
  const cliente = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          /* A snapshot: the dialect keeps appending to the same history
             array, and the test wants what was sent at the time. */
          pedidos.push(structuredClone(params))
          const siguiente = pendientes.shift()
          return {
            on: () => undefined,
            finalMessage: () => (siguiente ? siguiente() : Promise.reject()),
          }
        },
      },
    },
  }
  return { cliente: cliente as unknown as Anthropic, pedidos }
}

describe('Anthropic', () => {
  it('caches the prefix, streams tool inputs, and on a current model thinks and falls back', async () => {
    const { cliente, pedidos } = anthropicFalso([
      async () => mensaje([{ type: 'text', text: 'hola' }], 'end_turn'),
    ])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [HERRAMIENTA], 'SISTEMA')
    d.usuario('monta la sala', [])
    const r = await d.llamar(EVENTOS, new AbortController().signal)

    const p = pedidos[0] as Record<string, unknown>
    expect(p.system).toEqual([
      { type: 'text', text: 'SISTEMA', cache_control: { type: 'ephemeral' } },
    ])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.tools).toEqual([
      {
        name: 'ver',
        description: 'Mirar algo',
        input_schema: HERRAMIENTA.esquema,
        eager_input_streaming: true,
      },
    ])
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.fallbacks).toBe('default')
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(r).toEqual({ llamadas: [], fin: 'fin', uso: { entrada: 1050, salida: 40 } })
  })

  it('sends an older model none of what it would refuse', async () => {
    const { cliente, pedidos } = anthropicFalso([async () => mensaje([], 'end_turn')])
    const d = new DialectoAnthropic(cliente, 'claude-3-haiku', [HERRAMIENTA], 'S')
    d.usuario('hola', [])
    await d.llamar(EVENTOS, new AbortController().signal)

    const p = pedidos[0] as Record<string, unknown>
    expect(p.thinking).toBeUndefined()
    expect(p.output_config).toBeUndefined()
    expect(p.fallbacks).toBeUndefined()
  })

  it('puts photos and plans in their own blocks, before the words', () => {
    const { cliente } = anthropicFalso([])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [], 'S')
    d.usuario('esta es la sala', [
      { nombre: 'sala.jpg', mediaType: 'image/jpeg', datos: 'AAA' },
      { nombre: 'plano.pdf', mediaType: 'application/pdf', datos: 'BBB' },
    ])

    expect(d.historial[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'BBB' },
          title: 'plano.pdf',
        },
        { type: 'text', text: 'esta es la sala' },
      ],
    })
  })

  it('appends the answer as it came, thinking included, and every result in one message', async () => {
    const contenido = [
      { type: 'thinking', thinking: '…', signature: 'firma' },
      { type: 'tool_use', id: 't1', name: 'ver', input: { nombre: 'Par 1' } },
      { type: 'tool_use', id: 't2', name: 'ver', input: { nombre: 'Par 2' } },
    ]
    const { cliente } = anthropicFalso([async () => mensaje(contenido, 'tool_use')])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [HERRAMIENTA], 'S')
    d.usuario('mira', [])
    const r = await d.llamar(EVENTOS, new AbortController().signal)
    d.resultados([
      { id: 't1', contenido: 'uno', error: false },
      { id: 't2', contenido: 'dos', error: true },
    ])

    expect(r.fin).toBe('herramientas')
    expect(r.llamadas).toEqual([
      { id: 't1', nombre: 'ver', entrada: { nombre: 'Par 1' } },
      { id: 't2', nombre: 'ver', entrada: { nombre: 'Par 2' } },
    ])
    expect(d.historial[1]).toEqual({ role: 'assistant', content: contenido })
    expect(d.historial[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'uno' },
        { type: 'tool_result', tool_use_id: 't2', content: 'dos', is_error: true },
      ],
    })
  })

  it.each([
    ['max_tokens', 'cortado'],
    ['refusal', 'rechazo'],
    ['pause_turn', 'pausa'],
  ])('reads %s as %s', async (stop, fin) => {
    const { cliente } = anthropicFalso([async () => mensaje([], stop)])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [], 'S')
    d.usuario('x', [])
    expect((await d.llamar(EVENTOS, new AbortController().signal)).fin).toBe(fin)
  })

  it('asks again when a tool input was not JSON at all, and only then', async () => {
    const { cliente, pedidos } = anthropicFalso([
      async () => {
        throw new SyntaxError('Unexpected token in JSON')
      },
      async () => mensaje([{ type: 'text', text: 'ya' }], 'end_turn'),
    ])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [], 'S')
    d.usuario('x', [])
    const r = await d.llamar(EVENTOS, new AbortController().signal)

    expect(pedidos).toHaveLength(2)
    expect(r.fin).toBe('fin')
    // The failed attempt left nothing behind.
    expect(d.historial).toHaveLength(2)
  })

  it('does not retry an API error', async () => {
    const error = new Anthropic.APIError(403, { type: 'error' }, 'tope', new Headers())
    const { cliente, pedidos } = anthropicFalso([
      async () => {
        throw error
      },
    ])
    const d = new DialectoAnthropic(cliente, 'claude-opus-5-5', [], 'S')
    d.usuario('x', [])

    await expect(d.llamar(EVENTOS, new AbortController().signal)).rejects.toBe(error)
    expect(pedidos).toHaveLength(1)
  })
})

function openaiFalso(completion: unknown) {
  const pedidos: Record<string, unknown>[] = []
  const cliente = {
    chat: {
      completions: {
        stream: (params: Record<string, unknown>) => {
          pedidos.push(structuredClone(params))
          return { on: () => undefined, finalChatCompletion: async () => completion }
        },
      },
    },
  }
  return { cliente: cliente as unknown as OpenAI, pedidos }
}

describe('OpenAI-compatible', () => {
  it('sends the system prompt first, tools as functions, and photos as data URLs', async () => {
    const { cliente, pedidos } = openaiFalso({
      choices: [{ message: { role: 'assistant', content: 'hola' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 4 },
    })
    const d = new DialectoOpenAI(cliente, 'llama3', [HERRAMIENTA], 'SISTEMA')
    d.usuario('la sala', [{ nombre: 'sala.jpg', mediaType: 'image/jpeg', datos: 'AAA' }])
    const r = await d.llamar(EVENTOS, new AbortController().signal)

    const p = pedidos[0] as { messages: unknown[]; tools: unknown[]; model: string }
    expect(p.model).toBe('llama3')
    expect(p.messages[0]).toEqual({ role: 'system', content: 'SISTEMA' })
    expect(p.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        { type: 'text', text: 'la sala' },
      ],
    })
    expect(p.tools).toEqual([
      {
        type: 'function',
        function: { name: 'ver', description: 'Mirar algo', parameters: HERRAMIENTA.esquema },
      },
    ])
    expect(r).toEqual({ llamadas: [], fin: 'fin', uso: { entrada: 30, salida: 4 } })
  })

  it('reads tool calls, keeps arguments that are not JSON for the check to refuse, and answers each', async () => {
    const llamadas = [
      { id: 'c1', type: 'function', function: { name: 'ver', arguments: '{"nombre":"Par 1"}' } },
      { id: 'c2', type: 'function', function: { name: 'ver', arguments: '{"nombre": "Par' } },
    ]
    const { cliente } = openaiFalso({
      choices: [
        {
          message: { role: 'assistant', content: null, tool_calls: llamadas },
          finish_reason: 'tool_calls',
        },
      ],
    })
    const d = new DialectoOpenAI(cliente, 'gpt-x', [HERRAMIENTA], 'S')
    d.usuario('x', [])
    const r = await d.llamar(EVENTOS, new AbortController().signal)
    d.resultados([
      { id: 'c1', contenido: 'uno', error: false },
      { id: 'c2', contenido: 'mal', error: true },
    ])

    expect(r.fin).toBe('herramientas')
    expect(r.llamadas).toEqual([
      { id: 'c1', nombre: 'ver', entrada: { nombre: 'Par 1' } },
      { id: 'c2', nombre: 'ver', entrada: '{"nombre": "Par' },
    ])
    expect(d.historial.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'uno' },
      { role: 'tool', tool_call_id: 'c2', content: 'ERROR: mal' },
    ])
  })

  it('reads a length stop as cut off, tools or not', async () => {
    const { cliente } = openaiFalso({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'ver', arguments: '{"nom' } },
            ],
          },
          finish_reason: 'length',
        },
      ],
    })
    const d = new DialectoOpenAI(cliente, 'gpt-x', [HERRAMIENTA], 'S')
    d.usuario('x', [])
    expect((await d.llamar(EVENTOS, new AbortController().signal)).fin).toBe('cortado')
  })
})
