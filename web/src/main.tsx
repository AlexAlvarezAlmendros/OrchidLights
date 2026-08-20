import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { adoptTokenFromLocation } from './token'
import './theme.css'

/* Before anything renders or fetches: a token handed over in the fragment must
   be adopted and scrubbed before the first request goes out and before anyone
   can read it off the address bar. */
adoptTokenFromLocation()

/* And again if a handover link lands on a page that is already open -- pasting
   /#token=... into a running tab changes only the hash, which reloads nothing
   by itself. Adopting implies reloading: every request in flight has to retry
   with the new token, and boot already knows the order. */
window.addEventListener('hashchange', () => {
  if (window.location.hash.includes('token=') === false) return
  adoptTokenFromLocation()
  window.location.reload()
})

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
