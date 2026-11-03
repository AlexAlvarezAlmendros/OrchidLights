/**
 * The two dialects the assistant speaks: Anthropic's Messages API and the
 * OpenAI-style chat completions that ChatGPT, Gemini, OpenRouter, Ollama and
 * LM Studio share.
 *
 * Both go through the daemon's proxy, never to the provider: the SDK is
 * pointed at /api/v1/ai/proxy/<dialect>, the daemon drops whatever
 * authentication the browser sent and puts the stored key on. The placeholder
 * keys below are exactly that -- the browser never holds the real one.
 *
 * Each dialect keeps its history in its provider's OWN format and only ever
 * appends to it. Anthropic's thinking blocks have to go back unchanged on
 * every request, and a conversation translated to a neutral shape and back
 * is a conversation that silently loses them. Switching provider starts a new
 * conversation; that is the price, and it is the honest one.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { Adjunto } from './adjuntos'
import type { Herramienta } from './herramientas'

export interface Llamada {
  id: string
  nombre: string
  /** As the model sent it -- validated by the loop before anything runs. */
  entrada: unknown
}

export interface Respuesta {
  llamadas: Llamada[]
  /**
   * Why the model stopped: done, wants tools, ran out of room (a tool input
   * cut off at max_tokens parses as a plausible partial object, so this is
   * what catches it), declined, or a server tool paused.
   */
  fin: 'fin' | 'herramientas' | 'cortado' | 'rechazo' | 'pausa'
  uso: { entrada: number; salida: number }
}

export interface Eventos {
  texto: (delta: string) => void
  pensando: (delta: string) => void
}

export interface Dialecto {
  usuario: (texto: string, adjuntos: Adjunto[]) => void
  llamar: (eventos: Eventos, signal: AbortSignal) => Promise<Respuesta>
  resultados: (resultados: { id: string; contenido: string; error: boolean }[]) => void
}

/** Where the proxy is, and the desk's own key for reaching it. */
export interface Puerta {
  origen: string
  /** The daemon's bearer key, when this browser holds one. */
  llave: string | null
}

/* ---- Anthropic --------------------------------------------------------- */

/* Thinking, effort and server-side fallback are features of the current
   models; sending them to an older one is a 400. Matched by family rather
   than kept as a list of ids that goes stale with every release. */
const CURRENT_CLAUDE = /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/
const FALLBACK_CLAUDE = /^claude-(opus-5|fable-5-1|sonnet-5-5)/

export function anthropicCliente(puerta: Puerta): Anthropic {
  return new Anthropic({
    baseURL: `${puerta.origen}/api/v1/ai/proxy/anthropic`,
    apiKey: 'la-pone-la-mesa',
    dangerouslyAllowBrowser: true,
    defaultHeaders: puerta.llave ? { Authorization: `Bearer ${puerta.llave}` } : {},
  })
}

export class DialectoAnthropic implements Dialecto {
  readonly historial: Anthropic.Beta.BetaMessageParam[] = []
  /** Consecutive turns whose tool input could not be parsed at all. */
  private jsonFallidos = 0

  constructor(
    private readonly cliente: Anthropic,
    private readonly modelo: string,
    private readonly herramientas: Herramienta[],
    private readonly sistema: string,
  ) {}

  usuario(texto: string, adjuntos: Adjunto[]) {
    const bloques: Anthropic.Beta.BetaContentBlockParam[] = adjuntos.map((a) =>
      a.mediaType === 'application/pdf'
        ? {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: a.datos },
            title: a.nombre,
          }
        : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.datos } },
    )
    bloques.push({ type: 'text', text: texto })
    this.historial.push({ role: 'user', content: bloques })
  }

  async llamar(eventos: Eventos, signal: AbortSignal): Promise<Respuesta> {
    const actual = CURRENT_CLAUDE.test(this.modelo)
    const fallbacks = FALLBACK_CLAUDE.test(this.modelo)

    const stream = this.cliente.beta.messages.stream(
      {
        model: this.modelo,
        max_tokens: 64000,
        /* The tools, then the system prompt: the stable prefix, cached. The
           top-level breakpoint caches the conversation as it grows. */
        system: [{ type: 'text', text: this.sistema, cache_control: { type: 'ephemeral' } }],
        tools: this.herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.esquema as Anthropic.Beta.BetaTool.InputSchema,
          /* A document for `aplicar` can run to thousands of tokens; without
             this nothing arrives until all of it is generated. The loop
             validates every input, which is what this gives up. */
          eager_input_streaming: true,
        })),
        messages: this.historial,
        cache_control: { type: 'ephemeral' },
        ...(actual
          ? {
              thinking: { type: 'adaptive', display: 'summarized' },
              /* Building a show is many steps that depend on each other. */
              output_config: { effort: 'high' },
            }
          : {}),
        /* A safety classifier can decline a request; this re-runs it on the
           model Anthropic recommends for that kind of decline instead of
           ending the turn. */
        ...(fallbacks
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      },
      { signal },
    )

    stream.on('text', (delta) => eventos.texto(delta))
    stream.on('thinking', (delta) => eventos.pensando(delta))

    let mensaje: Anthropic.Beta.BetaMessage
    try {
      mensaje = await stream.finalMessage()
      this.jsonFallidos = 0
    } catch (causa) {
      /* A tool input that is not JSON at all rejects here. Nothing of the
         turn reached the history, so asking again is safe -- twice, then it
         is the model's problem to report. API errors (and an abort, which is
         one) go straight up. */
      if (causa instanceof Anthropic.APIError || this.jsonFallidos++ >= 2) throw causa
      return this.llamar(eventos, signal)
    }

    this.historial.push({ role: 'assistant', content: mensaje.content })

    const llamadas = mensaje.content.flatMap((bloque) =>
      bloque.type === 'tool_use'
        ? [{ id: bloque.id, nombre: bloque.name, entrada: bloque.input }]
        : [],
    )
    const u = mensaje.usage
    return {
      llamadas,
      fin:
        mensaje.stop_reason === 'tool_use'
          ? 'herramientas'
          : mensaje.stop_reason === 'max_tokens'
            ? 'cortado'
            : mensaje.stop_reason === 'refusal'
              ? 'rechazo'
              : mensaje.stop_reason === 'pause_turn'
                ? 'pausa'
                : 'fin',
      uso: {
        entrada:
          u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        salida: u.output_tokens,
      },
    }
  }

  resultados(resultados: { id: string; contenido: string; error: boolean }[]) {
    /* All of them in ONE message: split across several, the model learns to
       stop calling tools in parallel. */
    this.historial.push({
      role: 'user',
      content: resultados.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.contenido,
        ...(r.error ? { is_error: true } : {}),
      })),
    })
  }
}

/* ---- OpenAI-compatible ------------------------------------------------- */

export function openaiCliente(puerta: Puerta): OpenAI {
  return new OpenAI({
    baseURL: `${puerta.origen}/api/v1/ai/proxy/openai`,
    /* The SDK sends this as Authorization, which is the header the daemon
       reads for its own key -- so the desk's key goes here, and the daemon
       swaps it for the provider's on the way out. */
    apiKey: puerta.llave ?? 'sin-llave',
    dangerouslyAllowBrowser: true,
  })
}

export class DialectoOpenAI implements Dialecto {
  readonly historial: OpenAI.Chat.Completions.ChatCompletionMessageParam[]

  constructor(
    private readonly cliente: OpenAI,
    private readonly modelo: string,
    private readonly herramientas: Herramienta[],
    sistema: string,
  ) {
    this.historial = [{ role: 'system', content: sistema }]
  }

  usuario(texto: string, adjuntos: Adjunto[]) {
    /* PDFs are Anthropic's alone here: the composer refuses them for this
       dialect, and one that slipped through is said rather than dropped. */
    const partes: OpenAI.Chat.Completions.ChatCompletionContentPart[] = adjuntos.flatMap(
      (a): OpenAI.Chat.Completions.ChatCompletionContentPart[] =>
        a.mediaType === 'application/pdf'
          ? [
              {
                type: 'text',
                text: `(Adjuntaron «${a.nombre}», un PDF que este proveedor no lee.)`,
              },
            ]
          : [{ type: 'image_url', image_url: { url: `data:${a.mediaType};base64,${a.datos}` } }],
    )
    partes.push({ type: 'text', text: texto })
    this.historial.push({ role: 'user', content: partes })
  }

  async llamar(eventos: Eventos, signal: AbortSignal): Promise<Respuesta> {
    const stream = this.cliente.chat.completions.stream(
      {
        model: this.modelo || 'modelo',
        messages: this.historial,
        tools: this.herramientas.map((h) => ({
          type: 'function' as const,
          function: { name: h.nombre, description: h.descripcion, parameters: { ...h.esquema } },
        })),
        stream_options: { include_usage: true },
      },
      { signal },
    )
    stream.on('content.delta', ({ delta }) => eventos.texto(delta))

    const completion = await stream.finalChatCompletion()
    const eleccion = completion.choices[0]
    const mensaje = eleccion?.message
    const funciones = (mensaje?.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [c] : []))

    this.historial.push({
      role: 'assistant',
      content: mensaje?.content ?? null,
      ...(funciones.length > 0 ? { tool_calls: funciones } : {}),
    })

    const llamadas = funciones.map((c) => {
      let entrada: unknown = null
      try {
        entrada = JSON.parse(c.function.arguments || '{}')
      } catch {
        /* Left as the raw text: the loop's check fails it and the model is
           told what it sent. */
        entrada = c.function.arguments
      }
      return { id: c.id, nombre: c.function.name, entrada }
    })

    const razon = eleccion?.finish_reason
    return {
      llamadas,
      fin:
        llamadas.length > 0 && razon !== 'length'
          ? 'herramientas'
          : razon === 'length'
            ? 'cortado'
            : razon === 'content_filter'
              ? 'rechazo'
              : 'fin',
      uso: {
        entrada: completion.usage?.prompt_tokens ?? 0,
        salida: completion.usage?.completion_tokens ?? 0,
      },
    }
  }

  resultados(resultados: { id: string; contenido: string; error: boolean }[]) {
    for (const r of resultados) {
      this.historial.push({
        role: 'tool',
        tool_call_id: r.id,
        content: r.error ? `ERROR: ${r.contenido}` : r.contenido,
      })
    }
  }
}
