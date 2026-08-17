import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

/* Installed to a home screen, the app opens without browser chrome -- which on
 * a phone taped to a truss is the difference between a console and a web page
 * somebody can navigate away from.
 *
 * Registered after load so it never competes with the first paint, and only
 * where the browser has one: this is a progressive enhancement, and the app
 * works identically without it. See public/sw.js for what it deliberately does
 * not cache. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* No service worker is a browser that will not install the app, not a
         broken one. Nothing here depends on it. */
    })
  })
}
