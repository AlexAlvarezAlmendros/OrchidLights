/**
 * The loop, against a scripted model.
 *
 * What it must never do is the subject here: run a tool from a turn cut off
 * by length or declined, run an input that does not fit its schema, or leave
 * a tool call without an answer -- the provider refuses the next request of a
 * history like that, and the conversation is dead.
 */

import { describe, expect, it, vi } from 'vitest'
import { type Evento, VUELTAS_MAXIMAS, turno } from './agente'
import type { Contexto, Herramienta } from './herramientas'
import type { Dialecto, Respuesta } from './proveedores'

/** A dialect that replays answers and records what the loop handed it. */
function guion(respuestas: Respuesta[]) {
  const usuario: string[] = []
  const resultados: { id: string; contenido: string; error: boolean }[][] = []
  const pendientes = [...respuestas]
  const dialecto: Dialecto = {
    usuario: (texto) => usuario.push(texto),
    llamar: async (eventos) => {
      const siguiente = pendientes.shift()
      if (!siguiente) throw new Error('el guion se acabó')
      eventos.texto('…')
      return siguiente
    },
    resultados: (r) => resultados.push(r),
  }
  return { dialecto, usuario, resultados }
}

const USO = { entrada: 10, salida: 5 }

function respuesta(fin: Respuesta['fin'], llamadas: Respuesta['llamadas'] = []): Respuesta {
  return { fin, llamadas, uso: USO }
}

function herramienta(
  nombre: string,
  ejecutar = vi.fn(async () => ({ texto: 'hecho', resumen: 'Hecho' })),
) {
  const h: Herramienta = {
    nombre,
    descripcion: nombre,
    esquema: {
      type: 'object',
      properties: { nombre: { type: 'string' } },
      required: ['nombre'],
    },
    ejecutar,
  }
  return { h, ejecutar }
}

function contexto(signal = new AbortController().signal): Contexto {
  return { client: {} as Contexto['client'], signal, cache: {} }
}

async function correr(dialecto: Dialecto, herramientas: Herramienta[], c = contexto()) {
  const eventos: Evento[] = []
  await turno({
    dialecto,
    herramientas,
    contexto: c,
    texto: 'hola',
    adjuntos: [],
    evento: (e) => eventos.push(e),
  })
  return eventos
}

describe('a turn', () => {
  it('ends when the model answers without tools', async () => {
    const { dialecto, usuario, resultados } = guion([respuesta('fin')])
    const eventos = await correr(dialecto, [])

    expect(usuario).toEqual(['hola'])
    expect(resultados).toEqual([])
    expect(eventos).toContainEqual({ tipo: 'uso', ...USO })
  })

  it('runs a valid call and gives every result back in one message', async () => {
    const { h, ejecutar } = herramienta('ver')
    const { dialecto, resultados } = guion([
      respuesta('herramientas', [
        { id: 'a', nombre: 'ver', entrada: { nombre: 'Par 1' } },
        { id: 'b', nombre: 'ver', entrada: { nombre: 'Par 2' } },
      ]),
      respuesta('fin'),
    ])
    const eventos = await correr(dialecto, [h])

    expect(ejecutar).toHaveBeenCalledTimes(2)
    expect(resultados).toHaveLength(1)
    expect(resultados[0]).toEqual([
      { id: 'a', contenido: 'hecho', error: false },
      { id: 'b', contenido: 'hecho', error: false },
    ])
    expect(eventos.filter((e) => e.tipo === 'llamada')).toHaveLength(2)
  })

  it('does not run an input that does not fit its schema, and says why', async () => {
    const { h, ejecutar } = herramienta('ver')
    const { dialecto, resultados } = guion([
      respuesta('herramientas', [{ id: 'a', nombre: 'ver', entrada: { nombre: 42 } }]),
      respuesta('fin'),
    ])
    await correr(dialecto, [h])

    expect(ejecutar).not.toHaveBeenCalled()
    expect(resultados[0]?.[0]).toMatchObject({ id: 'a', error: true })
    expect(resultados[0]?.[0]?.contenido).toMatch(/entrada\.nombre tiene que ser texto/)
  })

  it('never runs the tools of a turn cut off by length, and still answers them', async () => {
    const { h, ejecutar } = herramienta('aplicar')
    const { dialecto, resultados } = guion([
      respuesta('cortado', [{ id: 'a', nombre: 'aplicar', entrada: { nombre: 'medio documen' } }]),
      respuesta('fin'),
    ])
    const eventos = await correr(dialecto, [h])

    expect(ejecutar).not.toHaveBeenCalled()
    expect(resultados[0]).toEqual([
      { id: 'a', contenido: expect.stringMatching(/se cortó/), error: true },
    ])
    expect(eventos).toContainEqual({ tipo: 'aviso', texto: expect.stringMatching(/cortó/) })
  })

  it('never runs the tools of a declined turn, answers them, and stops', async () => {
    const { h, ejecutar } = herramienta('aplicar')
    const { dialecto, resultados } = guion([
      respuesta('rechazo', [{ id: 'a', nombre: 'aplicar', entrada: { nombre: 'x' } }]),
    ])
    const eventos = await correr(dialecto, [h])

    expect(ejecutar).not.toHaveBeenCalled()
    expect(resultados[0]?.[0]).toMatchObject({ id: 'a', error: true })
    expect(eventos.at(-1)).toEqual({ tipo: 'aviso', texto: expect.stringMatching(/declinado/) })
  })

  it('answers an unknown tool with an error instead of throwing', async () => {
    const { dialecto, resultados } = guion([
      respuesta('herramientas', [{ id: 'a', nombre: 'borrar_todo', entrada: {} }]),
      respuesta('fin'),
    ])
    await correr(dialecto, [])

    expect(resultados[0]?.[0]).toMatchObject({
      error: true,
      contenido: expect.stringMatching(/No existe/),
    })
  })

  it('turns a tool that throws into an error result the model can read', async () => {
    const { h } = herramienta(
      'ver',
      vi.fn(async () => {
        throw new Error('GET /fixtures → 500: boom')
      }),
    )
    const { dialecto, resultados } = guion([
      respuesta('herramientas', [{ id: 'a', nombre: 'ver', entrada: { nombre: 'x' } }]),
      respuesta('fin'),
    ])
    await correr(dialecto, [h])

    expect(resultados[0]?.[0]).toMatchObject({
      error: true,
      contenido: expect.stringMatching(/boom/),
    })
  })

  it('stopped mid-turn, answers the calls it did not run and ends', async () => {
    const corte = new AbortController()
    const { h, ejecutar } = herramienta(
      'ver',
      vi.fn(async () => {
        corte.abort()
        return { texto: 'hecho', resumen: 'Hecho' }
      }),
    )
    const { dialecto, resultados } = guion([
      respuesta('herramientas', [
        { id: 'a', nombre: 'ver', entrada: { nombre: '1' } },
        { id: 'b', nombre: 'ver', entrada: { nombre: '2' } },
      ]),
      respuesta('fin'),
    ])
    await correr(dialecto, [h], contexto(corte.signal))

    expect(ejecutar).toHaveBeenCalledTimes(1)
    expect(resultados[0]).toEqual([
      { id: 'a', contenido: 'hecho', error: false },
      { id: 'b', contenido: 'Cancelado por la persona.', error: true },
    ])
  })

  it('gives up after too many rounds rather than looping for ever', async () => {
    const { h } = herramienta('ver')
    const bucle = Array.from({ length: VUELTAS_MAXIMAS }, (_, i) =>
      respuesta('herramientas', [{ id: `c${i}`, nombre: 'ver', entrada: { nombre: 'x' } }]),
    )
    const { dialecto } = guion(bucle)
    const eventos = await correr(dialecto, [h])

    expect(eventos.at(-1)).toEqual({ tipo: 'aviso', texto: expect.stringMatching(/vueltas/) })
  })
})
