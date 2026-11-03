/**
 * El proyecto cargado, como documento declarativo.
 *
 * Todo se traduce a nombres al salir: las fixtures que nombra una escena, las
 * funciones que encadena un chaser, el grupo sobre el que corre una matriz, la
 * función que dispara un botón. Un documento que saliera con ids sería un
 * documento que solo se puede aplicar sobre el proyecto del que salió.
 *
 * Lo que no se exporta se dice aquí y no en un comentario perdido: los cuerpos
 * de Show quedan fuera de esta versión del formato, porque una timeline es
 * posiciones absolutas que no se pueden reconciliar por nombre sin inventarse
 * una identidad para cada barra. Un Show se exporta como función, con sus
 * tiempos, y sus pistas se quedan donde están.
 */

import type { FunctionSummary, OrchidClient } from '../client.js'
import { ChannelNames } from './channels.js'
import {
  type ConsoleSpec,
  type FixtureGroupSpec,
  type FixtureSpec,
  type FunctionSpec,
  type PatchSpec,
  SPEC_VERSION,
  type ShowSpec,
  type UniverseSpec,
  type WidgetSpec,
} from './types.js'

/**
 * Quita las claves sin valor: un documento lleno de nulls no se lee.
 *
 * El tipo de vuelta las quita también, no solo el objeto. Con
 * `exactOptionalPropertyTypes` un `{ x: number | undefined }` no encaja en un
 * `{ x?: number }`, y decir que sí encaja con un `as` sería apagar justo la
 * comprobación que hace falta cuando el documento se escribe a mano.
 */
type Compacted<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

function compact<T extends object>(object: T): Compacted<T> {
  for (const key of Object.keys(object) as (keyof T)[]) {
    if (object[key] === undefined) delete object[key]
  }
  return object as Compacted<T>
}

/**
 * Asignar solo si hay algo que asignar.
 *
 * Con `exactOptionalPropertyTypes` escribir `undefined` en una propiedad
 * opcional no es lo mismo que no escribirla, y tiene razón: `{caption: undefined}`
 * serializado son dos caracteres que dicen que alguien decidió no poner nada,
 * cuando lo que pasó es que no había nada.
 */
function set<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) target[key] = value
}

function patch(
  endpoint: { plugin?: string; line?: string; output?: string; profile?: string } | undefined,
): PatchSpec | undefined {
  if (!endpoint?.plugin) return undefined
  return compact({
    plugin: endpoint.plugin,
    // La salida lo llama "output" y la entrada "line"; en el documento es una
    // sola cosa, porque desde fuera lo es.
    line: endpoint.line ?? endpoint.output,
    profile: endpoint.profile || undefined,
  }) as PatchSpec
}

export interface ExportOptions {
  /** Incluir la Virtual Console. Cara de leer y no siempre interesa. */
  console?: boolean
}

export async function exportSpec(
  client: OrchidClient,
  options: ExportOptions = {},
): Promise<ShowSpec> {
  const [project, fixtures, functions, universes, plan, groups] = await Promise.all([
    client.project(),
    client.fixtures(),
    client.functions(),
    client.universes(),
    client.plan(),
    client.fixtureGroups(),
  ])

  const fixtureName = new Map(fixtures.map((f) => [f.id, f.name]))
  const functionName = new Map(functions.map((f) => [f.id, f.name]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const placement = new Map(plan.fixtures.map((f) => [f.id, f]))

  const spec: ShowSpec = { orchidlights: SPEC_VERSION }

  /* ---- proyecto ------------------------------------------------------- */

  const startup =
    project.startupFunction >= 0 ? (functionName.get(project.startupFunction) ?? null) : null
  spec.project = compact({
    name: project.name || undefined,
    startupFunction: startup,
  })

  /* ---- escenario ------------------------------------------------------ */

  spec.stage = {
    width: plan.grid.width,
    height: plan.grid.height,
    depth: plan.grid.depth,
    units: plan.grid.units === 'feet' ? 'feet' : 'meters',
  }

  /* ---- universos ------------------------------------------------------ */

  spec.universes = universes.map((universe): UniverseSpec => {
    const entry: UniverseSpec = { name: universe.name }
    const output = patch(universe.outputs?.[0])
    const input = patch(universe.input)
    const feedback = patch(universe.feedback)
    if (output) entry.output = output
    if (input) entry.input = input
    if (feedback) entry.feedback = feedback
    if (universe.passthrough) entry.passthrough = true
    return entry
  })

  /* ---- fixtures ------------------------------------------------------- */

  spec.fixtures = fixtures.map((fixture): FixtureSpec => {
    const entry: FixtureSpec = {
      name: fixture.name,
      manufacturer: fixture.manufacturer ?? '',
      model: fixture.model ?? '',
      mode: fixture.mode ?? '',
      universe: fixture.universe,
      address: fixture.address,
    }

    const stage = placement.get(fixture.id)
    // Una fixture sin colocar no se exporta en el origen: se exporta sin sitio,
    // que es lo que es.
    if (stage && (stage.x !== undefined || stage.y !== undefined)) {
      entry.stage = compact({
        x: stage.x,
        y: stage.y,
        z: stage.z,
        rotation: stage.rotation,
        rotationX: stage.rotationX,
        rotationZ: stage.rotationZ,
        gel: stage.gel,
        zoom: stage.zoom,
        hidden: stage.hidden,
        locked: stage.locked,
        invertPan: stage.invertPan,
        invertTilt: stage.invertTilt,
      })
    }

    return entry
  })

  /* ---- grupos --------------------------------------------------------- */

  spec.fixtureGroups = groups.map((group): FixtureGroupSpec => {
    const entry: FixtureGroupSpec = { name: group.name }
    const members = (group.fixtures ?? [])
      .map((id) => fixtureName.get(id))
      .filter((name): name is string => name !== undefined)
    if (members.length > 0) entry.fixtures = members
    if (group.size && (group.size.width > 0 || group.size.height > 0)) entry.size = group.size

    const cells = (group.cells ?? [])
      .map((cell) => {
        const name = fixtureName.get(cell.fixture)
        return name === undefined
          ? undefined
          : compact({ x: cell.x, y: cell.y, fixture: name, head: cell.head || undefined })
      })
      .filter((cell): cell is NonNullable<typeof cell> => cell !== undefined)
    if (cells.length > 0) entry.cells = cells

    return entry
  })

  /* ---- funciones ------------------------------------------------------ */

  const bodies = await Promise.all(
    functions.map(async (fn) => {
      try {
        return await client.functionBody(fn.id)
      } catch {
        return {}
      }
    }),
  )

  // Los canales solo se nombran para las fixtures que alguna escena toca, que
  // en un rig grande son muchas menos que todas.
  const touched = new Set<number>()
  for (const body of bodies) {
    for (const value of (body.values as { fixture: number }[] | undefined) ?? []) {
      touched.add(value.fixture)
    }
  }
  const channels = await ChannelNames.of(client, touched)

  spec.functions = functions.map((fn, index) =>
    exportFunction(fn, bodies[index] ?? {}, { fixtureName, functionName, groupName, channels }),
  )

  /* ---- consola -------------------------------------------------------- */

  if (options.console) {
    const console_ = await exportConsole(client, functionName, fixtureName, channels)
    if (console_) spec.console = console_
  }

  return spec
}

interface Names {
  fixtureName: Map<number, string>
  functionName: Map<number, string>
  groupName: Map<number, string>
  channels: ChannelNames
}

function exportFunction(
  fn: FunctionSummary,
  body: Record<string, unknown>,
  names: Names,
): FunctionSpec {
  const spec: FunctionSpec = compact({
    name: fn.name,
    type: fn.type,
    path: fn.path || undefined,
    fadeIn: fn.fadeIn,
    fadeOut: fn.fadeOut,
    duration: fn.duration,
    runOrder: fn.runOrder,
    direction: fn.direction,
    tempoType: fn.tempoType === 'original' ? undefined : fn.tempoType,
  })

  switch (fn.type) {
    case 'Scene': {
      const values = (body.values as { fixture: number; channel: number; value: number }[]) ?? []
      spec.values = values
        .filter((value) => names.fixtureName.has(value.fixture))
        .map((value) => ({
          fixture: names.fixtureName.get(value.fixture) as string,
          channel: names.channels.write(value.fixture, value.channel),
          value: value.value,
        }))
      break
    }

    case 'Chaser':
    case 'Sequence': {
      const steps =
        (body.steps as
          | {
              function: number
              fadeIn: number
              hold: number
              fadeOut: number
              duration: number
              note?: string
            }[]
          | undefined) ?? []
      spec.steps = steps
        .filter((step) => names.functionName.has(step.function))
        .map((step) =>
          compact({
            function: names.functionName.get(step.function) as string,
            fadeIn: step.fadeIn,
            hold: step.hold,
            fadeOut: step.fadeOut,
            duration: step.duration,
            note: step.note || undefined,
          }),
        )
      // `default` no se exporta: es el estado en que nace un chaser, y el
      // daemon se niega a ponerlo a propósito en fadeIn y fadeOut, porque QLC+
      // solo ofrece ese modo en la columna de duración. Un documento que lo
      // pidiera sería un documento que no se puede aplicar; omitirlo no pierde
      // nada, porque lo que se cree ya estará ahí.
      const mode = (value: unknown) => (value === 'default' ? undefined : (value as string))
      set(spec, 'fadeInMode', mode(body.fadeInMode))
      set(spec, 'fadeOutMode', mode(body.fadeOutMode))
      set(spec, 'durationMode', mode(body.durationMode))
      if (typeof body.scene === 'number') {
        set(spec, 'scene', names.functionName.get(body.scene))
      }
      break
    }

    case 'Collection': {
      const members = (body.members as { function: number }[] | undefined) ?? []
      spec.members = members
        .map((member) => names.functionName.get(member.function))
        .filter((name): name is string => name !== undefined)
      break
    }

    case 'EFX': {
      set(spec, 'algorithm', body.algorithm as string | undefined)
      set(spec, 'geometry', body.geometry as Record<string, number> | undefined)
      set(spec, 'propagation', body.propagation as string | undefined)
      const heads =
        (body.heads as
          | { fixture: number; head: number; offset: number; reverse: boolean; mode: string }[]
          | undefined) ?? []
      spec.heads = heads
        .filter((head) => names.fixtureName.has(head.fixture))
        .map((head) =>
          compact({
            fixture: names.fixtureName.get(head.fixture) as string,
            head: head.head || undefined,
            offset: head.offset || undefined,
            reverse: head.reverse || undefined,
            mode: head.mode,
          }),
        )
      break
    }

    case 'RGBMatrix': {
      set(spec, 'algorithm', body.algorithm as string | undefined)
      if (typeof body.fixtureGroup === 'number') {
        set(spec, 'group', names.groupName.get(body.fixtureGroup))
      }
      set(spec, 'colors', body.colors as (string | null)[] | undefined)
      set(spec, 'blendMode', body.blendMode as string | undefined)
      set(spec, 'controlMode', body.controlMode as string | undefined)
      const properties = body.properties as { name: string; value: string }[] | undefined
      if (properties?.length) {
        spec.properties = Object.fromEntries(properties.map((p) => [p.name, p.value]))
      }
      break
    }

    case 'Script':
      set(spec, 'data', body.data as string | undefined)
      break

    case 'Audio':
      set(spec, 'source', body.source as string | undefined)
      set(spec, 'volume', body.volume as number | undefined)
      set(spec, 'device', body.device as string | undefined)
      break

    case 'Video':
      set(spec, 'source', body.source as string | undefined)
      set(spec, 'screen', body.screen as number | undefined)
      set(spec, 'fullscreen', body.fullscreen as boolean | undefined)
      set(spec, 'layer', body.layer as number | undefined)
      break

    default:
      // Show y lo que venga: se exporta la función, no su cuerpo. Dicho en el
      // encabezado del módulo, no escondido aquí.
      break
  }

  return compact(spec)
}

async function exportConsole(
  client: OrchidClient,
  functionName: Map<number, string>,
  fixtureName: Map<number, string>,
  channels: ChannelNames,
): Promise<ConsoleSpec | undefined> {
  let root: Record<string, unknown>
  try {
    root = await client.get<Record<string, unknown>>('/vc')
  } catch {
    // Un proyecto sin Virtual Console contesta 404, y eso no es un fallo.
    return undefined
  }

  const children = (root.children as Record<string, unknown>[] | undefined) ?? []
  return {
    widgets: children.map((child) => exportWidget(child, functionName, fixtureName, channels)),
  }
}

function exportWidget(
  widget: Record<string, unknown>,
  functionName: Map<number, string>,
  fixtureName: Map<number, string>,
  channels: ChannelNames,
): WidgetSpec {
  const spec: WidgetSpec = compact({
    type: widget.type as string,
    caption: (widget.caption as string) || undefined,
    functionId:
      typeof widget.functionId === 'number' ? functionName.get(widget.functionId) : undefined,
    chaserId: typeof widget.chaserId === 'number' ? functionName.get(widget.chaserId) : undefined,
    action: widget.action as string | undefined,
    sliderMode: widget.sliderMode as string | undefined,
    background: widget.background as string | undefined,
    foreground: widget.foreground as string | undefined,
    font: widget.font as string | undefined,
    page: (widget.page as number) || undefined,
    pages: (widget.pages as number) || undefined,
    geometry: widget.geometry as WidgetSpec['geometry'],
    input: widget.input as WidgetSpec['input'],
  })

  const level = widget.levelChannels as { fixture: number; channel: number }[] | undefined
  if (level?.length) {
    spec.levelChannels = level
      .filter((entry) => fixtureName.has(entry.fixture))
      .map((entry) => ({
        fixture: fixtureName.get(entry.fixture) as string,
        channel: channels.write(entry.fixture, entry.channel),
      }))
  }

  const children = widget.children as Record<string, unknown>[] | undefined
  if (children?.length) {
    spec.children = children.map((child) =>
      exportWidget(child, functionName, fixtureName, channels),
    )
  }

  return spec
}
