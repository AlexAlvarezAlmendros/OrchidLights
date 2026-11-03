/**
 * El documento declarativo, de ida y vuelta sobre un proyecto de verdad.
 *
 * Lo que se comprueba es la propiedad de la que cuelga todo lo demás: que un
 * proyecto exportado y vuelto a aplicar sobre una mesa vacía dé el mismo
 * proyecto. Sin eso, exportar y aplicar es una forma elaborada de corromper un
 * show, y nadie debería confiarle uno.
 *
 * Se compara por NOMBRE en los dos lados, nunca por id: los ids los reparte el
 * motor y no tienen por qué coincidir entre dos proyectos, así que compararlos
 * sería exigir algo que ni siquiera es cierto.
 *
 *   node server/test/spec-client.mjs <url-origen> <url-destino>
 */

import { applySpec, exportSpec, OrchidClient, SpecError } from '../../mcp/dist/index.js'

const [sourceUrl, targetUrl] = process.argv.slice(2)
if (!sourceUrl || !targetUrl) {
  console.error('uso: node spec-client.mjs <url-origen> <url-destino>')
  process.exit(2)
}

const source = new OrchidClient({ baseUrl: sourceUrl })
const target = new OrchidClient({ baseUrl: targetUrl })

let failures = 0

function check(what, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

/* ---- ensayar no cambia nada ------------------------------------------- */

const spec = await exportSpec(source, { console: false })
check(
  'el origen se exporta entero',
  spec.fixtures.length > 0 && spec.functions.length > 0,
  `${spec.fixtures.length} fixtures, ${spec.functions.length} funciones`,
)

const before = await target.status()
const rehearsal = await applySpec(target, spec, { dryRun: true })
const after = await target.status()

check(
  'un dry-run propone trabajo',
  rehearsal.actions.length > 0,
  `${rehearsal.actions.length} acciones`,
)
check(
  'y no toca nada: un plan que se aplica solo no es un ensayo',
  after.fixtures === before.fixtures && after.functions === before.functions,
  `${before.fixtures}/${before.functions} → ${after.fixtures}/${after.functions}`,
)

/* ---- un documento malo se rechaza entero ------------------------------ */

const broken = structuredClone(spec)
broken.functions.push({
  name: 'Rota',
  type: 'Scene',
  values: [{ fixture: 'Una lámpara que no existe', channel: 0, value: 255 }],
})

let rejected = false
try {
  await applySpec(target, broken, {})
} catch (error) {
  rejected = error instanceof SpecError && error.problems.join().includes('que no existe')
}
check('un documento que nombra lo que no existe se rechaza', rejected)

const untouched = await target.status()
check(
  'y se rechaza ENTERO: no queda medio show aplicado',
  untouched.fixtures === before.fixtures && untouched.functions === before.functions,
  `${untouched.fixtures} fixtures, ${untouched.functions} funciones`,
)

/* ---- aplicar de verdad ------------------------------------------------ */

const first = await applySpec(target, spec, {})
check(
  'el documento se aplica sin un fallo',
  first.created > 0 && first.deleted === 0,
  `+${first.created} ~${first.updated} -${first.deleted}`,
)

const second = await applySpec(target, spec, { dryRun: true })
check(
  'y aplicarlo otra vez no tiene nada que hacer',
  second.actions.length === 0,
  second.actions.length > 0
    ? second.actions
        .slice(0, 5)
        .map((a) => `${a.kind} ${a.section} ${a.name}`)
        .join('; ')
    : 'idempotente',
)

/* ---- y lo reconstruido es lo mismo ------------------------------------ */

const back = await exportSpec(target, { console: false })

function sameNames(what, mine, theirs, key) {
  const left = new Set(mine.map(key))
  const right = new Set(theirs.map(key))
  const missing = [...left].filter((name) => !right.has(name))
  const extra = [...right].filter((name) => !left.has(name))
  check(
    `${what}: los mismos nombres a los dos lados`,
    missing.length === 0 && extra.length === 0,
    missing.length || extra.length
      ? `faltan ${missing.slice(0, 3).join(', ') || '—'}; sobran ${extra.slice(0, 3).join(', ') || '—'}`
      : `${mine.length}`,
  )
}

sameNames('fixtures', spec.fixtures, back.fixtures, (f) => f.name)
sameNames('funciones', spec.functions, back.functions, (f) => f.name)
sameNames('universos', spec.universes, back.universes, (u) => u.name)

const address = (f) => `${f.name}@U${f.universe}:${f.address}`
sameNames('direcciones DMX', spec.fixtures, back.fixtures, address)

const profile = (f) => `${f.name}: ${f.manufacturer}/${f.model}/${f.mode}`
sameNames('perfiles y modos', spec.fixtures, back.fixtures, profile)

/* Las escenas, valor a valor. Es lo que de verdad hace un show: si esto se
   pierde, el rig se enciende con otros colores y todo lo demás da igual. */
const rebuilt = new Map(back.functions.map((fn) => [fn.name, fn]))
const scenes = spec.functions.filter((fn) => fn.type === 'Scene')
const shape = (fn) =>
  JSON.stringify(
    (fn?.values ?? [])
      .map((value) => [value.fixture, String(value.channel), value.value])
      .sort((a, b) => String(a).localeCompare(String(b))),
  )

const different = scenes.filter((fn) => shape(fn) !== shape(rebuilt.get(fn.name)))
check(
  'las escenas llevan los mismos valores, canal por canal',
  different.length === 0,
  different.length === 0
    ? `${scenes.length} escenas`
    : `distintas: ${different.slice(0, 3).map((fn) => fn.name).join(', ')}`,
)

const chasers = spec.functions.filter((fn) => fn.type === 'Chaser')
const steps = (fn) =>
  JSON.stringify((fn?.steps ?? []).map((step) => [step.function, step.fadeIn, step.hold, step.fadeOut]))
const brokenChasers = chasers.filter((fn) => steps(fn) !== steps(rebuilt.get(fn.name)))
check(
  'los chasers llevan los mismos pasos, en el mismo orden',
  brokenChasers.length === 0,
  brokenChasers.length === 0
    ? `${chasers.length} chasers`
    : `distintos: ${brokenChasers.slice(0, 3).map((fn) => fn.name).join(', ')}`,
)

/* ---- y se deshace entero, de una vez --------------------------------- */

/* El documento son cientos de llamadas, más de las 200 que guarda el anillo.
   Sin lotes se comía su propio principio y no había vuelta atrás; ahora es
   una entrada, que un undo quita entera y un redo devuelve entera. */
check(
  'el documento entero deja UNA entrada de undo',
  first.undoSteps === 1 && first.undoOverflowed === false,
  `${first.undoSteps} entradas para ${first.actions.length} acciones`,
)

const history = await target.get('/history')
const sealed = history.entries.at(-1)
check(
  'y esa entrada lleva dentro más ediciones de las que caben en el anillo',
  (sealed?.edits ?? 0) > 200,
  `${sealed?.edits} ediciones en «${sealed?.label}»`,
)

await target.post('/undo', {})
const undone = await exportSpec(target, { console: false })
check(
  'un solo undo devuelve la mesa a como estaba antes de aplicar',
  undone.fixtures.length === 0 && undone.functions.length === 0,
  `${undone.fixtures.length} fixtures, ${undone.functions.length} funciones`,
)

await target.post('/redo', {})
const redone = await exportSpec(target, { console: false })
const redoneScenes = new Map(redone.functions.map((fn) => [fn.name, fn]))
check(
  'y un solo redo lo trae de vuelta, escenas incluidas valor a valor',
  redone.fixtures.length === spec.fixtures.length
    && redone.functions.length === spec.functions.length
    && scenes.every((fn) => shape(fn) === shape(redoneScenes.get(fn.name))),
  `${redone.fixtures.length} fixtures, ${redone.functions.length} funciones`,
)

console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
