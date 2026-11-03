import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { type Plugin, defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const ICON = resolve(here, '../resources/icons/svg/orchidlights.svg')

/* The declarative document engine lives in mcp/, where the MCP server and
   orchidctl use it, and the assistant runs it in the browser. Imported from
   there rather than copied: two copies of an applier are two appliers, and
   only one of them is the one CI checks as a fixed point. */
const MCP = resolve(here, '../mcp/src')

/**
 * The app icon, taken from the one the desktop entry and the AppImage use.
 *
 * Copied at build time rather than kept in public/, because two copies of an
 * icon are two icons: the one that gets redrawn and the one that quietly stops
 * matching it.
 */
function appIcon(): Plugin {
  return {
    name: 'orchid-app-icon',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'icon.svg',
        source: readFileSync(ICON, 'utf8'),
      })
    },
    configureServer(server) {
      server.middlewares.use('/icon.svg', (_request, response) => {
        response.setHeader('Content-Type', 'image/svg+xml')
        response.end(readFileSync(ICON))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), appIcon()],
  resolve: {
    alias: { '@orchid/mcp': MCP },
  },
  build: {
    // The daemon serves these; keeping them flat makes the install rule simple.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // The engine is outside the app's root; the dev server serves it anyway.
    fs: { allow: [here, MCP] },
    // During development Vite serves the app and the daemon serves the data.
    proxy: {
      '/api': 'http://127.0.0.1:9998',
      '/ws': { target: 'ws://127.0.0.1:9998', ws: true },
    },
  },
  test: {
    /* Two kinds of test, told apart by extension: .test.ts is pure logic and
       runs on bare node; .test.tsx renders components and gets a DOM. The
       split keeps the fast half fast -- jsdom boots in hundreds of
       milliseconds that geometry math does not owe anybody. */
    environment: 'node',
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    setupFiles: ['src/test-setup.ts'],
  },
})
