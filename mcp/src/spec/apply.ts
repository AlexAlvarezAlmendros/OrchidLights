/**
 * Llevar un proyecto a lo que dice un documento.
 *
 * Tres compromisos, y de ellos cuelga todo lo demás:
 *
 * **Se valida entero antes de tocar nada.** Un documento que nombra una fixture
 * que no existe, una función repetida o un plugin que esta máquina no tiene se
 * rechaza completo. Aplicar la mitad de un show deja un proyecto que no es ni
 * el viejo ni el nuevo, y nadie sabe cuál de las dos mitades está mirando. Es
 * la misma regla que ya aplica `DocWriter::addFixtures` a un patch.
 *
 * **Aplicar dos veces no hace nada la segunda.** Cada sección se compara con lo
 * que hay y solo se escribe la diferencia. Sin esto un documento no es
 * declarativo: es un script que solo se puede correr una vez.
 *
 * **Lo que el documento no menciona no se borra.** Un documento parcial es lo
 * normal —alguien describe las escenas y no el patch—, e interpretar el
 * silencio como «borra el resto» es perder un show por omisión. Con `prune` se
 * pide explícitamente lo contrario.
 */

import type { Fixture, FixtureGroup, FunctionSummary, OrchidClient, Universe } from '../client.js'
import { ChannelNames } from './channels.js'
import { Resolver } from './resolver.js'
import { type FunctionSpec, SPEC_VERSION, type ShowSpec, type WidgetSpec } from './types.js'

export interface ApplyOptions {
  /** Calcular el plan y no aplicarlo. Un agente que no puede ensayar aprende rompiendo. */
  dryRun?: boolean
  /** Borrar lo que el documento no menciona. Apagado por defecto, y por algo. */
  prune?: boolean
  /** Guardar al terminar. Sin esto la edición vive en memoria y muere con el daemon. */
  save?: boolean
}

export type ActionKind = 'create' | 'update' | 'delete'

export interface PlannedAction {
  section: string
  kind: ActionKind
  name: string
  detail?: string
}

interface Action extends PlannedAction {
  run: (resolver: Resolver) => Promise<void>
}

export interface ApplyReport {
  dryRun: boolean
  actions: PlannedAction[]
  created: number
  updated: number
  deleted: number
  /** Cuántas entradas dejó el lote en el anillo de undo, para poder deshacerlo entero. */
  /**
   * Cuántas entradas dejó el lote en el anillo de undo: cuántas veces hay que
   * llamar a `POST /api/v1/undo` para devolverlo todo.
   */
  undoSteps: number
  /**
   * Verdadero cuando el lote fue más largo que el anillo y se comió su propio
   * principio. Entonces NO se puede deshacer entero, y decirlo importa: quien
   * crea que puede volver atrás y no pueda, descubre que no puede tarde.
   */
  undoOverflowed: boolean
  savedTo?: string
}

export class SpecError extends Error {
  constructor(readonly problems: string[]) {
    super(
      problems.length === 1
        ? (problems[0] as string)
        : `El documento tiene ${problems.length} problemas:\n  · ${problems.join('\n  · ')}`,
    )
    this.name = 'SpecError'
  }
}

/** Lo que hay ahora en la mesa, leído una vez. */
interface Current {
  fixtures: Fixture[]
  functions: FunctionSummary[]
  universes: Universe[]
  groups: FixtureGroup[]
  plan: Awaited<ReturnType<OrchidClient['plan']>>
  bodies: Map<number, Record<string, unknown>>
  channels: ChannelNames
  startupFunction: number
}

async function read(client: OrchidClient, spec: ShowSpec): Promise<Current> {
  const [fixtures, functions, universes, groups, plan, project] = await Promise.all([
    client.fixtures(),
    client.functions(),
    client.universes(),
    client.fixtureGroups(),
    client.plan(),
    client.project(),
  ])

  // Los cuerpos solo de las funciones que el documento describe: leer los de un
  // proyecto entero para comparar tres escenas es pagar por nada.
  const wanted = new Set((spec.functions ?? []).map((fn) => fn.name))
  const bodies = new Map<number, Record<string, unknown>>()
  await Promise.all(
    functions
      .filter((fn) => wanted.has(fn.name))
      .map(async (fn) => {
        try {
          bodies.set(fn.id, await client.functionBody(fn.id))
        } catch {
          bodies.set(fn.id, {})
        }
      }),
  )

  // Los canales solo se nombran para las fixtures que alguna escena toca.
  const touched = new Set<number>()
  const byName = new Map(fixtures.map((f) => [f.name, f.id]))
  for (const fn of spec.functions ?? []) {
    for (const value of fn.values ?? []) {
      const id = byName.get(value.fixture)
      if (id !== undefined) touched.add(id)
    }
  }
  for (const body of bodies.values()) {
    for (const value of (body.values as { fixture: number }[] | undefined) ?? []) {
      touched.add(value.fixture)
    }
  }

  return {
    fixtures,
    functions,
    universes,
    groups,
    plan,
    bodies,
    channels: await ChannelNames.of(client, touched),
    startupFunction: project.startupFunction,
  }
}

/** Nombres repetidos dentro de una sección: el documento no dice a cuál se refiere. */
function duplicates(names: string[], section: string): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) repeated.add(name)
    seen.add(name)
  }
  return [...repeated].map((name) => `${section}: "${name}" aparece dos veces`)
}

/**
 * Igualdad estructural, insensible al orden de las claves de un objeto.
 *
 * Un `JSON.stringify` a cada lado no vale: `QJsonObject` serializa las claves en
 * orden alfabético, así que un `{width: 4, height: 1}` escrito a mano vuelve
 * como `{"height":1,"width":4}` y la comparación dice que ha cambiado. El plan
 * proponía entonces reescribir la rejilla de un grupo en cada pasada -- una
 * diferencia fantasma, que es peor que ninguna comparación, porque hace dudar
 * de las de verdad.
 *
 * El orden de un array SÍ cuenta: los pasos de un chaser son una secuencia.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => same(entry, b[index]))
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    // Ausente y `undefined` son lo mismo aquí: el daemon omite lo que no tiene
    // y un documento escrito a mano tampoco lo escribe.
    if (left[key] === undefined && right[key] === undefined) continue
    if (!same(left[key], right[key])) return false
  }
  return true
}

/* ---- el plan ---------------------------------------------------------- */

export async function planApply(
  client: OrchidClient,
  spec: ShowSpec,
  options: ApplyOptions = {},
): Promise<{ actions: Action[]; problems: string[] }> {
  const problems: string[] = []
  const actions: Action[] = []

  if (spec.orchidlights !== SPEC_VERSION) {
    return {
      actions,
      problems: [
        `El documento dice "orchidlights: ${spec.orchidlights}" y esta versión entiende ${SPEC_VERSION}`,
      ],
    }
  }

  const current = await read(client, spec)

  problems.push(
    ...duplicates(
      (spec.fixtures ?? []).map((f) => f.name),
      'fixtures',
    ),
  )
  problems.push(
    ...duplicates(
      (spec.functions ?? []).map((f) => f.name),
      'functions',
    ),
  )
  problems.push(
    ...duplicates(
      (spec.fixtureGroups ?? []).map((g) => g.name),
      'fixtureGroups',
    ),
  )

  problems.push(...checkStage(spec))
  problems.push(...checkReferences(spec, current))
  problems.push(...(await checkPatchable(client, spec)))
  problems.push(...(await checkProfiles(client, spec, current)))
  problems.push(...checkTypes(spec, current))

  if (problems.length > 0) return { actions: [], problems }

  planUniverses(client, spec, current, actions)
  planStage(client, spec, current, actions)
  planFixtures(client, spec, current, actions, options)
  planGroups(client, spec, current, actions, options)
  planFunctions(client, spec, current, actions, options)
  planStartup(client, spec, current, actions)

  if (spec.console) actions.push(...(await planConsole(client, spec.console.widgets ?? [])))

  return { actions, problems }
}

/**
 * Un escenario de un tamaño que el motor no acepta.
 *
 * La rejilla va en UNIDADES —metros o pies—, no en milímetros: un escenario
 * mide 12 de ancho, no 12000. Las posiciones de las fixtures sí van en
 * milímetros contra ella, y confundir las dos es el error natural. Se
 * comprueba aquí porque el documento suele empezar por el escenario, y sin
 * esto el lote falla en su primera acción con veinte por delante -- que es
 * exactamente lo que este módulo promete no hacer.
 */
function checkStage(spec: ShowSpec): string[] {
  const stage = spec.stage
  if (!stage) return []

  const problems: string[] = []
  for (const side of ['width', 'depth'] as const) {
    const value = stage[side]
    if (value === undefined) continue
    if (value < 1 || value > 1000) {
      problems.push(
        [
          `stage: ${side} es ${value}, y un escenario mide entre 1 y 1000 ${stage.units ?? 'unidades'} de lado.`,
          'La rejilla va en unidades; los milímetros son para colocar las fixtures sobre ella.',
        ].join(' '),
      )
    }
  }
  return problems
}

function checkReferences(spec: ShowSpec, current: Current): string[] {
  const problems: string[] = []

  // Los nombres que habrá DESPUÉS de aplicar, no los que hay ahora: un chaser
  // puede encadenar una escena que este mismo documento crea.
  const fixtures = new Set([
    ...current.fixtures.map((f) => f.name),
    ...(spec.fixtures ?? []).map((f) => f.name),
  ])
  const functions = new Set([
    ...current.functions.map((f) => f.name),
    ...(spec.functions ?? []).map((f) => f.name),
  ])
  const groups = new Set([
    ...current.groups.map((g) => g.name),
    ...(spec.fixtureGroups ?? []).map((g) => g.name),
  ])

  for (const group of spec.fixtureGroups ?? []) {
    for (const name of group.fixtures ?? []) {
      if (!fixtures.has(name)) {
        problems.push(`fixtureGroups: "${group.name}" nombra la fixture "${name}", que no existe`)
      }
    }
    for (const cell of group.cells ?? []) {
      if (!fixtures.has(cell.fixture)) {
        problems.push(
          `fixtureGroups: la celda (${cell.x},${cell.y}) de "${group.name}" nombra la fixture "${cell.fixture}", que no existe`,
        )
      }
    }
  }

  for (const fn of spec.functions ?? []) {
    for (const value of fn.values ?? []) {
      if (!fixtures.has(value.fixture)) {
        problems.push(`functions: "${fn.name}" nombra la fixture "${value.fixture}", que no existe`)
      }
    }
    for (const step of fn.steps ?? []) {
      if (!functions.has(step.function)) {
        problems.push(`functions: "${fn.name}" encadena "${step.function}", que no existe`)
      }
    }
    for (const member of fn.members ?? []) {
      if (!functions.has(member)) {
        problems.push(`functions: "${fn.name}" contiene "${member}", que no existe`)
      }
    }
    for (const head of fn.heads ?? []) {
      if (!fixtures.has(head.fixture)) {
        problems.push(`functions: "${fn.name}" apunta "${head.fixture}", que no existe`)
      }
    }
    if (fn.group !== undefined && !groups.has(fn.group)) {
      problems.push(`functions: "${fn.name}" corre sobre el grupo "${fn.group}", que no existe`)
    }
    if (fn.scene !== undefined && !functions.has(fn.scene)) {
      problems.push(`functions: "${fn.name}" cuelga de la escena "${fn.scene}", que no existe`)
    }
  }

  for (const widget of flatten(spec.console?.widgets ?? [])) {
    for (const key of ['functionId', 'chaserId'] as const) {
      const name = widget[key]
      if (name !== undefined && !functions.has(name)) {
        problems.push(
          `console: el widget "${widget.caption ?? widget.type}" apunta a "${name}", que no existe`,
        )
      }
    }
  }

  const startup = spec.project?.startupFunction
  if (startup && !functions.has(startup)) {
    problems.push(`project: la función de arranque "${startup}" no existe`)
  }

  return problems
}

function flatten(widgets: WidgetSpec[]): WidgetSpec[] {
  return widgets.flatMap((widget) => [widget, ...flatten(widget.children ?? [])])
}

/**
 * Un plugin o una línea que esta máquina no tiene.
 *
 * Es la trampa que más caro sale: patchear a "Art-Net" cuando el plugin se
 * llama "ArtNet" no da error, da un universo sin salida, y eso no se ve hasta
 * que no se enciende nada.
 */
async function checkPatchable(client: OrchidClient, spec: ShowSpec): Promise<string[]> {
  const patches = (spec.universes ?? []).some((u) => u.output ?? u.input ?? u.feedback)
  if (!patches) return []

  const io = await client.io()
  const outputs = new Map(io.outputPlugins.map((p) => [p.name, new Set(p.lines)]))
  const inputs = new Map(io.inputPlugins.map((p) => [p.name, new Set(p.lines)]))
  const profiles = new Set(io.inputProfiles)
  const problems: string[] = []
  ;(spec.universes ?? []).forEach((universe, index) => {
    const check = (kind: 'output' | 'input' | 'feedback', available: Map<string, Set<string>>) => {
      const patch = universe[kind]
      if (!patch) return
      const lines = available.get(patch.plugin)
      if (lines === undefined) {
        problems.push(
          `universes[${index}] "${universe.name}": esta máquina no tiene el plugin "${patch.plugin}" para ${kind}. Hay: ${[...available.keys()].join(', ') || 'ninguno'}`,
        )
        return
      }
      if (patch.line !== undefined && lines.size > 0 && !lines.has(patch.line)) {
        problems.push(
          `universes[${index}] "${universe.name}": el plugin "${patch.plugin}" no tiene la línea "${patch.line}". Hay: ${[...lines].join(', ')}`,
        )
      }
    }

    check('output', outputs)
    // El feedback vuelve conceptualmente, pero sale por una salida.
    check('feedback', outputs)
    check('input', inputs)

    if (universe.input?.profile && !profiles.has(universe.input.profile)) {
      problems.push(
        `universes[${index}] "${universe.name}": no hay un perfil de entrada llamado "${universe.input.profile}"`,
      )
    }
  })

  return problems
}

/**
 * Que los perfiles existan, antes de patchear nada.
 *
 * Sin esto un documento con un modelo mal escrito construye media mesa y falla
 * en la fixture veinte, que es exactamente lo que este módulo promete no hacer.
 * Solo se comprueban las que van a crearse o a cambiar de perfil: releer la
 * librería para las que ya están patcheadas y no se tocan es preguntar por algo
 * que el motor ya resolvió.
 */
async function checkProfiles(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
): Promise<string[]> {
  const byName = new Map(current.fixtures.map((f) => [f.name, f]))
  const problems: string[] = []
  const seen = new Map<string, Promise<{ modes?: { name: string }[]; error?: string }>>()

  for (const wanted of spec.fixtures ?? []) {
    const existing = byName.get(wanted.name)
    const unchanged =
      existing !== undefined &&
      (existing.manufacturer ?? '') === wanted.manufacturer &&
      (existing.model ?? '') === wanted.model &&
      (existing.mode ?? '') === wanted.mode
    if (unchanged) continue

    // El dímer genérico no es un fichero de la librería: el motor lo sintetiza,
    // y el modo es donde va escrito cuántos canales tiene.
    if (wanted.manufacturer === 'Generic' && wanted.model === 'Generic') {
      const channels = Number.parseInt(wanted.mode, 10)
      if (!Number.isFinite(channels) || channels < 1 || channels > 512) {
        problems.push(
          `fixtures: "${wanted.name}" es un dímer genérico y su modo dice cuántos canales tiene, como "6 Channel"; "${wanted.mode}" no`,
        )
      }
      continue
    }

    const key = `${wanted.manufacturer}/${wanted.model}`
    let lookup = seen.get(key)
    if (lookup === undefined) {
      lookup = client
        .get<{ modes?: { name: string }[] }>(
          `/library/${encodeURIComponent(wanted.manufacturer)}/${encodeURIComponent(wanted.model)}`,
        )
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      seen.set(key, lookup)
    }

    const profile = await lookup
    if (profile.error !== undefined || profile.modes === undefined) {
      problems.push(
        `fixtures: "${wanted.name}" pide el perfil "${key}", que no está en la librería de esta instalación`,
      )
      continue
    }

    const modes = profile.modes.map((mode) => mode.name)
    if (!modes.includes(wanted.mode)) {
      problems.push(
        `fixtures: "${key}" no tiene el modo "${wanted.mode}". Tiene: ${modes.join(', ')}`,
      )
    }
  }

  return problems
}

function checkTypes(spec: ShowSpec, current: Current): string[] {
  const byName = new Map(current.functions.map((f) => [f.name, f]))
  const problems: string[] = []

  for (const wanted of spec.functions ?? []) {
    const existing = byName.get(wanted.name)
    if (existing !== undefined && existing.type !== wanted.type) {
      problems.push(
        [
          `functions: "${wanted.name}" es ${existing.type} en el proyecto y ${wanted.type} en el documento.`,
          'Cambiar de tipo es borrarla y crearla, y eso se lleva por delante lo que cuelgue de ella:',
          'hazlo a mano.',
        ].join(' '),
      )
    }
  }

  return problems
}

/* ---- las secciones ---------------------------------------------------- */

/**
 * Los universos se casan por POSICIÓN, no por nombre: una fixture dice
 * «universo 1», y ese 1 es el sitio en la lista. Renombrar un universo no puede
 * mover el rig de sitio.
 */
function planUniverses(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
): void {
  ;(spec.universes ?? []).forEach((wanted, index) => {
    const id = index + 1
    const existing = current.universes[index]

    if (existing === undefined) {
      actions.push({
        section: 'universes',
        kind: 'create',
        name: wanted.name,
        detail: `universo ${id}`,
        run: async () => {
          await client.post('/universes', { name: wanted.name })
          await patchUniverse(client, id, wanted)
        },
      })
      return
    }

    const changes: string[] = []
    if (existing.name !== wanted.name) changes.push(`nombre → "${wanted.name}"`)

    const output = existing.outputs?.[0]
    if (
      wanted.output &&
      (output?.plugin !== wanted.output.plugin ||
        (output?.output ?? output?.line) !== wanted.output.line)
    ) {
      changes.push(`salida → ${wanted.output.plugin}/${wanted.output.line ?? ''}`)
    }
    if (
      wanted.input &&
      (existing.input?.plugin !== wanted.input.plugin ||
        existing.input?.line !== wanted.input.line ||
        (existing.input?.profile || undefined) !== wanted.input.profile)
    ) {
      changes.push(`entrada → ${wanted.input.plugin}/${wanted.input.line ?? ''}`)
    }
    if (
      wanted.feedback &&
      (existing.feedback?.plugin !== wanted.feedback.plugin ||
        (existing.feedback?.line ?? existing.feedback?.output) !== wanted.feedback.line)
    ) {
      changes.push(`feedback → ${wanted.feedback.plugin}/${wanted.feedback.line ?? ''}`)
    }
    if (
      wanted.passthrough !== undefined &&
      (existing.passthrough ?? false) !== wanted.passthrough
    ) {
      changes.push(`passthrough → ${wanted.passthrough}`)
    }

    if (changes.length > 0) {
      actions.push({
        section: 'universes',
        kind: 'update',
        name: wanted.name,
        detail: changes.join(', '),
        run: () => patchUniverse(client, id, wanted),
      })
    }
  })
}

function planStage(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
): void {
  const wanted = spec.stage
  if (!wanted) return

  const grid = current.plan.grid
  const differs =
    (wanted.width !== undefined && wanted.width !== grid.width) ||
    (wanted.height !== undefined && wanted.height !== grid.height) ||
    (wanted.depth !== undefined && wanted.depth !== grid.depth) ||
    (wanted.units !== undefined && wanted.units !== grid.units)

  if (!differs) return

  const size = {
    width: wanted.width ?? grid.width,
    height: wanted.height ?? grid.height,
    depth: wanted.depth ?? grid.depth,
    units: wanted.units ?? grid.units,
  }

  actions.push({
    section: 'stage',
    kind: 'update',
    name: 'rejilla',
    detail: `${size.width}×${size.height}×${size.depth} ${size.units}`,
    run: async () => {
      await client.put('/plan/grid', size)
    },
  })
}

function planFixtures(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
  options: ApplyOptions,
): void {
  const byName = new Map(current.fixtures.map((f) => [f.name, f]))
  const placement = new Map(current.plan.fixtures.map((f) => [f.id, f]))
  const mentioned = new Set<string>()

  for (const wanted of spec.fixtures ?? []) {
    mentioned.add(wanted.name)
    const existing = byName.get(wanted.name)

    if (existing === undefined) {
      actions.push({
        section: 'fixtures',
        kind: 'create',
        name: wanted.name,
        detail: `${wanted.manufacturer} ${wanted.model} · ${wanted.mode} · U${wanted.universe}@${wanted.address}`,
        run: async () => {
          await client.post('/fixtures', {
            manufacturer: wanted.manufacturer,
            model: wanted.model,
            mode: wanted.mode,
            name: wanted.name,
            universe: wanted.universe,
            address: wanted.address,
          })
        },
      })
    } else if (
      (existing.manufacturer ?? '') !== wanted.manufacturer ||
      (existing.model ?? '') !== wanted.model ||
      (existing.mode ?? '') !== wanted.mode
    ) {
      // Cambiar de perfil o de modo cambia qué significa cada canal, así que no
      // es un PATCH: es un remap, que traslada lo que tenga equivalente y dice
      // cuánto se quedó por el camino.
      actions.push({
        section: 'fixtures',
        kind: 'update',
        name: wanted.name,
        detail: `perfil → ${wanted.manufacturer} ${wanted.model} · ${wanted.mode} (remap)`,
        run: async () => {
          await client.post(`/fixtures/${existing.id}/remap`, {
            manufacturer: wanted.manufacturer,
            model: wanted.model,
            mode: wanted.mode,
            name: wanted.name,
            universe: wanted.universe,
            address: wanted.address,
          })
        },
      })
    } else if (existing.universe !== wanted.universe || existing.address !== wanted.address) {
      actions.push({
        section: 'fixtures',
        kind: 'update',
        name: wanted.name,
        detail: `dirección → U${wanted.universe}@${wanted.address}`,
        run: async () => {
          await client.patch(`/fixtures/${existing.id}`, {
            universe: wanted.universe,
            address: wanted.address,
          })
        },
      })
    }

    // El sitio en el escenario va aparte: mover una lámpara en el plano no es
    // moverla de dirección, y una recién creada todavía no tiene id.
    if (wanted.stage) {
      const now = existing ? placement.get(existing.id) : undefined
      const differs =
        now === undefined ||
        Object.entries(wanted.stage).some(
          ([key, value]) => (now as unknown as Record<string, unknown>)[key] !== value,
        )

      if (differs) {
        actions.push({
          section: 'stage',
          kind: existing === undefined ? 'create' : 'update',
          name: wanted.name,
          detail: `en (${wanted.stage.x ?? '·'}, ${wanted.stage.y ?? '·'}, ${wanted.stage.z ?? '·'})`,
          run: async (resolver) => {
            const fixture = await resolver.fixture(wanted.name)
            await client.put(`/plan/fixtures/${fixture.id}`, wanted.stage)
          },
        })
      }
    }
  }

  if (options.prune && spec.fixtures) {
    for (const existing of current.fixtures) {
      if (mentioned.has(existing.name)) continue
      actions.push({
        section: 'fixtures',
        kind: 'delete',
        name: existing.name,
        run: async () => {
          await client.delete(`/fixtures/${existing.id}`)
        },
      })
    }
  }
}

function planGroups(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
  options: ApplyOptions,
): void {
  const byName = new Map(current.groups.map((g) => [g.name, g]))
  const fixtureName = new Map(current.fixtures.map((f) => [f.id, f.name]))
  const mentioned = new Set<string>()

  for (const wanted of spec.fixtureGroups ?? []) {
    mentioned.add(wanted.name)
    const existing = byName.get(wanted.name)

    if (existing === undefined) {
      actions.push({
        section: 'fixtureGroups',
        kind: 'create',
        name: wanted.name,
        detail: `${wanted.fixtures?.length ?? 0} fixtures`,
        run: async (resolver) => {
          const ids = await resolver.fixtureIds(wanted.fixtures ?? [])
          const created = await client.post<{ id: number }>('/fixture-groups', {
            name: wanted.name,
            fixtures: ids,
          })
          if (wanted.size) {
            await client.patch(`/fixture-groups/${created.id}`, { size: wanted.size })
          }
        },
      })
      continue
    }

    const members = (existing.fixtures ?? [])
      .map((id) => fixtureName.get(id))
      .filter((name): name is string => name !== undefined)

    const membersDiffer =
      wanted.fixtures !== undefined && !same([...members].sort(), [...wanted.fixtures].sort())
    const sizeDiffers = wanted.size !== undefined && !same(existing.size, wanted.size)

    if (!membersDiffer && !sizeDiffers) continue

    actions.push({
      section: 'fixtureGroups',
      kind: 'update',
      name: wanted.name,
      detail: [membersDiffer && 'miembros', sizeDiffers && 'rejilla'].filter(Boolean).join(' y '),
      run: async (resolver) => {
        const body: Record<string, unknown> = {}
        if (membersDiffer) body.fixtures = await resolver.fixtureIds(wanted.fixtures ?? [])
        if (sizeDiffers) body.size = wanted.size
        await client.patch(`/fixture-groups/${existing.id}`, body)
      },
    })
  }

  if (options.prune && spec.fixtureGroups) {
    for (const existing of current.groups) {
      if (mentioned.has(existing.name)) continue
      actions.push({
        section: 'fixtureGroups',
        kind: 'delete',
        name: existing.name,
        run: async () => {
          await client.delete(`/fixture-groups/${existing.id}`)
        },
      })
    }
  }
}

/**
 * Lo que se ajusta con un PATCH sobre la función.
 *
 * Separadas en dos por dónde se leen: los tiempos y la marcha vienen en el
 * resumen de `GET /functions`, pero los modos de velocidad de un chaser están
 * en su cuerpo. Compararlos contra el resumen es compararlos contra
 * `undefined`, y entonces el plan cree que hay algo que cambiar en cada pasada
 * — que es como este documento dejó de ser idempotente la primera vez.
 */
const SUMMARY_ATTRIBUTES = [
  'fadeIn',
  'fadeOut',
  'duration',
  'runOrder',
  'direction',
  'tempoType',
  'path',
] as const

const BODY_ATTRIBUTES = ['fadeInMode', 'fadeOutMode', 'durationMode'] as const

function planFunctions(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
  options: ApplyOptions,
): void {
  const byName = new Map(current.functions.map((f) => [f.name, f]))
  const mentioned = new Set<string>()

  // Primero existen todas, después se llenan. Un chaser puede encadenar una
  // escena que este mismo documento crea, y no puede apuntar a algo que
  // todavía no tiene id.
  for (const wanted of spec.functions ?? []) {
    mentioned.add(wanted.name)
    if (byName.has(wanted.name)) continue
    actions.push({
      section: 'functions',
      kind: 'create',
      name: wanted.name,
      detail: wanted.type,
      run: async () => {
        await client.post('/functions', { type: wanted.type, name: wanted.name })
      },
    })
  }

  for (const wanted of spec.functions ?? []) {
    const existing = byName.get(wanted.name)

    const currentBody = existing ? (current.bodies.get(existing.id) ?? {}) : {}
    const body: Record<string, unknown> = {}
    const changed: string[] = []

    const consider = (key: string, value: unknown, now: unknown) => {
      if (value === undefined) return
      body[key] = value
      if (existing !== undefined && now !== value) changed.push(`${key} → ${String(value)}`)
    }

    for (const key of SUMMARY_ATTRIBUTES) {
      consider(
        key,
        wanted[key],
        (existing as unknown as Record<string, unknown> | undefined)?.[key],
      )
    }
    for (const key of BODY_ATTRIBUTES) {
      consider(key, wanted[key], currentBody[key])
    }

    if (Object.keys(body).length > 0 && (existing === undefined || changed.length > 0)) {
      actions.push({
        section: 'functions',
        kind: existing === undefined ? 'create' : 'update',
        name: wanted.name,
        detail: existing === undefined ? 'tiempos y marcha' : changed.join(', '),
        run: async (resolver) => {
          await client.patch(`/functions/${await resolver.functionId(wanted.name)}`, body)
        },
      })
    }

    const bodyAction = planFunctionBody(client, wanted, existing, current)
    if (bodyAction) actions.push(bodyAction)
  }

  if (options.prune && spec.functions) {
    for (const existing of current.functions) {
      if (mentioned.has(existing.name)) continue
      actions.push({
        section: 'functions',
        kind: 'delete',
        name: existing.name,
        run: async () => {
          await client.delete(`/functions/${existing.id}`)
        },
      })
    }
  }
}

function planFunctionBody(
  client: OrchidClient,
  wanted: FunctionSpec,
  existing: FunctionSummary | undefined,
  current: Current,
): Action | undefined {
  const body = existing ? (current.bodies.get(existing.id) ?? {}) : {}
  const kind: ActionKind = existing === undefined ? 'create' : 'update'

  switch (wanted.type) {
    case 'Scene': {
      if (wanted.values === undefined) return undefined

      const now = new Map<string, number>()
      for (const value of (body.values as { fixture: number; channel: number; value: number }[]) ??
        []) {
        now.set(`${value.fixture}:${value.channel}`, value.value)
      }

      const target = new Map<string, number>()
      const unresolved: string[] = []
      for (const value of wanted.values) {
        const fixture = current.fixtures.find((f) => f.name === value.fixture)
        if (fixture === undefined) continue // se crea en este lote; se resuelve al correr
        const channel = current.channels.read(fixture.id, value.channel)
        if (channel === undefined) {
          unresolved.push(String(value.channel))
          continue
        }
        target.set(`${fixture.id}:${channel}`, value.value)
      }

      const writes: { fixture: number; channel: number; value: number }[] = []
      for (const [key, value] of target) {
        if (now.get(key) === value) continue
        const [fixture, channel] = key.split(':')
        writes.push({ fixture: Number(fixture), channel: Number(channel), value })
      }
      // Lo que la escena tiene y el documento no lo dice: se quita. Es lo que
      // significa describir una escena entera en vez de parchearla.
      for (const key of now.keys()) {
        if (target.has(key)) continue
        const [fixture, channel] = key.split(':')
        writes.push({ fixture: Number(fixture), channel: Number(channel), value: -1 })
      }

      const pending = existing === undefined || writes.length > 0 || unresolved.length > 0
      if (!pending) return undefined

      const put = writes.filter((w) => w.value >= 0).length
      const cleared = writes.length - put

      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail:
          existing === undefined
            ? `${wanted.values.length} valores`
            : `${put} canales puestos, ${cleared} quitados`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          // Se resuelve otra vez al correr: entre el plan y aquí este mismo
          // lote puede haber creado la fixture que la escena nombra.
          const live = new Map<string, number>()
          for (const value of wanted.values ?? []) {
            const fixture = await resolver.fixture(value.fixture)
            const names = await ChannelNames.of(client, [fixture.id])
            const channel = names.read(fixture.id, value.channel)
            if (channel === undefined) {
              throw new Error(
                `"${value.fixture}" no tiene un canal "${value.channel}". Tiene: ${names.known(fixture.id).join(', ')}`,
              )
            }
            live.set(`${fixture.id}:${channel}`, value.value)
          }

          for (const [key, value] of live) {
            const [fixture, channel] = key.split(':')
            await client.post(`/functions/${id}/values`, {
              fixture: Number(fixture),
              channel: Number(channel),
              value,
            })
          }
          for (const write of writes) {
            if (write.value < 0) {
              await client.post(`/functions/${id}/values`, { ...write, value: -1 })
            }
          }
        },
      }
    }

    case 'Chaser':
    case 'Sequence': {
      if (wanted.steps === undefined) return undefined

      const now = ((body.steps as Record<string, unknown>[] | undefined) ?? []).map((step) => ({
        function: current.functions.find((f) => f.id === step.function)?.name,
        fadeIn: step.fadeIn,
        hold: step.hold,
        fadeOut: step.fadeOut,
      }))
      const target = wanted.steps.map((step) => ({
        function: step.function,
        fadeIn: step.fadeIn ?? 0,
        hold: step.hold ?? 0,
        fadeOut: step.fadeOut ?? 0,
      }))

      if (same(now, target)) return undefined

      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: `${target.length} pasos`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          const live = await client.get<{ steps?: unknown[] }>(`/functions/${id}/body`)
          // Un paso no tiene identidad propia: reconciliarlos uno a uno sería
          // inventársela. Se rehacen enteros, y solo cuando difieren.
          for (let index = (live.steps?.length ?? 0) - 1; index >= 0; index--) {
            await client.delete(`/functions/${id}/steps/${index}`)
          }
          for (const step of wanted.steps ?? []) {
            await client.post(`/functions/${id}/steps`, {
              function: await resolver.functionId(step.function),
              fadeIn: step.fadeIn ?? 0,
              hold: step.hold ?? 0,
              fadeOut: step.fadeOut ?? 0,
            })
          }
        },
      }
    }

    case 'Collection': {
      if (wanted.members === undefined) return undefined

      const now = ((body.members as { function: number }[] | undefined) ?? [])
        .map((member) => current.functions.find((f) => f.id === member.function)?.name)
        .filter((name): name is string => name !== undefined)

      if (same(now, wanted.members)) return undefined

      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: `${wanted.members.length} miembros`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          const ids = await Promise.all(
            (wanted.members ?? []).map((name) => resolver.functionId(name)),
          )
          await client.put(`/functions/${id}/members`, { functions: ids })
        },
      }
    }

    case 'Script': {
      if (wanted.data === undefined || body.data === wanted.data) return undefined
      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: `${wanted.data.split('\n').length} líneas`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          await client.put(`/functions/${id}/body`, { data: wanted.data })
        },
      }
    }

    case 'Audio': {
      if (wanted.source === undefined) return undefined
      if (
        body.source === wanted.source &&
        (wanted.volume === undefined || body.volume === wanted.volume)
      ) {
        return undefined
      }
      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: wanted.source,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          const payload: Record<string, unknown> = { source: wanted.source }
          if (wanted.volume !== undefined) payload.volume = wanted.volume
          if (wanted.device !== undefined) payload.device = wanted.device
          await client.put(`/functions/${id}/body`, payload)
        },
      }
    }

    case 'EFX': {
      if (wanted.algorithm === undefined && wanted.heads === undefined) return undefined

      const nowHeads = ((body.heads as { fixture: number; head: number }[] | undefined) ?? []).map(
        (head) => ({
          fixture: current.fixtures.find((f) => f.id === head.fixture)?.name,
          head: head.head || undefined,
        }),
      )
      const targetHeads = (wanted.heads ?? []).map((head) => ({
        fixture: head.fixture,
        head: head.head,
      }))

      const settled =
        (wanted.algorithm === undefined || body.algorithm === wanted.algorithm) &&
        same(nowHeads, targetHeads) &&
        (wanted.geometry === undefined || same(body.geometry, wanted.geometry))
      if (settled) return undefined

      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: `${wanted.algorithm ?? 'figura'} sobre ${targetHeads.length} cabezas`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          const payload: Record<string, unknown> = {}
          if (wanted.algorithm !== undefined) payload.algorithm = wanted.algorithm
          if (wanted.geometry !== undefined) payload.geometry = wanted.geometry
          if (wanted.propagation !== undefined) payload.propagation = wanted.propagation
          if (wanted.heads !== undefined) {
            // Ids pelados: es lo que acepta la ruta. El detalle por cabeza
            // —offset, sentido, modo— se lee pero no se escribe por aquí, así
            // que el documento lo lleva para que se vea y no se pierde nada
            // que este camino pudiera poner.
            payload.fixtures = await Promise.all(
              wanted.heads.map(async (head) => (await resolver.fixture(head.fixture)).id),
            )
          }
          await client.put(`/functions/${id}/body`, payload)
        },
      }
    }

    case 'RGBMatrix': {
      if (wanted.group === undefined && wanted.algorithm === undefined) return undefined

      const nowGroup =
        typeof body.fixtureGroup === 'number'
          ? current.groups.find((g) => g.id === body.fixtureGroup)?.name
          : undefined

      const settled =
        (wanted.group === undefined || nowGroup === wanted.group) &&
        (wanted.algorithm === undefined || body.algorithm === wanted.algorithm) &&
        (wanted.colors === undefined || same(body.colors, wanted.colors))
      if (settled) return undefined

      return {
        section: 'functions',
        kind,
        name: wanted.name,
        detail: `${wanted.algorithm ?? 'algoritmo'} sobre "${wanted.group ?? nowGroup ?? '?'}"`,
        run: async (resolver) => {
          const id = await resolver.functionId(wanted.name)
          const payload: Record<string, unknown> = {}
          if (wanted.group !== undefined) {
            payload.fixtureGroup = (await resolver.group(wanted.group)).id
          }
          if (wanted.algorithm !== undefined) payload.algorithm = wanted.algorithm
          if (wanted.colors !== undefined) payload.colors = wanted.colors
          await client.put(`/functions/${id}/body`, payload)
        },
      }
    }

    default:
      // Show y lo que venga: se aplica la función, no su cuerpo. Una timeline
      // son posiciones absolutas que no se reconcilian por nombre sin
      // inventarle una identidad a cada barra.
      return undefined
  }
}

function planStartup(
  client: OrchidClient,
  spec: ShowSpec,
  current: Current,
  actions: Action[],
): void {
  if (!spec.project || !('startupFunction' in spec.project)) return

  const wanted = spec.project.startupFunction ?? null
  const now =
    current.startupFunction >= 0
      ? (current.functions.find((f) => f.id === current.startupFunction)?.name ?? null)
      : null

  if (wanted === now) return

  actions.push({
    section: 'project',
    kind: 'update',
    name: 'función de arranque',
    detail: wanted ?? 'ninguna',
    run: async (resolver) => {
      const id = wanted === null ? -1 : await resolver.functionId(wanted)
      await client.patch('/project', { startupFunction: id })
    },
  })
}

/**
 * Los widgets se casan por (tipo, caption) dentro de su marco, que es la
 * identidad que tienen para una persona: en una consola no hay dos botones
 * «Azul» en el mismo sitio, y si los hay, tampoco sabe nadie cuál es cuál
 * mirándola.
 *
 * Los hijos de un widget que este lote acaba de crear se resuelven en la
 * siguiente pasada. Aplicar dos veces es barato y no hace nada de más;
 * adivinar ids que el motor todavía no ha repartido no es ninguna de las dos
 * cosas, y el plan lo dice en el detalle de la acción.
 */
async function planConsole(client: OrchidClient, widgets: WidgetSpec[]): Promise<Action[]> {
  let root: Record<string, unknown>
  try {
    root = await client.get<Record<string, unknown>>('/vc')
  } catch {
    // Un proyecto sin Virtual Console contesta 404, y eso no es un fallo.
    return []
  }

  // Los enlaces se resuelven en el plan, no al correr: un plan que dice «voy a
  // tocar esto» y luego no lo toca es un plan con el que no se puede decidir
  // si aplicar. Las referencias ya se comprobaron en checkReferences, así que
  // lo único que puede faltar aquí es una función que este lote crea -- y esa
  // se resuelve en la pasada siguiente, igual que los hijos.
  const functionId = new Map((await client.functions()).map((f) => [f.name, f.id]))
  const fixtureId = new Map((await client.fixtures()).map((f) => [f.name, f.id]))
  const channels = await ChannelNames.of(
    client,
    flatten(widgets)
      .flatMap((widget) => widget.levelChannels ?? [])
      .map((entry) => fixtureId.get(entry.fixture))
      .filter((id): id is number => id !== undefined),
  )

  const body = (widget: WidgetSpec): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const put = (key: string, value: unknown) => {
      if (value !== undefined) out[key] = value
    }

    put('caption', widget.caption)
    put('functionId', widget.functionId ? functionId.get(widget.functionId) : undefined)
    put('chaserId', widget.chaserId ? functionId.get(widget.chaserId) : undefined)
    put('action', widget.action)
    put('sliderMode', widget.sliderMode)
    put('background', widget.background)
    put('foreground', widget.foreground)
    put('font', widget.font)
    put('page', widget.page)
    put('pages', widget.pages)
    put('geometry', widget.geometry)
    put('input', widget.input)

    if (widget.levelChannels !== undefined) {
      out.levelChannels = widget.levelChannels
        .map((entry) => {
          const id = fixtureId.get(entry.fixture)
          if (id === undefined) return undefined
          const channel = channels.read(id, entry.channel)
          return channel === undefined ? undefined : { fixture: id, channel }
        })
        .filter((entry) => entry !== undefined)
    }

    return out
  }

  const actions: Action[] = []
  const key = (type: unknown, caption: unknown) => `${String(type)} ${String(caption ?? '')}`

  const walk = (
    wanted: WidgetSpec[],
    existing: Record<string, unknown>[],
    parentId: number,
    path: string,
  ) => {
    const byKey = new Map(existing.map((child) => [key(child.type, child.caption), child]))

    for (const widget of wanted) {
      const here = `${path}/${widget.caption ?? widget.type}`
      const found = byKey.get(key(widget.type, widget.caption))
      const wantedBody = body(widget)

      if (found === undefined) {
        const pending = (widget.children ?? []).length
        actions.push({
          section: 'console',
          kind: 'create',
          name: here,
          detail:
            pending > 0 ? `${widget.type}; sus ${pending} hijos, al volver a aplicar` : widget.type,
          run: async () => {
            const created = await client.post<{ id: number }>('/vc/widgets', {
              type: widget.type,
              parent: parentId,
            })
            await client.patch(`/vc/widgets/${created.id}`, wantedBody)
          },
        })
        continue
      }

      const changes = Object.fromEntries(
        Object.entries(wantedBody).filter(([field, value]) => !same(found[field], value)),
      )

      if (Object.keys(changes).length > 0) {
        const id = found.id as number
        actions.push({
          section: 'console',
          kind: 'update',
          name: here,
          detail: Object.keys(changes).join(', '),
          run: async () => {
            await client.patch(`/vc/widgets/${id}`, changes)
          },
        })
      }

      if (widget.children?.length) {
        walk(
          widget.children,
          (found.children as Record<string, unknown>[] | undefined) ?? [],
          found.id as number,
          here,
        )
      }
    }
  }

  walk(
    widgets,
    (root.children as Record<string, unknown>[] | undefined) ?? [],
    root.id as number,
    '',
  )

  return actions
}

/* ---- aplicar ---------------------------------------------------------- */

async function patchUniverse(
  client: OrchidClient,
  id: number,
  wanted: {
    name: string
    output?: unknown
    input?: unknown
    feedback?: unknown
    passthrough?: boolean
  },
) {
  const body: Record<string, unknown> = { name: wanted.name }
  // Un plugin vacío desconecta, que es lo que significa un null en el documento.
  if ('output' in wanted) body.output = wanted.output ?? { plugin: '' }
  if ('input' in wanted) body.input = wanted.input ?? { plugin: '' }
  if ('feedback' in wanted) body.feedback = wanted.feedback ?? { plugin: '' }
  if (wanted.passthrough !== undefined) body.passthrough = wanted.passthrough
  await client.patch(`/universes/${id}`, body)
}

/** El anillo de undo del daemon guarda esto, y ni una más. */
const UNDO_RING = 200

/**
 * Cuántas entradas hay en el anillo.
 *
 * Se cuentan las entradas, no se lee `undo`: ese campo es un BOOLEANO —si queda
 * algo que deshacer—, y restarle el de antes da un número que parece razonable
 * y no significa nada. (El `/vc/history` de la consola sí cuenta con enteros.
 * No son lo mismo, y eso ya costó una cifra inventada en este mismo informe.)
 */
async function undoDepth(client: OrchidClient): Promise<number> {
  try {
    return (await client.get<{ entries: unknown[] }>('/history')).entries.length
  } catch {
    return 0
  }
}

export async function applySpec(
  client: OrchidClient,
  spec: ShowSpec,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  const { actions, problems } = await planApply(client, spec, options)
  if (problems.length > 0) throw new SpecError(problems)

  const report: ApplyReport = {
    dryRun: options.dryRun === true,
    actions: actions.map(({ section, kind, name, detail }) =>
      detail === undefined ? { section, kind, name } : { section, kind, name, detail },
    ),
    created: actions.filter((a) => a.kind === 'create').length,
    updated: actions.filter((a) => a.kind === 'update').length,
    deleted: actions.filter((a) => a.kind === 'delete').length,
    undoSteps: 0,
    undoOverflowed: false,
  }

  if (options.dryRun) return report

  const before = await undoDepth(client)
  const resolver = new Resolver(client)

  for (const [index, action] of actions.entries()) {
    try {
      await action.run(resolver)
      // Lo que se acaba de crear tiene un id que nadie sabía hace un momento.
      if (action.kind !== 'update') resolver.invalidate()
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new SpecError([
        `${action.section}: "${action.name}" falló — ${reason}`,
        [
          `Se aplicaron ${index} de ${actions.length} acciones, así que el proyecto está a medias.`,
          'Deshaz con POST /api/v1/undo, o arregla el documento y vuelve a aplicarlo:',
          'es idempotente, así que lo que ya se hizo no se repite.',
        ].join(' '),
      ])
    }
  }

  const depth = await undoDepth(client)
  report.undoSteps = Math.max(0, depth - before)
  // El anillo lleno después de un lote que lo llena significa que se comió su
  // propio principio: lo de antes ya no está.
  report.undoOverflowed = depth >= UNDO_RING && actions.length > UNDO_RING - before

  if (options.save) report.savedTo = (await client.save()).path

  return report
}
