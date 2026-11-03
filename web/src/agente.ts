/**
 * One turn of the assistant: the model talks, asks for tools, gets their
 * results, and goes on until it has nothing left to ask.
 *
 * Small on purpose. What makes it safe is in three places, not here: the
 * tools check every input before running, the document engine validates a
 * whole document before touching the desk, and the daemon keeps the key. The
 * loop's own job is to never leave the history in a state the provider will
 * refuse -- every tool call it was shown gets an answer, even "not run" --
 * and to never run what it should not: nothing from a turn cut off by length
 * (a truncated input parses as a plausible partial object) or declined.
 */

import type { ApplyReport } from '@orchid/mcp/spec/apply'
import type { Adjunto } from './adjuntos'
import { type Contexto, type Herramienta, ejecutar } from './herramientas'
import type { Dialecto } from './proveedores'

export type Evento =
  | { tipo: 'texto'; delta: string }
  | { tipo: 'pensando'; delta: string }
  | { tipo: 'llamada'; id: string; nombre: string; entrada: unknown }
  | {
      tipo: 'resultado'
      id: string
      error: boolean
      resumen: string
      cambios?: ApplyReport
    }
  | { tipo: 'uso'; entrada: number; salida: number }
  | { tipo: 'aviso'; texto: string }

/** A turn that has not finished after this many model calls is stuck, not
 *  thorough. */
export const VUELTAS_MAXIMAS = 40

export async function turno(opciones: {
  dialecto: Dialecto
  herramientas: Herramienta[]
  contexto: Contexto
  texto: string
  adjuntos: Adjunto[]
  evento: (evento: Evento) => void
}): Promise<void> {
  const { dialecto, herramientas, contexto, evento } = opciones
  dialecto.usuario(opciones.texto, opciones.adjuntos)

  const noEjecutadas = (ids: string[], motivo: string) =>
    dialecto.resultados(ids.map((id) => ({ id, contenido: motivo, error: true })))

  for (let vuelta = 0; vuelta < VUELTAS_MAXIMAS; vuelta++) {
    const respuesta = await dialecto.llamar(
      {
        texto: (delta) => evento({ tipo: 'texto', delta }),
        pensando: (delta) => evento({ tipo: 'pensando', delta }),
      },
      contexto.signal,
    )
    evento({ tipo: 'uso', ...respuesta.uso })
    const ids = respuesta.llamadas.map((l) => l.id)

    if (respuesta.fin === 'rechazo') {
      if (ids.length > 0) noEjecutadas(ids, 'No ejecutado: la respuesta fue rechazada.')
      evento({ tipo: 'aviso', texto: 'El modelo ha declinado seguir con esta petición.' })
      return
    }

    if (respuesta.fin === 'cortado') {
      if (ids.length === 0) {
        evento({ tipo: 'aviso', texto: 'La respuesta se cortó por larga.' })
        return
      }
      noEjecutadas(
        ids,
        'No ejecutado: la entrada se cortó al llegar al límite de longitud. Manda el documento en partes más pequeñas.',
      )
      evento({
        tipo: 'aviso',
        texto: 'Una entrada se cortó por larga; se le ha pedido que la parta.',
      })
      continue
    }

    if (respuesta.fin === 'pausa') continue
    if (ids.length === 0) return

    /* In order, never in parallel: two documents applied at once are two
       writers on one show. */
    const resultados: { id: string; contenido: string; error: boolean }[] = []
    for (const llamada of respuesta.llamadas) {
      if (contexto.signal.aborted) {
        resultados.push({ id: llamada.id, contenido: 'Cancelado por la persona.', error: true })
        continue
      }
      evento({ tipo: 'llamada', id: llamada.id, nombre: llamada.nombre, entrada: llamada.entrada })
      const r = await ejecutar(herramientas, llamada.nombre, llamada.entrada, contexto)
      evento({
        tipo: 'resultado',
        id: llamada.id,
        error: r.error,
        resumen: r.resumen,
        ...(r.cambios ? { cambios: r.cambios } : {}),
      })
      resultados.push({ id: llamada.id, contenido: r.texto, error: r.error })
    }
    dialecto.resultados(resultados)

    if (contexto.signal.aborted) return
  }

  evento({ tipo: 'aviso', texto: `Parado tras ${VUELTAS_MAXIMAS} vueltas sin terminar.` })
}
