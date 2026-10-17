#!/usr/bin/env node
/**
 * El servidor MCP de OrchidLights.
 *
 * Diecinueve herramientas, no ciento cuarenta y una. El daemon expone una
 * operación por cosa que se puede hacer, que es lo correcto para un API y lo
 * peor posible para un agente: con ciento cuarenta y una herramientas delante,
 * el contexto se gasta en elegir. Aquí hay una por *tarea* —describir el
 * proyecto, aplicarlo, buscar una lámpara, mirar el universo de vuelta— y una
 * sola salida de emergencia, `orchid_request`, para lo que no entre en ninguna.
 *
 * La salida de emergencia no es pereza: el contrato entero viaja como recurso,
 * así que un agente que necesite la operación ciento cuarenta la encuentra y la
 * llama sin que nadie tenga que envolverla antes.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { OrchidClient, OrchidError } from './client.js'
import { deskOptions } from './config.js'
import { SpecError, applySpec } from './spec/apply.js'
import { exportSpec } from './spec/export.js'
import type { ShowSpec } from './spec/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const client = new OrchidClient(deskOptions())

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (body: string): Content => ({ content: [{ type: 'text', text: body }] })
const yaml = (body: unknown): Content => text(stringifyYaml(body))

/**
 * Un fallo contado como se le contaría a una persona.
 *
 * Un agente que recibe "500 Internal Server Error" reintenta lo mismo; uno que
 * recibe «"Martin MAC500" no tiene el modo "Mode 1". Tiene: Mode 1 8bit, Mode 2
 * 16bit» corrige y sigue. El daemon ya escribe sus errores así; lo único que
 * hay que hacer es no perderlos por el camino.
 */
function failed(error: unknown): Content {
  if (error instanceof SpecError) {
    return {
      content: [
        {
          type: 'text',
          text: `El documento no se puede aplicar:\n${error.problems.map((p) => `  · ${p}`).join('\n')}`,
        },
      ],
      isError: true,
    }
  }
  if (error instanceof OrchidError) {
    const hint =
      error.status === 0 ? '\n¿Está el daemon arrancado? `orchidlightsd tonight.qxw`' : ''
    return { content: [{ type: 'text', text: error.message + hint }], isError: true }
  }
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  }
}

async function guard(work: () => Promise<Content>): Promise<Content> {
  try {
    return await work()
  } catch (error) {
    return failed(error)
  }
}

/** Una función por nombre, diciendo qué hay cuando no está la que se pide. */
async function findFunction(name: string) {
  const functions = await client.functions()
  const exact = functions.find((fn) => fn.name === name)
  if (exact) return exact

  const near = functions.filter((fn) => fn.name.toLowerCase().includes(name.toLowerCase()))
  if (near.length === 1) return near[0] as (typeof functions)[number]
  if (near.length > 1) {
    throw new Error(`"${name}" encaja con ${near.length}: ${near.map((fn) => fn.name).join(', ')}`)
  }
  throw new Error(
    `No hay ninguna función llamada "${name}". Hay ${functions.length}; usa orchid_functions para verlas.`,
  )
}

const server = new McpServer({ name: 'orchidlights', version: '0.1.0' })

/* ---- mirar ------------------------------------------------------------ */

server.registerTool(
  'orchid_status',
  {
    title: 'Estado de la mesa',
    description:
      'Qué mesa es, qué proyecto tiene cargado, cuántas fixtures y funciones hay, ' +
      'cuántas están corriendo y si está en blackout. Lo primero que conviene llamar.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    guard(async () => {
      const [discovery, status, project] = await Promise.all([
        client.discovery(),
        client.status(),
        client.project(),
      ])
      return yaml({
        mesa: `${discovery.name} ${discovery.version}`,
        url: client.baseUrl,
        proyecto: project.name || '(ninguno)',
        sinGuardar: project.modified,
        fixtures: status.fixtures,
        funciones: status.functions,
        universos: status.universes,
        corriendo: status.runningFunctions,
        blackout: status.blackout,
        acceso: discovery.access,
      })
    }),
)

server.registerTool(
  'orchid_export',
  {
    title: 'El proyecto como documento',
    description:
      'Devuelve el proyecto entero como un documento declarativo en YAML, direccionado ' +
      'por nombre: universos con su patch de entrada y salida, fixtures con su dirección ' +
      'y su sitio en el escenario, grupos, funciones y, si se pide, la consola. Es lo que ' +
      'hay que leer antes de cambiar nada, y lo que se edita para cambiarlo todo de una vez ' +
      'con orchid_apply.',
    inputSchema: {
      console: z
        .boolean()
        .optional()
        .describe('Incluir la Virtual Console. Es la parte más larga del documento.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ console: withConsole }) =>
    guard(async () => yaml(await exportSpec(client, { console: withConsole === true }))),
)

server.registerTool(
  'orchid_functions',
  {
    title: 'Las funciones del proyecto',
    description:
      'Escenas, chasers, EFX, matrices, colecciones, shows — con su tipo, sus tiempos y ' +
      'si están corriendo. Filtra por nombre o por tipo cuando el proyecto es grande.',
    inputSchema: {
      search: z.string().optional().describe('Parte del nombre.'),
      type: z.string().optional().describe('Scene, Chaser, EFX, RGBMatrix, Collection, Show…'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search, type }) =>
    guard(async () => {
      let functions = await client.functions()
      if (type) functions = functions.filter((fn) => fn.type.toLowerCase() === type.toLowerCase())
      if (search) {
        const needle = search.toLowerCase()
        functions = functions.filter((fn) => fn.name.toLowerCase().includes(needle))
      }
      if (functions.length === 0) return text('Ninguna función encaja con eso.')
      return yaml(
        functions.map((fn) => ({
          nombre: fn.name,
          tipo: fn.type,
          corriendo: fn.running === true ? true : undefined,
          fadeIn: fn.fadeIn,
          fadeOut: fn.fadeOut,
        })),
      )
    }),
)

server.registerTool(
  'orchid_library',
  {
    title: 'La librería de fixtures',
    description:
      'Los 1.735 perfiles que trae el proyecto. Sin argumentos o con `search`, los ' +
      'fabricantes que encajan. Con `manufacturer`, sus modelos. Con los dos, los modos del ' +
      'perfil y cuántos canales ocupa cada uno — que es lo que hay que leer antes de ' +
      'patchear, porque el nombre del modelo y el del modo van exactos.',
    inputSchema: {
      search: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ search, manufacturer, model }) =>
    guard(async () => {
      if (manufacturer && model) {
        return yaml(
          await client.get(
            `/library/${encodeURIComponent(manufacturer)}/${encodeURIComponent(model)}`,
          ),
        )
      }
      if (manufacturer) {
        return yaml(await client.get(`/library/${encodeURIComponent(manufacturer)}`))
      }
      return yaml(await client.get(`/library${search ? `?q=${encodeURIComponent(search)}` : ''}`))
    }),
)

server.registerTool(
  'orchid_io',
  {
    title: 'Entradas y salidas de esta máquina',
    description:
      'Qué plugins hay para sacar DMX (ArtNet, E1.31, DMX USB, MIDI, OSC) y para meter ' +
      'control, con sus líneas concretas y los perfiles de entrada instalados. Los nombres ' +
      'salen de aquí LITERALES: patchear a "Art-Net" cuando el plugin se llama "ArtNet" no ' +
      'da error, da un universo sin salida, y eso no se ve hasta que no se enciende nada.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => guard(async () => yaml(await client.io())),
)

server.registerTool(
  'orchid_universe_map',
  {
    title: 'Qué ocupa un universo',
    description:
      'Los canales de un universo y quién los tiene, con cuántos quedan libres. Lo que hay ' +
      'que mirar antes de patchear: dos fixtures en la misma dirección es un fallo que no se ' +
      've hasta que se enciende la sala.',
    inputSchema: { universe: z.number().int().min(1).default(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ universe }) => guard(async () => yaml(await client.get(`/universes/${universe}/map`))),
)

server.registerTool(
  'orchid_dmx',
  {
    title: 'Qué sale ahora mismo por el universo',
    description:
      'El bucle de verificación: los canales que no están a cero, con el nombre de su ' +
      'fixture y de su canal. Son los valores después del grand master, o sea lo que ' +
      'reciben las lámparas. Llámalo después de arrancar algo para saber si de verdad ' +
      'llegó a alguna luz — configurar un rig sin mirar nunca la salida es configurarlo ' +
      'a ciegas.',
    inputSchema: { universe: z.number().int().min(1).default(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ universe }) =>
    guard(async () => {
      const snapshot = await client.dmx(universe)
      if (snapshot.active.length === 0) {
        return text(
          `El universo ${universe} está a oscuras${snapshot.blackout ? ' (BLACKOUT activo)' : ''}.`,
        )
      }
      return yaml({
        universo: universe,
        blackout: snapshot.blackout || undefined,
        activos: snapshot.active.map((entry) => ({
          canal: entry.channel + 1,
          valor: entry.value,
          fixture: entry.fixtureName,
          nombre: entry.channelName,
        })),
      })
    }),
)

server.registerTool(
  'orchid_console',
  {
    title: 'La Virtual Console',
    description:
      'El árbol de widgets: marcos, botones, faders, XY pads, cue lists, con a qué función ' +
      'apunta cada uno y su id. Los ids son lo que necesitan orchid_press y orchid_level.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    guard(async () => {
      const root = await client.get<Record<string, unknown>>('/vc')
      const lines: string[] = []
      const walk = (widget: Record<string, unknown>, depth: number) => {
        if (depth > 0) {
          const bits = [`${'  '.repeat(depth - 1)}${widget.type as string}`]
          if (widget.id !== undefined) bits.push(`#${widget.id}`)
          if (widget.caption) bits.push(`"${widget.caption as string}"`)
          if (widget.functionId !== undefined) bits.push(`→ función ${widget.functionId}`)
          if (widget.chaserId !== undefined) bits.push(`→ chaser ${widget.chaserId}`)
          if (widget.sliderMode) bits.push(`(${widget.sliderMode as string})`)
          lines.push(bits.join(' '))
        }
        for (const child of (widget.children as Record<string, unknown>[] | undefined) ?? []) {
          walk(child, depth + 1)
        }
      }
      walk(root, 0)
      return text(lines.length > 0 ? lines.join('\n') : 'La consola está vacía.')
    }),
)

/* ---- cambiar ---------------------------------------------------------- */

server.registerTool(
  'orchid_apply',
  {
    title: 'Aplicar un documento al proyecto',
    description:
      'Lleva el proyecto a lo que dice un documento como el que devuelve orchid_export. ' +
      'Se valida entero antes de tocar nada, es idempotente (aplicarlo dos veces no hace ' +
      'nada la segunda) y NO borra lo que el documento no menciona salvo que se pida ' +
      '`prune`. Llámalo primero con `dryRun` para ver el plan: un plan que no se puede ' +
      'ensayar se aprende rompiendo. Nada llega al disco hasta orchid_save.',
    inputSchema: {
      spec: z
        .string()
        .describe('El documento, en YAML o en JSON. La misma forma que devuelve orchid_export.'),
      dryRun: z.boolean().optional().describe('Calcular el plan y no aplicarlo.'),
      prune: z.boolean().optional().describe('Borrar lo que el documento no menciona.'),
      save: z.boolean().optional().describe('Guardar al disco al terminar.'),
    },
  },
  async ({ spec, dryRun, prune, save }) =>
    guard(async () => {
      const { parse } = await import('yaml')
      const document = parse(spec) as ShowSpec

      const report = await applySpec(client, document, {
        dryRun: dryRun === true,
        prune: prune === true,
        save: save === true,
      })

      if (report.actions.length === 0) {
        return text('Nada que hacer: el proyecto ya dice lo que dice el documento.')
      }

      const lines = report.actions.map((action) => {
        const mark = action.kind === 'create' ? '+' : action.kind === 'delete' ? '-' : '~'
        return `${mark} ${action.section} · ${action.name}${action.detail ? ` — ${action.detail}` : ''}`
      })

      const tail = [
        '',
        `${dryRun ? 'Haría' : 'Hechas'}: +${report.created} ~${report.updated} -${report.deleted}`,
      ]
      if (report.savedTo) tail.push(`Guardado en ${report.savedTo}`)
      else if (!dryRun) tail.push('En memoria — llama a orchid_save para escribirlo al disco.')

      if (!dryRun && report.undoOverflowed) {
        tail.push(
          'El lote no cabe en el anillo de undo (200 entradas): no se puede deshacer entero. ' +
            'Vuelve al último proyecto guardado si hace falta.',
        )
      } else if (!dryRun && report.undoSteps === 1) {
        tail.push('Para deshacerlo entero: orchid_undo, una vez.')
      } else if (!dryRun && report.undoSteps > 1) {
        tail.push(`Para deshacerlo: orchid_undo con times=${report.undoSteps}.`)
      }

      return text([...lines, ...tail].join('\n'))
    }),
)

server.registerTool(
  'orchid_run',
  {
    title: 'Arrancar una función',
    description:
      'Por nombre. Respeta los marcos solo. Comprueba después con orchid_dmx que de verdad ' +
      'llegó a alguna lámpara.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) =>
    guard(async () => {
      const fn = await findFunction(name)
      await client.post(`/functions/${fn.id}/start`)
      return text(`Arrancando "${fn.name}" (${fn.type}).`)
    }),
)

server.registerTool(
  'orchid_stop',
  {
    title: 'Parar una función, o todas',
    description: 'Sin nombre, para todo lo que esté corriendo.',
    inputSchema: {
      name: z.string().optional(),
      fadeMs: z.number().int().min(0).optional().describe('Con qué fundido parar todo.'),
    },
  },
  async ({ name, fadeMs }) =>
    guard(async () => {
      if (name === undefined) {
        const body = fadeMs === undefined ? undefined : { fadeMs }
        const stopped = await client.post<{ stopping: number }>('/stop', body)
        return text(`Paradas ${stopped.stopping} funciones.`)
      }
      const fn = await findFunction(name)
      await client.post(`/functions/${fn.id}/stop`)
      return text(`Parando "${fn.name}".`)
    }),
)

server.registerTool(
  'orchid_press',
  {
    title: 'Pulsar un widget de la consola',
    description:
      'Hace lo mismo que un clic, con la semántica del widget: un botón en flash se ' +
      'enciende mientras se sujeta (manda `on: false` para soltarlo), uno en override deja su ' +
      'escena pisando el color de lo que corre hasta la siguiente pulsación, uno en un marco ' +
      'solo mata a sus hermanos, y Blackout y Stop All no son funciones. Arrancar la función ' +
      'a mano con orchid_run es otra cosa: no sabe nada de eso. Los ids salen de orchid_console.',
    inputSchema: {
      id: z.number().int().min(0),
      on: z.boolean().optional().describe('El flanco. Ausente es una pulsación.'),
    },
  },
  async ({ id, on }) =>
    guard(async () => {
      const body = on === undefined ? {} : { on }
      const result = await client.post<{ state: number }>(`/vc/widgets/${id}/press`, body)
      const state = result.state === 1 ? 'encendido' : result.state === 0 ? 'apagado' : 'sin efecto'
      return text(`Widget ${id}: ${state}.`)
    }),
)

server.registerTool(
  'orchid_level',
  {
    title: 'Mover un fader de la consola',
    description: 'De 0 a 255. Los ids salen de orchid_console.',
    inputSchema: { id: z.number().int().min(0), value: z.number().int().min(0).max(255) },
  },
  async ({ id, value }) =>
    guard(async () => {
      await client.put(`/vc/widgets/${id}/level`, { value })
      return text(`Fader ${id} a ${value}.`)
    }),
)

server.registerTool(
  'orchid_live',
  {
    title: 'Clavar valores en canales, en vivo',
    description:
      'Valores absolutos sobre canales sueltos, direccionados por fixture y por el índice ' +
      'del canal DENTRO de ella. NO es una edición: no toca el documento y no sobrevive a ' +
      'una recarga. Es como se monta un look para después volcarlo a escena con ' +
      'orchid_dump. Sin `values`, suelta la mesa y baja los canales a cero.',
    inputSchema: {
      values: z
        .array(
          z.object({
            fixture: z.number().int().min(0),
            channel: z.number().int().min(0),
            value: z.number().int().min(0).max(255),
          }),
        )
        .optional(),
    },
  },
  async ({ values }) =>
    guard(async () => {
      if (values === undefined || values.length === 0) {
        await client.delete('/live')
        return text('Mesa en vivo suelta; los canales vuelven a cero.')
      }
      const held = await client.put<{ held: number }>('/live', { values })
      return text(`${held.held} canales sujetos.`)
    }),
)

server.registerTool(
  'orchid_dump',
  {
    title: 'Volcar lo que hay puesto a una escena',
    description:
      'Coge lo que el rig está haciendo ahora mismo y lo guarda como escena. Es como se ' +
      'construye una escena de verdad: se monta el look y se guarda. Sin `name`, dice qué ' +
      'se llevaría sin llevárselo.',
    inputSchema: {
      name: z.string().optional().describe('Cómo se llamará la escena. Sin esto, solo mira.'),
      nonZeroOnly: z.boolean().optional().describe('Dejar fuera los canales a cero.'),
      groups: z
        .array(z.string())
        .optional()
        .describe('Qué grupos de canal entran: Intensity, Colour, Pan, Tilt… Vacío es todos.'),
    },
  },
  async ({ name, nonZeroOnly, groups }) =>
    guard(async () => {
      if (name === undefined) return yaml(await client.get('/dump'))
      const body: Record<string, unknown> = { name }
      if (nonZeroOnly !== undefined) body.nonZeroOnly = nonZeroOnly
      if (groups !== undefined) body.groups = groups
      const made = await client.post<{ scene: number; written: number }>('/dump', body)
      return text(`Escena "${name}" creada con ${made.written} canales.`)
    }),
)

server.registerTool(
  'orchid_blackout',
  {
    title: 'Blackout',
    description: 'A oscuras, y de vuelta. No es una edición y no se deshace con orchid_undo.',
    inputSchema: { on: z.boolean().default(true) },
  },
  async ({ on }) =>
    guard(async () => {
      const result = on
        ? await client.post<{ blackout: boolean }>('/blackout')
        : await client.delete<{ blackout: boolean }>('/blackout')
      return text(result.blackout ? 'A oscuras.' : 'Vuelve la luz.')
    }),
)

server.registerTool(
  'orchid_save',
  {
    title: 'Guardar el proyecto',
    description:
      'Escribe el .qxw al disco. Toda edición vive en memoria hasta aquí: un show construido ' +
      'y no guardado no ha sobrevivido a nada.',
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      const saved = await client.save()
      return text(`Guardado en ${saved.path}.`)
    }),
)

server.registerTool(
  'orchid_undo',
  {
    title: 'Deshacer',
    description:
      'Deshace la última edición. El anillo guarda 200, y un orchid_apply entero cuenta como ' +
      'una sola. Cubre el documento, no el estado de ejecución: esto no va a parar un chaser.',
    inputSchema: { times: z.number().int().min(1).max(50).default(1) },
  },
  async ({ times }) =>
    guard(async () => {
      const undone: string[] = []
      for (let index = 0; index < times; index++) {
        try {
          const result = await client.post<{ undone: string }>('/undo')
          undone.push(result.undone)
        } catch {
          break // no queda nada que deshacer, y eso no es un fallo
        }
      }
      if (undone.length === 0) return text('No había nada que deshacer.')
      return text(`Deshechas ${undone.length}:\n${undone.map((l) => `  · ${l}`).join('\n')}`)
    }),
)

/* ---- la salida de emergencia ------------------------------------------ */

server.registerTool(
  'orchid_request',
  {
    title: 'Cualquier otra operación del API',
    description:
      'Las herramientas de arriba cubren lo que se hace a diario, pero el daemon expone 141 ' +
      'operaciones: editar el cuerpo de una escena canal a canal, mover la timeline de un ' +
      'show, crear perfiles de entrada, colocar fixtures en el escenario 3D. Lee el recurso ' +
      '`orchid://routes` para ver todas, o `orchid://contract` para la forma exacta de una, ' +
      'y llámala aquí. Las rutas van sin el prefijo /api/v1.',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().describe('Por ejemplo /functions/12/values o /plan/fixtures/4'),
      body: z.record(z.unknown()).optional(),
    },
  },
  async ({ method, path, body }) =>
    guard(async () => {
      const answer = await client.request(method, path.startsWith('/') ? path : `/${path}`, body)
      return answer === null ? text('Hecho.') : yaml(answer)
    }),
)

/* ---- recursos --------------------------------------------------------- */

server.registerResource(
  'guide',
  'orchid://guide',
  {
    title: 'Cómo manejar una mesa OrchidLights',
    description:
      'Las reglas que no se ven, el camino dorado para montar un show de cero y cómo ' +
      'comprobar el trabajo. Léelo antes de construir nada.',
    mimeType: 'text/markdown',
  },
  async (uri) => {
    // Instalado va junto al paquete; en el árbol de fuentes, dos arriba.
    for (const candidate of [join(HERE, 'AGENTS.md'), join(HERE, '..', '..', 'AGENTS.md')]) {
      try {
        return { contents: [{ uri: uri.href, text: readFileSync(candidate, 'utf8') }] }
      } catch {
        // el siguiente
      }
    }
    return {
      contents: [
        {
          uri: uri.href,
          text: 'La guía no viaja con esta instalación. Está en AGENTS.md del repositorio.',
        },
      ],
    }
  },
)

server.registerResource(
  'routes',
  'orchid://routes',
  {
    title: 'Las 141 operaciones, en una línea cada una',
    description:
      'El índice para orchid_request: método, ruta y qué hace. Mucho más corto que el ' +
      'contrato entero, y suficiente para encontrar la operación que hace falta.',
    mimeType: 'text/plain',
  },
  async (uri) => {
    const contract = await client.get<{
      paths: Record<string, Record<string, { summary?: string; tags?: string[] }>>
    }>('/openapi.json')

    const byTag = new Map<string, string[]>()
    for (const [path, operations] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
        const tag = operation.tags?.[0] ?? 'otras'
        const short = path.replace('/api/v1', '') || '/'
        const line = `  ${method.toUpperCase().padEnd(6)} ${short.padEnd(42)} ${operation.summary ?? ''}`
        byTag.set(tag, [...(byTag.get(tag) ?? []), line])
      }
    }

    const body = [...byTag.entries()]
      .map(([tag, lines]) => `${tag}\n${lines.sort().join('\n')}`)
      .join('\n\n')

    return { contents: [{ uri: uri.href, text: body }] }
  },
)

server.registerResource(
  'contract',
  'orchid://contract',
  {
    title: 'El contrato OpenAPI completo',
    description:
      'La forma exacta de cada petición y cada respuesta, servida por la propia mesa. ' +
      'Son 170 KB: busca la operación en orchid://routes antes de traerte esto.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify(await client.get('/openapi.json')),
        mimeType: 'application/json',
      },
    ],
  }),
)

server.registerResource(
  'project',
  'orchid://project',
  {
    title: 'El proyecto cargado, como documento',
    description: 'Lo mismo que orchid_export, para tenerlo delante sin gastar una llamada.',
    mimeType: 'text/yaml',
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: stringifyYaml(await exportSpec(client, {})) }],
  }),
)

await server.connect(new StdioServerTransport())
