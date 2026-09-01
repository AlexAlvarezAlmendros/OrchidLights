#!/usr/bin/env node
/**
 * orchidctl — la mesa desde una shell.
 *
 * Un agente de Claude Code o de OpenCode vive en una shell y ya sabe usarla, así
 * que lo que más le sirve no es una API: es un comando que hace una cosa y la
 * cuenta en una línea que se puede leer.
 *
 * Sale con 0 si funcionó y con 1 si no, y lo que va a stdout es lo que se puede
 * encadenar; lo demás va a stderr.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { OrchidClient, OrchidError } from './client.js'
import { SpecError, applySpec } from './spec/apply.js'
import { exportSpec } from './spec/export.js'
import type { ShowSpec } from './spec/types.js'

const USAGE = `orchidctl — la mesa OrchidLights desde una shell

  orchidctl status                    qué mesa es y qué está corriendo
  orchidctl export [-o fichero]       el proyecto como documento declarativo
  orchidctl apply <fichero>           llevar el proyecto a lo que dice el documento
  orchidctl diff <fichero>            qué haría un apply, sin hacerlo
  orchidctl dmx [universo]            lo que sale ahora mismo, canal a canal
  orchidctl run <nombre>              arrancar una función
  orchidctl stop [nombre]             pararla; sin nombre, para todo
  orchidctl blackout [on|off]         a oscuras, y de vuelta
  orchidctl library <busqueda>        buscar en los 1.735 perfiles
  orchidctl library <fabricante> <modelo>    sus modos y sus canales
  orchidctl save                      escribir el proyecto al disco
  orchidctl undo | redo               deshacer la última edición

Opciones

  --url <url>       dónde escucha la mesa (o $ORCHID_URL)
  --token <token>   el token (o $ORCHID_TOKEN, o ~/.orchidlights/api-token)
  --console         incluir la Virtual Console en export
  --prune           en apply, borrar lo que el documento no menciona
  --save            en apply, guardar al terminar
  --json            sacar JSON en vez de prosa
`

interface Flags {
  url?: string | undefined
  token?: string | undefined
  out?: string | undefined
  console: boolean
  prune: boolean
  save: boolean
  json: boolean
  all: boolean
}

function parseArgs(argv: string[]): { command: string; rest: string[]; flags: Flags } {
  const flags: Flags = {
    console: false,
    prune: false,
    save: false,
    json: false,
    all: false,
  }
  const rest: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string
    switch (argument) {
      case '--url':
        flags.url = argv[++index]
        break
      case '--token':
        flags.token = argv[++index]
        break
      case '-o':
      case '--out':
        flags.out = argv[++index]
        break
      case '--console':
        flags.console = true
        break
      case '--prune':
        flags.prune = true
        break
      case '--save':
        flags.save = true
        break
      case '--json':
        flags.json = true
        break
      case '--all':
        flags.all = true
        break
      default:
        rest.push(argument)
    }
  }

  return { command: rest.shift() ?? '', rest, flags }
}

/**
 * El token, sin que haya que teclearlo.
 *
 * En loopback no hace falta ninguno, así que leer el fichero y no encontrarlo
 * no es un problema: es el caso normal.
 */
function findToken(explicit: string | undefined): string | undefined {
  if (explicit) return explicit
  if (process.env.ORCHID_TOKEN) return process.env.ORCHID_TOKEN
  try {
    return readFileSync(join(homedir(), '.orchidlights', 'api-token'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function connect(flags: Flags): OrchidClient {
  const options: { baseUrl?: string; token?: string } = {}
  const url = flags.url ?? process.env.ORCHID_URL
  if (url) options.baseUrl = url
  const token = findToken(flags.token)
  if (token) options.token = token
  return new OrchidClient(options)
}

function out(flags: Flags, human: () => void, data: unknown) {
  if (flags.json) console.log(JSON.stringify(data, null, 2))
  else human()
}

/** Una función por nombre, diciendo cuáles hay cuando no está. */
async function findFunction(client: OrchidClient, name: string) {
  const functions = await client.functions()
  const exact = functions.find((fn) => fn.name === name)
  if (exact) return exact

  const near = functions.filter((fn) => fn.name.toLowerCase().includes(name.toLowerCase()))
  if (near.length === 1) return near[0] as (typeof functions)[number]
  if (near.length > 1) {
    throw new Error(
      `"${name}" encaja con ${near.length}: ${near
        .slice(0, 6)
        .map((fn) => fn.name)
        .join(', ')}`,
    )
  }
  throw new Error(`no hay ninguna función llamada "${name}"`)
}

async function main(): Promise<number> {
  const { command, rest, flags } = parseArgs(process.argv.slice(2))

  if (command === '' || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command === '' ? 1 : 0
  }

  const client = connect(flags)

  switch (command) {
    case 'status': {
      const [discovery, status] = await Promise.all([client.discovery(), client.status()])
      out(
        flags,
        () => {
          const project = discovery.project
          console.log(`${discovery.name} ${discovery.version} · ${client.baseUrl}`)
          console.log(`proyecto: ${project?.name || '(ninguno)'}${project?.modified ? ' *' : ''}`)
          const counts = [
            `${status.fixtures} fixtures`,
            `${status.functions} funciones`,
            `${status.universes} universos`,
            `${status.runningFunctions} corriendo`,
          ]
          if (status.blackout) counts.push('BLACKOUT')
          console.log(counts.join(' · '))
        },
        { ...discovery, ...status },
      )
      return 0
    }

    case 'export': {
      const spec = await exportSpec(client, { console: flags.console })
      const text = flags.json ? JSON.stringify(spec, null, 2) : stringifyYaml(spec)
      if (flags.out) {
        writeFileSync(flags.out, text)
        console.error(
          `escrito ${flags.out}: ${spec.fixtures?.length ?? 0} fixtures, ` +
            `${spec.functions?.length ?? 0} funciones`,
        )
      } else {
        process.stdout.write(text)
      }
      return 0
    }

    case 'apply':
    case 'diff': {
      const file = rest[0]
      if (file === undefined) {
        console.error('falta el fichero. orchidctl apply show.yaml')
        return 1
      }

      const text = readFileSync(file, 'utf8')
      const spec = (file.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as ShowSpec
      const dryRun = command === 'diff'

      const report = await applySpec(client, spec, {
        dryRun,
        prune: flags.prune,
        save: flags.save,
      })

      out(
        flags,
        () => {
          for (const action of report.actions) {
            const mark = action.kind === 'create' ? '+' : action.kind === 'delete' ? '-' : '~'
            const detail = action.detail ? `  ${action.detail}` : ''
            console.log(`${mark} ${action.section.padEnd(14)} ${action.name}${detail}`)
          }
          if (report.actions.length === 0) {
            console.log('nada que hacer: el proyecto ya dice lo que dice el documento')
          } else {
            const verb = dryRun ? 'haría' : 'hechas'
            const saved = report.savedTo ? `\nguardado en ${report.savedTo}` : ''
            console.log(
              `\n${verb}: +${report.created} ~${report.updated} -${report.deleted}${saved}`,
            )
          }
          if (!dryRun && !flags.save && report.actions.length > 0) {
            console.log('en memoria — orchidctl save para escribirlo al disco')
          }
          if (report.undoOverflowed) {
            console.log(
              'el lote no cabe en el anillo de undo (200 entradas): no se puede deshacer entero',
            )
          } else if (report.undoSteps > 0) {
            console.log(`para deshacerlo: orchidctl undo ×${report.undoSteps}`)
          }
        },
        report,
      )
      return 0
    }

    case 'dmx': {
      const universe = Number(rest[0] ?? 1)
      const snapshot = await client.dmx(universe)
      out(
        flags,
        () => {
          if (snapshot.blackout) console.log('BLACKOUT')
          if (snapshot.active.length === 0) {
            console.log(`universo ${universe}: a oscuras`)
            return
          }
          for (const entry of snapshot.active) {
            const who = entry.fixtureName
              ? `${entry.fixtureName} · ${entry.channelName ?? `canal ${entry.channel}`}`
              : `canal ${entry.channel}`
            console.log(
              `${String(entry.channel + 1).padStart(3)}  ${String(entry.value).padStart(3)}  ${who}`,
            )
          }
        },
        snapshot,
      )
      return 0
    }

    case 'run': {
      const name = rest.join(' ')
      if (!name) {
        console.error('falta el nombre. orchidctl run "Azul frontal"')
        return 1
      }
      const fn = await findFunction(client, name)
      await client.post(`/functions/${fn.id}/start`)
      console.log(`arrancando ${fn.name}`)
      return 0
    }

    case 'stop': {
      const name = rest.join(' ')
      if (!name || flags.all) {
        const stopped = await client.post<{ stopping: number }>('/stop')
        console.log(`paradas ${stopped.stopping} funciones`)
        return 0
      }
      const fn = await findFunction(client, name)
      await client.post(`/functions/${fn.id}/stop`)
      console.log(`parando ${fn.name}`)
      return 0
    }

    case 'blackout': {
      const wanted = rest[0] ?? 'on'
      const result =
        wanted === 'off'
          ? await client.delete<{ blackout: boolean }>('/blackout')
          : await client.post<{ blackout: boolean }>('/blackout')
      console.log(result.blackout ? 'a oscuras' : 'vuelve la luz')
      return 0
    }

    case 'library': {
      if (rest.length >= 2) {
        const [manufacturer, ...model] = rest
        const profile = await client.get<{
          manufacturer: string
          model: string
          type: string
          modes: { name: string; channels: number }[]
        }>(
          `/library/${encodeURIComponent(manufacturer as string)}/${encodeURIComponent(model.join(' '))}`,
        )
        out(
          flags,
          () => {
            console.log(`${profile.manufacturer} ${profile.model} · ${profile.type}`)
            for (const mode of profile.modes) {
              console.log(`  ${mode.name}  (${mode.channels} canales)`)
            }
          },
          profile,
        )
        return 0
      }

      const query = rest[0]
      const found = await client.get<{ total: number; manufacturers: string[] }>(
        `/library${query ? `?q=${encodeURIComponent(query)}` : ''}`,
      )
      out(
        flags,
        () => {
          console.log(`${found.manufacturers.length} fabricantes de ${found.total} perfiles`)
          console.log(found.manufacturers.join(', '))
        },
        found,
      )
      return 0
    }

    case 'save': {
      const saved = await client.save()
      console.log(`guardado en ${saved.path}`)
      return 0
    }

    case 'undo':
    case 'redo': {
      const result = await client.post<{ undone?: string; redone?: string }>(`/${command}`)
      console.log(result.undone ?? result.redone ?? 'hecho')
      return 0
    }

    default:
      console.error(`no conozco "${command}".\n`)
      console.error(USAGE)
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof SpecError) {
      console.error('El documento no se puede aplicar:')
      for (const problem of error.problems) console.error(`  · ${problem}`)
    } else if (error instanceof OrchidError) {
      console.error(error.message)
      if (error.status === 0) {
        console.error('¿está el daemon arrancado? orchidlightsd tonight.qxw')
      }
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exitCode = 1
  })
