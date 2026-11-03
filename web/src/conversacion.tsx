/**
 * The assistant's screen: a conversation, its attachments, and at every step
 * what the assistant looked at and what it changed.
 *
 * Every tool call is shown as it happens, in words ("Ha aplicado +4 (fixtures,
 * functions)"), with what it was sent one tap away. An assistant that changes
 * a show where nobody can see it is an assistant nobody can trust with one.
 *
 * The conversation lives outside React, in this module: moving to the console
 * mid-turn leaves the turn running and the conversation where it was when you
 * come back. Keeping it across reloads and devices is the daemon's job (F10.3).
 *
 * Loaded on demand, like the 3D stage: the two provider SDKs are weight that
 * a phone running the console has no reason to download.
 */

import { OrchidClient } from '@orchid/mcp/client'
import type { ApplyReport } from '@orchid/mcp/spec/apply'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type Adjunto, prepararAdjunto } from './adjuntos'
import { turno } from './agente'
import { type AiSettings, api } from './api'
import { type Contexto, HERRAMIENTAS } from './herramientas'
import { t } from './i18n'
import { INSTRUCCIONES } from './instrucciones'
import {
  type Dialecto,
  DialectoAnthropic,
  DialectoOpenAI,
  anthropicCliente,
  openaiCliente,
} from './proveedores'
import { getToken } from './token'

export type Item =
  | { tipo: 'persona'; texto: string; adjuntos: { nombre: string; miniatura?: string }[] }
  | { tipo: 'asistente'; texto: string; pensando: string }
  | {
      tipo: 'herramienta'
      id: string
      nombre: string
      entrada: unknown
      estado: 'corriendo' | 'hecho' | 'fallo'
      resumen?: string
      cambios?: ApplyReport
    }
  | { tipo: 'aviso'; texto: string }

interface Estado {
  items: Item[]
  ocupado: boolean
  uso: { entrada: number; salida: number }
}

/* ---- the conversation, outside React ------------------------------------ */

let estado: Estado = { items: [], ocupado: false, uso: { entrada: 0, salida: 0 } }
let dialecto: Dialecto | null = null
/** Which provider and model the dialect was made for: a change starts over. */
let hechoPara = ''
let corte: AbortController | null = null
const oyentes = new Set<() => void>()

function cambiar(f: (anterior: Estado) => Estado) {
  estado = f(estado)
  for (const oyente of oyentes) oyente()
}

function suscribir(oyente: () => void) {
  oyentes.add(oyente)
  return () => oyentes.delete(oyente)
}

/** For tests: back to an empty conversation. */
export function olvidar() {
  corte?.abort()
  corte = null
  dialecto = null
  hechoPara = ''
  estado = { items: [], ocupado: false, uso: { entrada: 0, salida: 0 } }
  for (const oyente of oyentes) oyente()
}

/** Text arrives as deltas; it joins the assistant's last words unless a tool
 *  ran since, in which case it is a new paragraph of the turn. */
function alUltimo(campo: 'texto' | 'pensando', delta: string) {
  cambiar((e) => {
    const ultimo = e.items.at(-1)
    if (ultimo?.tipo === 'asistente') {
      const actualizado = { ...ultimo, [campo]: ultimo[campo] + delta }
      return { ...e, items: [...e.items.slice(0, -1), actualizado] }
    }
    const nuevo: Item = { tipo: 'asistente', texto: '', pensando: '', [campo]: delta }
    return { ...e, items: [...e.items, nuevo] }
  })
}

function mensajeDe(causa: unknown): string {
  /* The SDKs put the provider's own words in .error; ours come in the same
     shape from the proxy. */
  const cuerpo = (causa as { error?: { error?: { message?: string }; message?: string } }).error
  return (
    cuerpo?.error?.message ??
    cuerpo?.message ??
    (causa instanceof Error ? causa.message : String(causa))
  )
}

function abortado(causa: unknown): boolean {
  return (
    corte?.signal.aborted === true ||
    (causa instanceof Error && (causa.name === 'AbortError' || causa.name === 'APIUserAbortError'))
  )
}

export async function enviar(ajustes: AiSettings, texto: string, adjuntos: Adjunto[]) {
  if (estado.ocupado) return

  const proveedor = ajustes.provider
  const modelo =
    ajustes.providers[proveedor].model || (proveedor === 'anthropic' ? 'claude-opus-5-5' : '')
  const clave = `${proveedor} ${modelo}`
  if (dialecto === null || hechoPara !== clave) {
    const puerta = { origen: window.location.origin, llave: getToken() }
    dialecto =
      proveedor === 'anthropic'
        ? new DialectoAnthropic(anthropicCliente(puerta), modelo, HERRAMIENTAS, INSTRUCCIONES)
        : new DialectoOpenAI(openaiCliente(puerta), modelo, HERRAMIENTAS, INSTRUCCIONES)
    if (hechoPara !== '' && hechoPara !== clave) {
      cambiar((e) => ({
        ...e,
        items: [
          ...e.items,
          { tipo: 'aviso', texto: t('Otro proveedor o modelo: conversación nueva.') },
        ],
      }))
    }
    hechoPara = clave
  }

  corte = new AbortController()
  const llave = getToken()
  const contexto: Contexto = {
    client: new OrchidClient({
      baseUrl: window.location.origin,
      ...(llave ? { token: llave } : {}),
    }),
    signal: corte.signal,
    cache: {},
  }

  cambiar((e) => ({
    ...e,
    ocupado: true,
    items: [
      ...e.items,
      {
        tipo: 'persona',
        texto,
        adjuntos: adjuntos.map((a) => ({
          nombre: a.nombre,
          ...(a.miniatura ? { miniatura: a.miniatura } : {}),
        })),
      },
    ],
  }))

  try {
    await turno({
      dialecto,
      herramientas: HERRAMIENTAS,
      contexto,
      texto,
      adjuntos,
      evento: (ev) => {
        switch (ev.tipo) {
          case 'texto':
            alUltimo('texto', ev.delta)
            break
          case 'pensando':
            alUltimo('pensando', ev.delta)
            break
          case 'llamada':
            cambiar((e) => ({
              ...e,
              items: [
                ...e.items,
                {
                  tipo: 'herramienta',
                  id: ev.id,
                  nombre: ev.nombre,
                  entrada: ev.entrada,
                  estado: 'corriendo',
                },
              ],
            }))
            break
          case 'resultado':
            cambiar((e) => ({
              ...e,
              items: e.items.map((item) =>
                item.tipo === 'herramienta' && item.id === ev.id
                  ? {
                      ...item,
                      estado: ev.error ? 'fallo' : 'hecho',
                      resumen: ev.resumen,
                      ...(ev.cambios ? { cambios: ev.cambios } : {}),
                    }
                  : item,
              ),
            }))
            break
          case 'uso':
            cambiar((e) => ({
              ...e,
              uso: { entrada: e.uso.entrada + ev.entrada, salida: e.uso.salida + ev.salida },
            }))
            break
          case 'aviso':
            cambiar((e) => ({ ...e, items: [...e.items, { tipo: 'aviso', texto: ev.texto }] }))
            break
        }
      },
    })
  } catch (causa) {
    const texto = abortado(causa) ? t('Parado.') : `${t('Error')}: ${mensajeDe(causa)}`
    cambiar((e) => ({ ...e, items: [...e.items, { tipo: 'aviso', texto }] }))
  } finally {
    corte = null
    cambiar((e) => ({ ...e, ocupado: false }))
  }
}

export function parar() {
  corte?.abort()
}

export function nueva() {
  if (estado.ocupado) return
  dialecto = null
  hechoPara = ''
  cambiar(() => ({ items: [], ocupado: false, uso: { entrada: 0, salida: 0 } }))
}

/* ---- the screen ---------------------------------------------------------- */

/** 150 is 150, not "0k"; 34 567 is 35k. */
function miles(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

const ETIQUETA: Record<string, string> = {
  ver_proyecto: 'Mirar el proyecto',
  ver: 'Mirar',
  libreria: 'Librería',
  mapa_universo: 'Mapa del universo',
  entradas_y_salidas: 'Entradas y salidas',
  proponer: 'Ensayar',
  aplicar: 'Aplicar',
  probar: 'Probar con luz',
  leer_dmx: 'Leer el DMX',
}

function Paso({ item }: { item: Extract<Item, { tipo: 'herramienta' }> }) {
  return (
    <details className="chat-tool" data-estado={item.estado}>
      <summary>
        <span className="chat-tool-name">{t(ETIQUETA[item.nombre] ?? item.nombre)}</span>
        <span className="chat-tool-summary">
          {item.estado === 'corriendo' ? t('trabajando…') : item.resumen}
        </span>
      </summary>
      <pre>{JSON.stringify(item.entrada, null, 2).slice(0, 6000)}</pre>
      {item.cambios && (
        <ul className="chat-changes">
          {item.cambios.actions.map((a) => (
            <li key={`${a.section}-${a.kind}-${a.name}`} data-kind={a.kind}>
              {a.kind === 'create' ? '+' : a.kind === 'update' ? '~' : '−'} {a.section}: {a.name}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

export default function Conversacion() {
  const actual = useSyncExternalStore(suscribir, () => estado)
  const [ajustes, setAjustes] = useState<AiSettings | null>(null)
  const [maestra, setMaestra] = useState(false)
  const [cargado, setCargado] = useState(false)
  const [texto, setTexto] = useState('')
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([])
  const [problema, setProblema] = useState<string | null>(null)
  const final = useRef<HTMLDivElement | null>(null)
  const archivo = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    Promise.all([api.aiSettings(), api.access()])
      .then(([s, a]) => {
        setAjustes(s)
        setMaestra(a.role === 'master')
      })
      .catch(() => setAjustes(null))
      .finally(() => setCargado(true))
  }, [])

  const cuantos = actual.items.length
  useEffect(() => {
    if (cuantos > 0) final.current?.scrollIntoView?.({ block: 'end' })
  }, [cuantos])

  if (!cargado) return null

  const proveedor = ajustes?.provider
  const listo =
    ajustes !== null && (proveedor === 'openai' || ajustes.providers.anthropic.configured)

  if (!listo) {
    return (
      <section className="chat chat-empty">
        <h2>{t('Asistente')}</h2>
        <p className="hint">
          {maestra
            ? t('Configura el proveedor y la clave en Ajustes para empezar.')
            : t(
                'El asistente no está configurado en esta mesa. Se hace desde su equipo, con la llave maestra.',
              )}
        </p>
      </section>
    )
  }

  const modelo = ajustes.providers[ajustes.provider].model
  const soloImagenes = ajustes.provider === 'openai'

  const adjuntar = async (lista: FileList | null) => {
    setProblema(null)
    for (const f of [...(lista ?? [])]) {
      if (soloImagenes && f.type === 'application/pdf') {
        setProblema(t('Este proveedor no lee PDF: exporta el plano como imagen.'))
        continue
      }
      try {
        const listoAdjunto = await prepararAdjunto(f)
        setAdjuntos((actuales) => [...actuales, listoAdjunto])
      } catch (causa) {
        setProblema(causa instanceof Error ? causa.message : String(causa))
      }
    }
  }

  const mandar = () => {
    const limpio = texto.trim()
    if (limpio === '' || actual.ocupado) return
    const llevar = adjuntos
    setTexto('')
    setAdjuntos([])
    void enviar(ajustes, limpio, llevar)
  }

  return (
    <section className="chat">
      <header className="chat-head">
        <h2>{t('Asistente')}</h2>
        <span className="hint">
          {proveedor === 'anthropic' ? 'Anthropic' : t('Compatible con OpenAI')}
          {modelo ? ` · ${modelo}` : ''}
          {actual.uso.entrada > 0 &&
            ` · ${miles(actual.uso.entrada)} / ${miles(actual.uso.salida)} tokens`}
        </span>
        <button type="button" onClick={nueva} disabled={actual.ocupado || cuantos === 0}>
          {t('Nueva conversación')}
        </button>
      </header>

      <div className="chat-log" aria-live="polite">
        {cuantos === 0 && (
          <p className="hint chat-intro">
            {t(
              'Cuéntale qué hay en la sala y qué quieres: fotos del espacio, el plano, qué foco va en cada sitio. Monta el proyecto aquí delante; los cambios se deshacen con ↶. Guardar es tuyo.',
            )}
          </p>
        )}
        {actual.items.map((item, i) => {
          switch (item.tipo) {
            case 'persona':
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows; position is identity
                <article key={i} className="chat-item" data-role="persona">
                  {item.adjuntos.length > 0 && (
                    <div className="chat-attachments">
                      {item.adjuntos.map((a) =>
                        a.miniatura ? (
                          <img key={a.nombre} src={a.miniatura} alt={a.nombre} />
                        ) : (
                          <span key={a.nombre} className="chat-file">
                            {a.nombre}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  <p>{item.texto}</p>
                </article>
              )
            case 'asistente':
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows; position is identity
                <article key={i} className="chat-item" data-role="asistente">
                  {item.pensando && (
                    <details className="chat-thinking">
                      <summary>{t('Razonamiento')}</summary>
                      <p>{item.pensando}</p>
                    </details>
                  )}
                  {item.texto && <p>{item.texto}</p>}
                </article>
              )
            case 'herramienta':
              return <Paso key={item.id} item={item} />
            case 'aviso':
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows; position is identity
                <output key={i} className="chat-notice">
                  {item.texto}
                </output>
              )
          }
        })}
        <div ref={final} />
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          mandar()
        }}
      >
        {adjuntos.length > 0 && (
          <div className="chat-attachments">
            {adjuntos.map((a, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: two photos may share a name
                key={i}
                type="button"
                className="chat-attachment"
                title={t('Quitar')}
                onClick={() => setAdjuntos((actuales) => actuales.filter((_, j) => j !== i))}
              >
                {a.miniatura ? <img src={a.miniatura} alt={a.nombre} /> : a.nombre} ×
              </button>
            ))}
          </div>
        )}
        {problema && (
          <p className="remote-error" role="alert">
            {problema}
          </p>
        )}
        <textarea
          value={texto}
          rows={3}
          aria-label={t('Mensaje')}
          placeholder={t('Qué quieres montar o cambiar…')}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            /* Enter sends, as in every chat; Shift+Enter is a new line. */
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              mandar()
            }
          }}
        />
        <div className="chat-actions">
          <input
            ref={archivo}
            type="file"
            hidden
            multiple
            accept={soloImagenes ? 'image/*' : 'image/*,application/pdf'}
            onChange={(e) => {
              void adjuntar(e.target.files)
              e.target.value = ''
            }}
          />
          <button type="button" onClick={() => archivo.current?.click()} disabled={actual.ocupado}>
            {t('Adjuntar')}
          </button>
          {actual.ocupado ? (
            <button type="button" className="danger" onClick={parar}>
              {t('Parar')}
            </button>
          ) : (
            <button type="submit" disabled={texto.trim() === ''}>
              {t('Enviar')}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
