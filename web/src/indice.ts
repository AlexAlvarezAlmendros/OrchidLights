/**
 * The project, told in a few thousand tokens.
 *
 * The wedding exported as a document is 210 KB -- some 60k tokens, 99% of
 * them scene values. Handing that to a model on every turn is slow and dear,
 * and most turns need none of it: to add a button it is enough to know which
 * frames exist and what the functions are called. So the assistant starts
 * from this outline and asks for the whole of one thing (`ver`) when it needs
 * it.
 *
 * Plain text rather than JSON: the same facts in a third of the tokens, and
 * read the way a person reads a cue sheet.
 */

import type { OrchidClient } from '@orchid/mcp/client'

/** A Virtual Console node as GET /vc returns it, the fields the outline uses. */
interface VcNode {
  type: string
  caption?: string
  functionId?: number
  chaserId?: number
  action?: string
  background?: string
  children?: VcNode[]
}

const NO_FUNCTION = 4294967295

function endpoint(p?: { plugin?: string; line?: string; output?: string; profile?: string }) {
  if (!p?.plugin) return null
  const line = p.line ?? p.output
  return `${p.plugin}${line ? `/${line}` : ''}${p.profile ? ` (perfil ${p.profile})` : ''}`
}

export async function outline(client: OrchidClient): Promise<string> {
  const [project, fixtures, functions, universes, plan, groups, vc] = await Promise.all([
    client.project(),
    client.fixtures(),
    client.functions(),
    client.universes(),
    client.plan(),
    client.fixtureGroups(),
    /* A project with no console answers 404; that is an empty console, not an
       error worth stopping the outline for. */
    client
      .get<VcNode>('/vc')
      .catch(() => null),
  ])

  const lines: string[] = []
  lines.push(`Proyecto «${project.name}»${project.modified ? ' · con cambios sin guardar' : ''}`)

  const g = plan.grid
  lines.push(`Escenario: ${g.width} × ${g.depth} × ${g.height} ${g.units} (ancho × fondo × alto)`)

  lines.push('', `Universos (${universes.length}):`)
  for (const u of universes) {
    const out = (u.outputs ?? []).map(endpoint).filter(Boolean).join(', ')
    const parts = [
      out ? `salida ${out}` : 'sin salida',
      endpoint(u.input) ? `entrada ${endpoint(u.input)}` : null,
      endpoint(u.feedback) ? `retorno ${endpoint(u.feedback)}` : null,
    ].filter(Boolean)
    lines.push(`- ${u.id} «${u.name}» · ${parts.join(' · ')}`)
  }

  const placed = new Map(plan.fixtures.map((f) => [f.id, f]))
  const fixtureName = new Map(fixtures.map((f) => [f.id, f.name]))
  lines.push('', `Fixtures (${fixtures.length}):`)
  for (const f of fixtures) {
    const last = f.address + f.channels - 1
    const where = placed.get(f.id)
    const stage =
      where && where.x !== undefined
        ? ` · en x=${where.x} y=${where.y ?? 0} z=${where.z ?? 0}${where.rotation ? ` giro ${where.rotation}°` : ''}${where.invertTilt ? ' colgado' : ''}`
        : ' · sin colocar'
    const model =
      f.manufacturer && f.model ? `${f.manufacturer} ${f.model} · ${f.mode ?? '?'}` : 'genérico'
    lines.push(
      `- «${f.name}» · ${model} · ${f.channels} canales · U${f.universe} @${f.address}-${last}${stage}${f.resolved === false ? ' · PERFIL NO ENCONTRADO' : ''}`,
    )
  }

  if (groups.length > 0) {
    lines.push('', `Grupos (${groups.length}):`)
    for (const group of groups) {
      const members = (group.fixtures ?? []).map((id) => fixtureName.get(id) ?? `#${id}`)
      lines.push(`- «${group.name}»: ${members.join(', ')}`)
    }
  }

  const functionName = new Map(functions.map((f) => [f.id, f.name]))
  lines.push('', `Funciones (${functions.length}), por carpeta:`)
  const byPath = new Map<string, string[]>()
  for (const f of functions) {
    const path = f.path || '(raíz)'
    const list = byPath.get(path) ?? []
    list.push(`${f.name} [${f.type}${f.running ? ', CORRIENDO' : ''}]`)
    byPath.set(path, list)
  }
  for (const [path, names] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${path}: ${names.join(' · ')}`)
  }

  lines.push('', 'Consola:')
  if (vc === null || (vc.children ?? []).length === 0) {
    lines.push('- (vacía)')
  } else {
    const walk = (nodes: VcNode[], depth: number) => {
      for (const node of nodes) {
        const target = node.functionId ?? node.chaserId
        const bits = [
          `${'  '.repeat(depth)}- [${node.type}] «${node.caption ?? ''}»`,
          /* "No function" is -1 to the engine and 4294967295 once it has been
             through an unsigned id: neither is a function to name. */
          target !== undefined && target >= 0 && target < NO_FUNCTION
            ? `→ ${functionName.get(target) ?? `#${target}`}`
            : null,
          /* Toggle is what a button does unless told otherwise: said only when
             it is something else. The engine capitalises; the API does not. */
          node.action && node.action.toLowerCase() !== 'toggle' ? `(${node.action})` : null,
          node.background ? node.background : null,
        ].filter(Boolean)
        lines.push(bits.join(' '))
        walk(node.children ?? [], depth + 1)
      }
    }
    walk(vc.children ?? [], 0)
  }

  return lines.join('\n')
}
