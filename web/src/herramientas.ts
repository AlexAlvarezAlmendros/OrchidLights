/**
 * What the assistant can do to the desk, and nothing else.
 *
 * Few and task-shaped, like the MCP server's: a model handed the daemon's 150
 * routes spends its context choosing. Each tool is one thing a lighting
 * designer would ask a colleague for -- look at the project, look up a lamp,
 * try a document, apply it, light a cue and read what came out.
 *
 * Writing goes through the declarative document and only through it: the
 * same engine the MCP server and orchidctl use, which validates a document
 * whole before touching anything and applies it as one undo entry.
 *
 * Inputs are checked here before a tool runs. With eager input streaming the
 * API no longer validates them, and its tolerant parser can hand back a
 * silently truncated object: an `aplicar` run on half a document is half a
 * show. A failed check is returned to the model as an error, never executed.
 */

import type { OrchidClient } from '@orchid/mcp/client'
import { type ApplyReport, SpecError, applySpec } from '@orchid/mcp/spec/apply'
import { exportSpec } from '@orchid/mcp/spec/export'
import type { ShowSpec, WidgetSpec } from '@orchid/mcp/spec/types'
import { outline } from './indice'

/** The subset of JSON Schema the tools use, which is also all the validator
 *  understands. */
export interface Esquema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, Esquema>
  required?: string[]
  enum?: string[]
  minimum?: number
  maximum?: number
  items?: Esquema
  additionalProperties?: boolean
}

export interface Contexto {
  client: OrchidClient
  signal: AbortSignal
  /** The export is slow on a big project and the same for a whole turn: kept
   *  until something is applied. */
  cache: { spec?: ShowSpec | undefined }
}

export interface Resultado {
  /** What the model reads back. */
  texto: string
  /** What the person reads: one line. */
  resumen: string
  /** What changed in the desk, when something did. */
  cambios?: ApplyReport
  /** It did not do what was asked -- a refused document, a REST error. Told
   *  to the model as an error and drawn as one, even when the tool caught it
   *  to explain it better than an exception would. */
  error?: boolean
}

export interface Herramienta {
  nombre: string
  descripcion: string
  esquema: Esquema & { type: 'object' }
  /** Changes the project. */
  escribe?: boolean
  /** Lights the room. */
  enciende?: boolean
  ejecutar: (entrada: Record<string, unknown>, contexto: Contexto) => Promise<Resultado>
}

/**
 * The input against its schema: null when it fits, the first problem when it
 * does not. Unknown keys are allowed unless the schema says otherwise -- a
 * model that adds a harmless field should not lose a turn over it.
 */
export function validar(esquema: Esquema, valor: unknown, donde = 'entrada'): string | null {
  switch (esquema.type) {
    case 'object': {
      if (typeof valor !== 'object' || valor === null || Array.isArray(valor))
        return `${donde} tiene que ser un objeto`
      const objeto = valor as Record<string, unknown>
      for (const clave of esquema.required ?? []) {
        if (objeto[clave] === undefined) return `falta ${donde}.${clave}`
      }
      for (const [clave, hijo] of Object.entries(esquema.properties ?? {})) {
        if (objeto[clave] === undefined) continue
        const problema = validar(hijo, objeto[clave], `${donde}.${clave}`)
        if (problema !== null) return problema
      }
      if (esquema.additionalProperties === false) {
        const sobra = Object.keys(objeto).find((clave) => !(clave in (esquema.properties ?? {})))
        if (sobra !== undefined) return `${donde}.${sobra} no se esperaba`
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(valor)) return `${donde} tiene que ser una lista`
      if (esquema.items) {
        for (const [i, item] of valor.entries()) {
          const problema = validar(esquema.items, item, `${donde}[${i}]`)
          if (problema !== null) return problema
        }
      }
      return null
    }
    case 'string':
      if (typeof valor !== 'string') return `${donde} tiene que ser texto`
      if (esquema.enum && !esquema.enum.includes(valor))
        return `${donde} es uno de: ${esquema.enum.join(', ')}`
      return null
    case 'boolean':
      return typeof valor === 'boolean' ? null : `${donde} tiene que ser verdadero o falso`
    case 'number':
    case 'integer': {
      if (typeof valor !== 'number' || Number.isNaN(valor))
        return `${donde} tiene que ser un número`
      if (esquema.type === 'integer' && !Number.isInteger(valor))
        return `${donde} tiene que ser un entero`
      if (esquema.minimum !== undefined && valor < esquema.minimum)
        return `${donde} no puede ser menor que ${esquema.minimum}`
      if (esquema.maximum !== undefined && valor > esquema.maximum)
        return `${donde} no puede ser mayor que ${esquema.maximum}`
      return null
    }
  }
}

/* ---- helpers ----------------------------------------------------------- */

async function documento(contexto: Contexto): Promise<ShowSpec> {
  if (contexto.cache.spec === undefined) {
    contexto.cache.spec = await exportSpec(contexto.client, { console: true })
  }
  return contexto.cache.spec
}

/** The widgets with this caption, anywhere in the console, with the path of
 *  frames that holds each one -- the path is how a new child gets added. */
function widgetsLlamados(widgets: WidgetSpec[], nombre: string, ruta: string[] = []) {
  const hallados: { ruta: string[]; widget: WidgetSpec }[] = []
  for (const widget of widgets) {
    if (widget.caption === nombre) hallados.push({ ruta, widget })
    hallados.push(
      ...widgetsLlamados(widget.children ?? [], nombre, [...ruta, widget.caption ?? widget.type]),
    )
  }
  return hallados
}

function informe(report: ApplyReport): string {
  if (report.actions.length === 0) return 'Nada que cambiar: la mesa ya está así.'
  const lineas = report.actions.map(
    (a) =>
      `${a.kind === 'create' ? '+' : a.kind === 'update' ? '~' : '-'} ${a.section}: ${a.name}${a.detail ? ` (${a.detail})` : ''}`,
  )
  return lineas.join('\n')
}

/* Singular and plural of what each section holds, for the person. */
const COSAS: Record<string, [string, string]> = {
  fixtures: ['fixture', 'fixtures'],
  functions: ['función', 'funciones'],
  fixtureGroups: ['grupo', 'grupos'],
  console: ['widget', 'widgets'],
  universes: ['universo', 'universos'],
  stage: ['escenario', 'escenario'],
  project: ['proyecto', 'proyecto'],
}

/**
 * "+1 fixture, +1 función, ~2 widgets" for the person: things, not actions.
 * The engine reports a new scene as three actions -- the scene, its timings,
 * its values -- and "+4" for a lamp and a scene reads as twice the work that
 * was done.
 */
export function cuenta(report: ApplyReport): string {
  const por = (kind: string) => {
    const secciones = new Map<string, Set<string>>()
    for (const a of report.actions) {
      if (a.kind !== kind) continue
      const nombres = secciones.get(a.section) ?? new Set()
      nombres.add(a.name)
      secciones.set(a.section, nombres)
    }
    return secciones
  }
  const creados = por('create')
  const cambiados = por('update')
  /* A thing created and then given its values in the same pass was created,
     not also changed. */
  for (const [seccion, nombres] of cambiados) {
    for (const nombre of creados.get(seccion) ?? []) nombres.delete(nombre)
  }
  const partes: string[] = []
  for (const [signo, grupo] of [
    ['+', creados],
    ['~', cambiados],
    ['−', por('delete')],
  ] as const) {
    for (const [seccion, nombres] of grupo) {
      if (nombres.size === 0) continue
      const [uno, varios] = COSAS[seccion] ?? [seccion, seccion]
      partes.push(`${signo}${nombres.size} ${nombres.size === 1 ? uno : varios}`)
    }
  }
  return partes.join(', ')
}

function falla(causa: unknown): Resultado {
  if (causa instanceof SpecError) {
    return {
      error: true,
      texto: `El documento no vale; no se ha tocado nada. Problemas:\n${causa.problems.map((p) => `- ${p}`).join('\n')}`,
      resumen: `${causa.problems.length} problema${causa.problems.length === 1 ? '' : 's'} en el documento`,
    }
  }
  const mensaje = causa instanceof Error ? causa.message : String(causa)
  return { texto: `Error: ${mensaje}`, resumen: mensaje, error: true }
}

/* A frame created in one pass has its children created in the next: the
   engine cannot address a parent whose id it has not handed out yet. The
   document is idempotent, so applying again until nothing is pending is
   safe -- and stopping after a few passes keeps a document that never
   settles from looping. */
const PASADAS = 4

/* ---- the tools --------------------------------------------------------- */

const DOCUMENTO: Esquema = {
  type: 'object',
  description:
    'Un documento declarativo de OrchidLights, parcial: solo lo que quieras crear o cambiar. ' +
    'Lleva "orchidlights": 1.',
  properties: { orchidlights: { type: 'integer', minimum: 1, maximum: 1 } },
  required: ['orchidlights'],
}

export const HERRAMIENTAS: Herramienta[] = [
  {
    nombre: 'ver_proyecto',
    descripcion:
      'El proyecto cargado, resumido: universos y su salida, fixtures con modelo, modo, ' +
      'dirección y sitio en el escenario, grupos, funciones por carpeta (y cuáles corren) y el ' +
      'árbol de la consola. Míralo antes de escribir nada y cuando dudes de cómo está la mesa.',
    esquema: { type: 'object', properties: {} },
    ejecutar: async (_entrada, contexto) => ({
      texto: await outline(contexto.client),
      resumen: 'Ha mirado el proyecto',
    }),
  },
  {
    nombre: 'ver',
    descripcion:
      'Algo del proyecto entero, en forma de documento: una fixture, una función (con todos sus ' +
      'valores o pasos), un grupo, un universo o un widget de la consola, por su nombre exacto. ' +
      'Úsalo antes de cambiar algo que ya existe, para cambiar solo lo necesario.',
    esquema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'El nombre exacto, o el texto del widget.' },
      },
      required: ['nombre'],
    },
    ejecutar: async (entrada, contexto) => {
      const nombre = String(entrada.nombre)
      const spec = await documento(contexto)
      const hallado: Record<string, unknown> = {}
      const fixture = spec.fixtures?.find((f) => f.name === nombre)
      if (fixture) hallado.fixture = fixture
      const funcion = spec.functions?.find((f) => f.name === nombre)
      if (funcion) hallado.function = funcion
      const grupo = spec.fixtureGroups?.find((g) => g.name === nombre)
      if (grupo) hallado.fixtureGroup = grupo
      const universo = spec.universes?.find((u) => u.name === nombre)
      if (universo) hallado.universe = universo
      const widgets = widgetsLlamados(spec.console?.widgets ?? [], nombre)
      if (widgets.length > 0)
        hallado.widgets = widgets.map((w) => ({ dentroDe: w.ruta, ...w.widget }))

      if (Object.keys(hallado).length === 0) {
        const todos = [
          ...(spec.fixtures ?? []).map((f) => f.name),
          ...(spec.functions ?? []).map((f) => f.name),
          ...(spec.fixtureGroups ?? []).map((g) => g.name),
        ]
        const parecidos = todos
          .filter((n) => n.toLowerCase().includes(nombre.toLowerCase()))
          .slice(0, 12)
        return {
          texto: `No hay nada llamado «${nombre}».${parecidos.length ? ` Parecidos: ${parecidos.join(', ')}` : ''}`,
          resumen: `No encontró «${nombre}»`,
        }
      }
      return { texto: JSON.stringify(hallado), resumen: `Ha mirado «${nombre}»` }
    },
  },
  {
    nombre: 'libreria',
    descripcion:
      'Los 1.735 perfiles de fixture. Con `buscar`, los fabricantes que encajan. Con ' +
      '`fabricante`, sus modelos. Con `fabricante` y `modelo`, los modos y sus canales. El ' +
      'fabricante, el modelo y el modo van EXACTOS al patchear, tal y como salen de aquí.',
    esquema: {
      type: 'object',
      properties: {
        buscar: { type: 'string' },
        fabricante: { type: 'string' },
        modelo: { type: 'string' },
      },
    },
    ejecutar: async (entrada, contexto) => {
      const { buscar, fabricante, modelo } = entrada as Record<string, string | undefined>
      const c = contexto.client
      if (fabricante && modelo) {
        const perfil = await c.get(
          `/library/${encodeURIComponent(fabricante)}/${encodeURIComponent(modelo)}`,
        )
        return {
          texto: JSON.stringify(perfil),
          resumen: `Ha leído los modos de ${fabricante} ${modelo}`,
        }
      }
      if (fabricante) {
        const catalogo = await c.get(`/library/${encodeURIComponent(fabricante)}`)
        return {
          texto: JSON.stringify(catalogo),
          resumen: `Ha mirado el catálogo de ${fabricante}`,
        }
      }
      const hallados = await c.get(`/library${buscar ? `?q=${encodeURIComponent(buscar)}` : ''}`)
      return {
        texto: JSON.stringify(hallados),
        resumen: buscar ? `Ha buscado «${buscar}» en la librería` : 'Ha mirado la librería',
      }
    },
  },
  {
    nombre: 'mapa_universo',
    descripcion:
      'Qué direcciones de un universo están ocupadas y por quién, y cuáles libres. Míralo antes ' +
      'de patchear: dos fixtures en la misma dirección no dan error, dan una sala que no obedece.',
    esquema: {
      type: 'object',
      properties: { universo: { type: 'integer', minimum: 1 } },
      required: ['universo'],
    },
    ejecutar: async (entrada, contexto) => {
      const mapa = await contexto.client.get(`/universes/${Number(entrada.universo)}/map`)
      return { texto: JSON.stringify(mapa), resumen: `Ha mirado el universo ${entrada.universo}` }
    },
  },
  {
    nombre: 'entradas_y_salidas',
    descripcion:
      'Los plugins de salida DMX y de entrada de control de esta máquina, con sus líneas y los ' +
      'perfiles de entrada. Los nombres van LITERALES en el documento: "Art-Net" cuando el ' +
      'plugin se llama "ArtNet" da un universo sin salida.',
    esquema: { type: 'object', properties: {} },
    ejecutar: async (_entrada, contexto) => ({
      texto: JSON.stringify(await contexto.client.io()),
      resumen: 'Ha mirado las entradas y salidas',
    }),
  },
  {
    nombre: 'proponer',
    descripcion:
      'Ensaya un documento contra la mesa sin tocar nada: lo valida entero y devuelve el plan ' +
      '(qué se crearía, cambiaría o borraría) o TODOS los problemas de golpe. Úsalo para ' +
      'comprobar un documento antes de aplicarlo.',
    esquema: {
      type: 'object',
      properties: { documento: DOCUMENTO },
      required: ['documento'],
    },
    ejecutar: async (entrada, contexto) => {
      try {
        const report = await applySpec(contexto.client, entrada.documento as unknown as ShowSpec, {
          dryRun: true,
        })
        return {
          texto: `Ensayo correcto. Plan:\n${informe(report)}`,
          resumen: `Ha ensayado ${report.actions.length} cambio${report.actions.length === 1 ? '' : 's'}`,
        }
      } catch (causa) {
        return falla(causa)
      }
    },
  },
  {
    nombre: 'aplicar',
    descripcion:
      'Escribe un documento en la mesa. Se valida entero antes de tocar nada; lo que no menciona ' +
      'no se toca; aplicarlo dos veces no hace nada la segunda; y queda como una entrada de ' +
      'deshacer. No guarda el proyecto: eso es de la persona.',
    esquema: {
      type: 'object',
      properties: { documento: DOCUMENTO },
      required: ['documento'],
    },
    escribe: true,
    ejecutar: async (entrada, contexto) => {
      const spec = entrada.documento as unknown as ShowSpec
      const pasadas: ApplyReport[] = []
      try {
        for (let i = 0; i < PASADAS; i++) {
          const report = await applySpec(contexto.client, spec)
          contexto.cache.spec = undefined
          if (report.actions.length > 0) pasadas.push(report)
          const pendiente = report.actions.some((a) => a.detail?.includes('al volver a aplicar'))
          if (!pendiente) break
        }
      } catch (causa) {
        contexto.cache.spec = undefined
        const fallo = falla(causa)
        return pasadas.length > 0
          ? { ...fallo, texto: `${fallo.texto}\n(Lo de las pasadas anteriores sí quedó aplicado.)` }
          : fallo
      }

      if (pasadas.length === 0) {
        return { texto: 'Nada que cambiar: la mesa ya está así.', resumen: 'Ya estaba así' }
      }
      const total: ApplyReport = {
        dryRun: false,
        actions: pasadas.flatMap((p) => p.actions),
        created: pasadas.reduce((n, p) => n + p.created, 0),
        updated: pasadas.reduce((n, p) => n + p.updated, 0),
        deleted: pasadas.reduce((n, p) => n + p.deleted, 0),
        undoSteps: pasadas.reduce((n, p) => n + p.undoSteps, 0),
        undoOverflowed: pasadas.some((p) => p.undoOverflowed),
      }
      return {
        texto: `Aplicado. ${total.undoSteps} entrada(s) de deshacer.\n${informe(total)}`,
        resumen: `Ha aplicado ${cuenta(total)}`,
        cambios: total,
      }
    },
  },
  {
    nombre: 'probar',
    descripcion:
      'Enciende una función unos segundos y devuelve lo que salió por los universos, después ' +
      'del grand master: la forma de saber si la luz llega de verdad. Si ya estaba corriendo, ' +
      'la deja corriendo.',
    esquema: {
      type: 'object',
      properties: {
        funcion: { type: 'string', description: 'El nombre exacto de la función.' },
        segundos: { type: 'number', minimum: 0.5, maximum: 10 },
      },
      required: ['funcion'],
    },
    enciende: true,
    ejecutar: async (entrada, contexto) => {
      const c = contexto.client
      const nombre = String(entrada.funcion)
      const segundos = typeof entrada.segundos === 'number' ? entrada.segundos : 3
      const [funciones, fixtures] = await Promise.all([c.functions(), c.fixtures()])
      const funcion = funciones.find((f) => f.name === nombre)
      if (!funcion)
        return {
          texto: `No hay ninguna función llamada «${nombre}».`,
          resumen: `No encontró «${nombre}»`,
        }

      const yaCorria = funcion.running === true
      if (!yaCorria) await c.post(`/functions/${funcion.id}/start`)
      try {
        await new Promise<void>((resolve, reject) => {
          const reloj = setTimeout(resolve, segundos * 1000)
          contexto.signal.addEventListener('abort', () => {
            clearTimeout(reloj)
            reject(new DOMException('Cancelado', 'AbortError'))
          })
        })
        const universos = [...new Set(fixtures.map((f) => f.universe))]
        const lecturas = await Promise.all(universos.map((u) => c.dmx(u)))
        const activos = lecturas.flatMap((l) =>
          l.active.map(
            (a) =>
              `U${l.universe} ${a.channel} = ${a.value}${a.fixtureName ? ` · ${a.fixtureName} · ${a.channelName ?? ''}` : ''}`,
          ),
        )
        const blackout = lecturas.some((l) => l.blackout)
        return {
          texto:
            (blackout ? 'OJO: la mesa está en blackout.\n' : '') +
            (activos.length > 0
              ? `Salía, con «${nombre}» encendida:\n${activos.slice(0, 80).join('\n')}`
              : `Con «${nombre}» encendida no salía nada: todos los canales a 0.`),
          resumen: `Ha encendido «${nombre}» ${segundos} s`,
        }
      } finally {
        if (!yaCorria) await c.post(`/functions/${funcion.id}/stop`).catch(() => undefined)
      }
    },
  },
  {
    nombre: 'leer_dmx',
    descripcion:
      'Lo que sale ahora mismo por un universo, después del grand master: cada canal activo con ' +
      'su fixture y su nombre.',
    esquema: {
      type: 'object',
      properties: { universo: { type: 'integer', minimum: 1 } },
      required: ['universo'],
    },
    ejecutar: async (entrada, contexto) => {
      const lectura = await contexto.client.dmx(Number(entrada.universo))
      return {
        texto: JSON.stringify({ blackout: lectura.blackout, active: lectura.active }),
        resumen: `Ha leído el universo ${entrada.universo}`,
      }
    },
  },
]

/** Run one tool call: validated first, and its failures returned as text --
 *  the model reads an error and tries again, a thrown exception ends the turn. */
export async function ejecutar(
  herramientas: Herramienta[],
  nombre: string,
  entrada: unknown,
  contexto: Contexto,
): Promise<Resultado & { error: boolean }> {
  const herramienta = herramientas.find((h) => h.nombre === nombre)
  if (!herramienta) {
    return {
      texto: `No existe la herramienta «${nombre}».`,
      resumen: `Herramienta desconocida: ${nombre}`,
      error: true,
    }
  }
  const problema = validar(herramienta.esquema, entrada)
  if (problema !== null) {
    return {
      texto: `Entrada no válida (${problema}); no se ha ejecutado. Entrada recibida: ${JSON.stringify(entrada).slice(0, 2000)}`,
      resumen: `Entrada no válida: ${problema}`,
      error: true,
    }
  }
  try {
    const r = await herramienta.ejecutar(entrada as Record<string, unknown>, contexto)
    return { ...r, error: r.error === true }
  } catch (causa) {
    if (contexto.signal.aborted)
      return { texto: 'Cancelado por la persona.', resumen: 'Cancelado', error: true }
    return { ...falla(causa), error: true }
  }
}
