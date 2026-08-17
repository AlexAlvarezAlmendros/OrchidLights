import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { type Plugin, defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const ICON = resolve(here, '../resources/icons/svg/orchidlights.svg')

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
  build: {
    // The daemon serves these; keeping them flat makes the install rule simple.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // During development Vite serves the app and the daemon serves the data.
    proxy: {
      '/api': 'http://127.0.0.1:9998',
      '/ws': { target: 'ws://127.0.0.1:9998', ws: true },
    },
  },
  test: {
    environment: 'node',
  },
})
