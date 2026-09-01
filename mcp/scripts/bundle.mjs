/**
 * El servidor MCP y el CLI, cada uno en un fichero.
 *
 * Es lo que viaja dentro del paquete de escritorio. Un `node_modules` de
 * producción son 25 MB de árbol que hay que copiar entero y que se rompe si
 * falta un enlace; el bundle es **un megabyte y un fichero**, y un fichero no
 * se copia a medias.
 *
 * Formato ESM y `platform: node`: esto no corre en un navegador, corre en el
 * Node que encuentre el lanzador, y los módulos internos (`node:fs`, `node:os`)
 * se dejan fuera a propósito.
 *
 *   node scripts/bundle.mjs
 */

import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'dist', 'bundle')
mkdirSync(out, { recursive: true })

const targets = [
  { entry: 'src/mcp.ts', file: 'orchidlights-mcp.mjs' },
  { entry: 'src/cli.ts', file: 'orchidctl.mjs' },
]

for (const target of targets) {
  await build({
    entryPoints: [join(here, '..', target.entry)],
    outfile: join(out, target.file),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    banner: {
      // Dos cosas en la cabecera:
      //
      // El shebang de los fuentes se pierde al empaquetar, y no hace falta: los
      // lanza `node` desde el lanzador, no el kernel.
      //
      // Y `require`, que en un bundle ESM no existe. Alguna dependencia trae su
      // build CommonJS y llama a `require('process')` cuando ya está corriendo;
      // sin esto el bundle carga, lista las herramientas, y revienta en la
      // primera que use YAML. `createRequire` es la puerta que ESM deja abierta
      // justo para esto.
      js: [
        '// Generado por scripts/bundle.mjs — no editar a mano.',
        "import { createRequire as __nodeRequire } from 'node:module'",
        'const require = __nodeRequire(import.meta.url)',
      ].join('\n'),
    },
    logLevel: 'warning',
  })

  const size = statSync(join(out, target.file)).size
  console.log(`${target.file}  ${(size / 1024).toFixed(0)} KB`)
}
