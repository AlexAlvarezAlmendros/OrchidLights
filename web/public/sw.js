/**
 * The service worker, and what it deliberately does not do.
 *
 * This is a lighting desk. The daemon *is* the desk: without it there is
 * nothing to control, so making the app "work offline" would be a lie told in
 * the one place where being believed matters. Nothing under /api or /ws is ever
 * cached, and no response to a command is ever served from a cache.
 *
 * What it is for: the app installs to a home screen and opens without browser
 * chrome, and the shell loads instantly instead of over a venue's wifi. The
 * shell is fetched network-first so a daemon upgrade is picked up on the next
 * load rather than whenever the cache happens to expire -- a console running
 * last week's bundle against this week's API is a console that fails in ways
 * nobody can reproduce.
 */

const SHELL = 'orchid-shell-v1'

self.addEventListener('install', (event) => {
  // The shell only. Hashed assets are added as they are used.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add('/')))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Never the API, never the feed, never anything on another host.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return
  if (event.request.method !== 'GET') return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Keep what came back, so the next cold start is instant.
        if (response.ok) {
          const copy = response.clone()
          caches.open(SHELL).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(event.request)
        if (cached) return cached

        // For a navigation, the shell: it loads and then says plainly that it
        // cannot reach the daemon, which is the truth and is more use than a
        // browser error page.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/')
          if (shell) return shell
        }

        throw new Error('offline')
      }),
  )
})
