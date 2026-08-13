import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
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
