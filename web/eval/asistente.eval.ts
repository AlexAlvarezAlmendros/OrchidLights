/**
 * The assistant, measured with a real model on fixed requests.
 *
 *   server/test/ai-eval.sh [orchidlightsd] [escenario ...]
 *
 * Unit tests prove the loop is safe and the tools are honest; they cannot
 * say whether the assistant builds a good show. That is what this measures:
 * the same loop, tools and instructions the screen uses, through the daemon's
 * proxy, against a throwaway desk -- and then the desk itself is checked for
 * what should be there. Without it, changing the instructions or the model is
 * guessing.
 *
 * Each run writes what it saw to $ORCHID_EVAL_OUT: the checks, the steps, the
 * final words, the time, the tokens and what they cost.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrchidClient } from '@orchid/mcp/client'
import { exportSpec } from '@orchid/mcp/spec/export'
import type { FunctionSpec, ShowSpec, WidgetSpec } from '@orchid/mcp/spec/types'
import { expect, it } from 'vitest'
import { turno } from '../src/agente'
import type { AiSettings } from '../src/api'
import { type Contexto, HERRAMIENTAS } from '../src/herramientas'
import { INSTRUCCIONES } from '../src/instrucciones'
import { DialectoAnthropic, anthropicCliente } from '../src/proveedores'

interface Comprobacion {
  que: string
  ok: boolean
  detalle?: string
}

interface Escenario {
  /** What the person asks, as they would ask it. */
  encargo: string
  /** Said once if the assistant asks instead of building: no more data. */
  siPregunta: string
  comprobar: (c: { client: OrchidClient; antes: ShowSpec; despues: ShowSpec }) => Promise<
    Comprobacion[]
  >
}

/* ---- helpers --------------------------------------------------------------- */

function widgets(
  lista: WidgetSpec[] = [],
  dentro: string[] = [],
): { ruta: string[]; w: WidgetSpec }[] {
  return lista.flatMap((w) => [
    { ruta: dentro, w },
    ...widgets(w.children, [...dentro, w.caption ?? w.type]),
  ])
}

function hex(color: string | null | undefined) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? '')
  return m
    ? {
        r: Number.parseInt(m[1] ?? '0', 16),
        g: Number.parseInt(m[2] ?? '0', 16),
        b: Number.parseInt(m[3] ?? '0', 16),
      }
    : null
}

function check(que: string, ok: boolean, detalle?: string): Comprobacion {
  return detalle === undefined ? { que, ok } : { que, ok, detalle }
}

/** Light a function, read what comes out of universe 1, put it out again. */
async function luz(client: OrchidClient, nombre: string) {
  const f = (await client.functions()).find((x) => x.name === nombre)
  if (!f) return null
  await client.post(`/functions/${f.id}/start`)
  await new Promise((r) => setTimeout(r, 2500))
  const lectura = await client.dmx(1)
  await client.post(`/functions/${f.id}/stop`)
  await new Promise((r) => setTimeout(r, 1500))
  return lectura.active
}

/* ---- the scenarios ------------------------------------------------------------ */

const ESCENARIOS: Record<string, Escenario> = {
  /* An empty desk, built from a description: patch, stage, looks, a chase and
     a console. Everything checkable from the request alone. */
  'par-truss': {
    encargo:
      'Tengo cuatro focos Stairville LED PAR56 colgados en una barra frontal a 5 metros de altura, ' +
      'repartidos a lo ancho de un escenario de 10 metros de ancho y 6 de fondo. Van en el universo 1 ' +
      'desde la dirección 1, seguidos. Monta el patch y colócalos en el escenario; hazme una escena azul, ' +
      'una roja y una ámbar con todos a tope, un chaser que vaya pasando de una a otra cada dos segundos, ' +
      'y una botonera para lanzarlo todo, con colores.',
    siPregunta: 'No tengo más datos: decide tú lo razonable y móntalo.',
    comprobar: async ({ client, despues }) => {
      const out: Comprobacion[] = []
      const pares = (despues.fixtures ?? []).filter(
        (f) => f.manufacturer === 'Stairville' && f.model === 'LED PAR56',
      )
      out.push(check('cuatro Stairville LED PAR56', pares.length === 4, `${pares.length}`))

      const vivos = await client.fixtures()
      const enU1 = vivos
        .filter((f) => pares.some((p) => p.name === f.name))
        .sort((a, b) => a.address - b.address)
      const seguidos = enU1.every(
        (f, i) =>
          i === 0 || f.address === (enU1[i - 1]?.address ?? 0) + (enU1[i - 1]?.channels ?? 0),
      )
      out.push(
        check(
          'universo 1 desde la 1, seguidos y sin solapes',
          enU1.length === 4 &&
            enU1[0]?.address === 1 &&
            enU1.every((f) => f.universe === 1) &&
            seguidos,
          enU1.map((f) => `${f.name}@${f.address}+${f.channels}`).join(' '),
        ),
      )

      const g = despues.stage
      out.push(check('escenario de 10 × 6 m', g?.width === 10 && g?.depth === 6, JSON.stringify(g)))
      const xs = pares.map((p) => p.stage?.x ?? -1)
      const zs = pares.map((p) => p.stage?.z ?? -1)
      out.push(
        check(
          'colgados a unos 5 m',
          zs.every((z) => z >= 4000 && z <= 6000),
          zs.join(', '),
        ),
      )
      out.push(
        check(
          'repartidos a lo ancho',
          new Set(xs).size === 4 &&
            Math.min(...xs) >= 0 &&
            Math.min(...xs) < 3500 &&
            Math.max(...xs) > 6500 &&
            Math.max(...xs) <= 10000,
          xs.join(', '),
        ),
      )

      const escenas = (despues.functions ?? []).filter((f) => f.type === 'Scene')
      const llamada = (re: RegExp) => escenas.find((f) => re.test(f.name))
      const azul = llamada(/azul|blue/i)
      const roja = llamada(/roj|red/i)
      const ambar = llamada(/[áa]mbar|amber/i)
      out.push(
        check(
          'escenas azul, roja y ámbar',
          !!azul && !!roja && !!ambar,
          escenas.map((f) => f.name).join(', '),
        ),
      )

      if (azul) {
        const activos = (await luz(client, azul.name)) ?? []
        const porFoco = (re: RegExp) =>
          new Set(
            activos
              .filter((a) => re.test(a.channelName ?? '') && a.value > 0)
              .map((a) => a.fixtureName),
          )
        const azules = porFoco(/blue|azul/i)
        const rojos = porFoco(/red|rojo/i)
        out.push(
          check(
            'la escena azul da azul en los cuatro, sin rojo',
            azules.size === 4 && rojos.size === 0,
            activos.map((a) => `${a.fixtureName}·${a.channelName}=${a.value}`).join(' '),
          ),
        )
      }

      const chasers = (despues.functions ?? []).filter((f) => f.type === 'Chaser')
      const chaser = chasers.find((c) => (c.steps ?? []).length >= 3)
      const nombresEscenas = new Set([azul?.name, roja?.name, ambar?.name])
      out.push(
        check(
          'un chaser de tres pasos por las escenas',
          !!chaser && (chaser.steps ?? []).every((s) => nombresEscenas.has(s.function)),
          JSON.stringify(chaser?.steps),
        ),
      )
      const pasoDe = (s: NonNullable<FunctionSpec['steps']>[number]) =>
        (s.fadeIn ?? 0) + (s.hold ?? s.duration ?? 0)
      out.push(
        check(
          'cada paso, unos dos segundos',
          !!chaser &&
            ((chaser.steps ?? []).every((s) => pasoDe(s) >= 1500 && pasoDe(s) <= 3000) ||
              ((chaser.duration ?? 0) >= 1500 && (chaser.duration ?? 0) <= 3000)),
          JSON.stringify({ steps: chaser?.steps, duration: chaser?.duration }),
        ),
      )

      const botones = widgets(despues.console?.widgets).filter((x) => x.w.type === 'button')
      const conFuncion = botones.filter((x) => x.w.functionId)
      const lanzan = new Set(conFuncion.map((x) => x.w.functionId))
      out.push(
        check(
          'una botonera que lanza las tres escenas y el chaser',
          [azul?.name, roja?.name, ambar?.name, chaser?.name].every((n) => n && lanzan.has(n)),
          conFuncion.map((x) => `${x.w.caption}→${x.w.functionId}`).join(', '),
        ),
      )
      const colores = new Set(conFuncion.map((x) => x.w.background).filter(Boolean))
      out.push(
        check(
          'los botones llevan color, y no todos el mismo',
          colores.size >= 3,
          [...colores].join(' '),
        ),
      )
      const botonAzul = conFuncion.find((x) => x.w.functionId === azul?.name)
      const c = hex(botonAzul?.w.background)
      out.push(
        check(
          'el botón azul es azul',
          !!c && c.b > c.r && c.b > c.g,
          botonAzul?.w.background ?? 'sin color',
        ),
      )

      const proyecto = await client.project()
      out.push(check('no ha guardado', proyecto.modified, `modificado: ${proyecto.modified}`))
      return out
    },
  },

  /* The wedding, touched: one palette added the way the others were built,
     and nothing else moved. */
  'boda-verde': {
    encargo:
      'En la consola, en el marco COLOR de las paletas, añade un color nuevo VERDE BOSQUE que funcione ' +
      'como los demás: que pise el color de los washes del look que esté corriendo.',
    siPregunta: 'Hazlo como las paletas que ya hay.',
    comprobar: async ({ client, antes, despues }) => {
      const out: Comprobacion[] = []
      const nuevas = (despues.functions ?? []).filter(
        (f) => !(antes.functions ?? []).some((a) => a.name === f.name),
      )
      const paleta = nuevas.find((f) => f.type === 'Scene' && /verde/i.test(f.name))
      out.push(
        check(
          'una escena nueva de verde',
          !!paleta,
          nuevas.map((f) => f.name).join(', ') || 'ninguna',
        ),
      )

      const azul = (antes.functions ?? []).find((f) => f.name === 'Paleta AZUL')
      const canales = (f?: FunctionSpec) =>
        new Set((f?.values ?? []).map((v) => `${v.fixture}·${v.channel}`))
      const esperados = canales(azul)
      const tiene = canales(paleta)
      out.push(
        check(
          'toca los mismos canales que las otras paletas, ni uno más',
          esperados.size > 0 &&
            [...esperados].every((k) => tiene.has(k)) &&
            [...tiene].every((k) => esperados.has(k)),
          `paleta: ${[...tiene].join(', ')} | AZUL: ${[...esperados].join(', ')}`,
        ),
      )
      const verdes = (paleta?.values ?? []).filter((v) => /green/i.test(String(v.channel)))
      const rojos = (paleta?.values ?? []).filter((v) => /^red$/i.test(String(v.channel)))
      out.push(
        check(
          'y es verde: más verde que rojo',
          verdes.length > 0 &&
            verdes.reduce((n, v) => n + v.value, 0) > rojos.reduce((n, v) => n + v.value, 0),
          JSON.stringify(paleta?.values),
        ),
      )

      const todosAntes = widgets(antes.console?.widgets)
      const todosDespues = widgets(despues.console?.widgets)
      const boton = todosDespues.find(
        (x) => x.w.type === 'button' && x.w.functionId === paleta?.name,
      )
      out.push(
        check(
          'un botón nuevo dentro del marco COLOR',
          !!boton && boton.ruta.some((r) => /^COLOR/.test(r)),
          boton ? `${boton.ruta.join(' / ')} / ${boton.w.caption}` : 'ninguno',
        ),
      )
      out.push(
        check(
          'en override, como las otras paletas',
          /override/i.test(boton?.w.action ?? ''),
          boton?.w.action,
        ),
      )
      const c = hex(boton?.w.background)
      out.push(
        check('de color verde', !!c && c.g > c.r && c.g >= c.b, boton?.w.background ?? 'sin color'),
      )
      out.push(
        check(
          'un widget más, ni uno menos',
          todosDespues.length === todosAntes.length + 1,
          `${todosAntes.length} → ${todosDespues.length}`,
        ),
      )
      const clave = (x: { ruta: string[]; w: WidgetSpec }) =>
        JSON.stringify([x.ruta, x.w.type, x.w.caption, x.w.functionId, x.w.action, x.w.background])
      const intactos = todosAntes.every((x) => todosDespues.some((y) => clave(y) === clave(x)))
      out.push(check('ningún widget que ya estaba cambia', intactos))
      const funcionesIntactas = (antes.functions ?? []).every((a) =>
        (despues.functions ?? []).some((d) => JSON.stringify(d) === JSON.stringify(a)),
      )
      out.push(check('ninguna función que ya estaba cambia', funcionesIntactas))
      const proyecto = await client.project()
      out.push(check('no ha guardado', proyecto.modified))
      return out
    },
  },
}

/* ---- the run ------------------------------------------------------------------ */

/* Per million tokens: input, output, cache read, cache write (5 min). */
const PRECIOS: [RegExp, number, number, number, number][] = [
  [/^claude-opus-5-5/, 4, 20, 0.2, 5],
  [/^claude-sonnet-5-5/, 2, 10, 0.2, 2.5],
  [/^claude-haiku-5-5/, 0.1, 0.5, 0.01, 0.125],
]

const nombre = process.env.ORCHID_EVAL_SCENARIO ?? ''
const base = process.env.ORCHID_EVAL_URL ?? ''
const salida = process.env.ORCHID_EVAL_OUT ?? '.'

it(`escenario ${nombre}`, async () => {
  const escenario = ESCENARIOS[nombre]
  if (!escenario || !base)
    throw new Error(`escenario desconocido o sin mesa: «${nombre}» en «${base}»`)

  const client = new OrchidClient({ baseUrl: base, timeoutMs: 60_000 })
  const ajustes = await client.get<AiSettings>('/ai/settings')
  const modelo = ajustes.providers.anthropic.model || 'claude-opus-5-5'

  /* The real client, tapped: every final message's usage is kept, cache
     included, so the cost is what was billed and not an estimate. */
  const cliente = anthropicCliente({ origen: base, llave: null })
  const usos: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
  }[] = []
  const original = cliente.beta.messages.stream.bind(cliente.beta.messages)
  cliente.beta.messages.stream = ((params, opciones) => {
    const s = original(params, opciones)
    s.finalMessage().then(
      (m) => usos.push(m.usage),
      () => undefined,
    )
    return s
  }) as typeof cliente.beta.messages.stream

  const dialecto = new DialectoAnthropic(cliente, modelo, HERRAMIENTAS, INSTRUCCIONES)
  const antes = await exportSpec(client, { console: true })
  const pasos: { herramienta: string; resumen: string; error: boolean }[] = []
  const llamadas = new Map<string, string>()
  let palabras = ''
  const avisos: string[] = []
  const contexto: Contexto = { client, signal: new AbortController().signal, cache: {} }
  const correr = (texto: string) =>
    turno({
      dialecto,
      herramientas: HERRAMIENTAS,
      contexto,
      texto,
      adjuntos: [],
      evento: (e) => {
        if (e.tipo === 'texto') palabras += e.delta
        if (e.tipo === 'llamada') llamadas.set(e.id, e.nombre)
        if (e.tipo === 'resultado')
          pasos.push({ herramienta: llamadas.get(e.id) ?? '?', resumen: e.resumen, error: e.error })
        if (e.tipo === 'aviso') avisos.push(e.texto)
      },
    })

  const inicio = Date.now()
  await correr(escenario.encargo)
  let turnos = 1
  if (!pasos.some((p) => p.herramienta === 'aplicar' && !p.error)) {
    palabras += `\n\n--- (preguntó; se le contesta: ${escenario.siPregunta})\n\n`
    await correr(escenario.siPregunta)
    turnos = 2
  }
  const segundos = Math.round((Date.now() - inicio) / 1000)

  const despues = await exportSpec(client, { console: true })
  const comprobaciones = await escenario.comprobar({ client, antes, despues })

  const suma = (f: (u: (typeof usos)[number]) => number) => usos.reduce((n, u) => n + f(u), 0)
  const tokens = {
    entrada: suma((u) => u.input_tokens),
    cacheLeida: suma((u) => u.cache_read_input_tokens ?? 0),
    cacheEscrita: suma((u) => u.cache_creation_input_tokens ?? 0),
    salida: suma((u) => u.output_tokens),
  }
  const precio = PRECIOS.find(([re]) => re.test(modelo))
  const coste = precio
    ? (tokens.entrada * precio[1] +
        tokens.salida * precio[2] +
        tokens.cacheLeida * precio[3] +
        tokens.cacheEscrita * precio[4]) /
      1_000_000
    : null

  const informe = {
    escenario: nombre,
    modelo,
    turnos,
    llamadasAlModelo: usos.length,
    segundos,
    tokens,
    costeDolares: coste === null ? null : Math.round(coste * 1000) / 1000,
    aprobadas: `${comprobaciones.filter((c) => c.ok).length}/${comprobaciones.length}`,
    comprobaciones,
    pasos,
    avisos,
    palabras,
  }
  writeFileSync(join(salida, `${nombre}.json`), JSON.stringify(informe, null, 1))
  writeFileSync(join(salida, `${nombre}.documento.json`), JSON.stringify(despues, null, 1))

  const lineas = [
    `## ${nombre} · ${modelo} · ${informe.aprobadas} · ${segundos} s · ${usos.length} llamadas · ${coste === null ? '?' : `$${coste.toFixed(3)}`}`,
    ...comprobaciones.map(
      (c) => `${c.ok ? 'ok  ' : 'FALLA'} ${c.que}${c.detalle && !c.ok ? ` — ${c.detalle}` : ''}`,
    ),
  ]
  console.log(lineas.join('\n'))

  expect(comprobaciones.filter((c) => !c.ok).map((c) => c.que)).toEqual([])
})
