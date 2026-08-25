/**
 * Mounting the whole App in jsdom.
 *
 * These tests are about what the operator sees at boot and what the feed does
 * to the screen: the rail obeying the access mask, deep routes landing on the
 * right view, a rejected command surfacing as a toast, and a remote arrival
 * NOT dressing the project as unsaved. The daemon is a fetch stub and the
 * feed is a fake Live that lets each test pull the strings by hand.
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

/* The fake feed keeps every handler bag the App registers, so a test can play
   daemon: fire onError, onRemote, onProject and watch the screen react. */
const feed = vi.hoisted(() => ({
  handlers: [] as import('./live').LiveHandlers[],
}))

vi.mock('./live', () => {
  class Live {
    constructor(private readonly h: import('./live').LiveHandlers) {
      feed.handlers.push(h)
    }
    /* The real socket answers with a hello; going straight to 'open' is the
       same observable outcome without a WebSocket in the room. */
    connect(): void {
      this.h.onConnection('open')
    }
    close(): void {}
    send(): void {}
    toggle(): void {}
    flash(): void {}
    setFramePage(): void {}
    cuelistSideFader(): void {}
    setSpeedDial(): void {}
    setSlider(): void {}
    setChannelGroup(): void {}
    setAudioTriggers(): void {}
    setMatrixPreset(): void {}
    setPad(): void {}
    cuelist(): void {}
    subscribe(): void {}
    unsubscribe(): void {}
  }
  return { Live }
})

/** The access mask with every door open, the daemon's default on loopback. */
const openAccess = () => ({
  fixtures: true,
  functions: true,
  vcControl: true,
  vcEditing: true,
  simpleDesk: true,
  show: true,
  io: true,
})

/* A minimal but honest console: one page (the root itself), one button. */
const vcRoot = {
  type: 'virtualconsole',
  id: 0,
  geometry: { x: 0, y: 0, width: 1920, height: 1080 },
  children: [
    {
      type: 'button',
      id: 10,
      caption: 'ROJO',
      functionId: 1,
      geometry: { x: 0, y: 0, width: 120, height: 60 },
    },
  ],
}

/** Everything App and its header dock ask the daemon for at boot. */
const BOOT: Record<string, unknown> = {
  '/api/v1/status': {
    name: 'orchid',
    version: '0.1.0',
    apiVersion: 1,
    fixtures: 0,
    functions: 1,
    universes: 1,
    runningFunctions: 0,
    outputPlugins: [],
    blackout: false,
  },
  '/api/v1/access': openAccess(),
  '/api/v1/project': {
    name: 'Prueba.qxw',
    path: '/shows/Prueba.qxw',
    directory: '/shows',
    modified: false,
  },
  '/api/v1/functions': [{ id: 1, name: 'Roja', type: 'Scene', running: false }],
  '/api/v1/vc': vcRoot,
  '/api/v1/layout': { pages: [] },
  '/api/v1/fixtures': [],
  '/api/v1/grandmaster': {
    value: 255,
    channelMode: 'Intensity',
    valueMode: 'Reduce',
    visible: false,
  },
  '/api/v1/dump': { count: 0, bare: 0, groups: [] },
  '/api/v1/history': { entries: [], undo: false, redo: false },
  '/api/v1/beat': { source: 'internal', bpm: 120 },
  '/api/v1/remote': {
    listenAll: false,
    port: 9998,
    authRequired: false,
    localUrl: 'http://127.0.0.1:9998',
    addresses: [],
    clients: [],
  },
  '/api/v1/universes': [],
  '/api/v1/simpledesk/1': { universe: 1, held: {} },
}

function asResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

/** Route table in, fetch stub out. Unknown paths answer 404 with an error
 *  body naming the path, so a request the test forgot fails legibly. */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const routes = { ...BOOT, ...overrides }
  const stub = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const path =
      String(input)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0] ?? ''
    if (path in routes) return Promise.resolve(asResponse(routes[path], 200))
    return Promise.resolve(asResponse({ error: `ruta sin stub: ${path}` }, 404))
  })
  vi.stubGlobal('fetch', stub)
  return stub
}

/** Boot is done when the feed chip says live. The console's own widgets only
 *  exist on the console view, so waiting for them here would deadlock the
 *  deep-route tests. */
async function mountApp() {
  render(<App />)
  await screen.findByText('en vivo')
  const handlers = feed.handlers[0]
  if (handlers === undefined) throw new Error('App never opened the feed')
  return handlers
}

beforeEach(() => {
  feed.handlers.length = 0
  // Theme, operator mode and scale persist on purpose; a test must not
  // inherit the previous test's operator lock.
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App at boot', () => {
  it('mounts, shows the project name and paints the console', async () => {
    await mountApp()

    // The show bar names the show, without the file extension nobody says
    // out loud.
    expect(await screen.findByText('Prueba')).toBeInTheDocument()

    // The rail offers the console, and the console drew the project's button.
    expect(screen.getByRole('button', { name: 'Consola' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'ROJO' })).toBeInTheDocument()

    // Nothing went wrong on the way up.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('strips the rail down to what the access mask allows', async () => {
    stubFetch({
      '/api/v1/access': {
        fixtures: false,
        functions: false,
        vcControl: true,
        vcEditing: false,
        simpleDesk: false,
        show: false,
        io: false,
      },
    })
    await mountApp()

    /* The mask arrives async, after a first paint with the optimistic
       defaults -- so the assertion is that the doors CLOSE, not that they
       never appeared. */
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Funciones' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Patch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mesa' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Planta' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Escenario' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remoto' })).not.toBeInTheDocument()

    // The console is the one screen a mask can never take away.
    expect(screen.getByRole('button', { name: 'Consola' })).toBeInTheDocument()
  })
})

describe('deep routes', () => {
  it('#/remoto opens the remote screen', async () => {
    window.history.replaceState(null, '', '/#/remoto')
    await mountApp()

    expect(screen.getByRole('button', { name: 'Remoto' })).toHaveAttribute('aria-pressed', 'true')
    // The panel itself, not just the highlighted rail item.
    expect(await screen.findByText('Acceso desde la red')).toBeInTheDocument()
  })

  it('#/mesa opens the simple desk', async () => {
    window.history.replaceState(null, '', '/#/mesa')
    const fetchStub = stubFetch()
    await mountApp()

    expect(screen.getByRole('button', { name: 'Mesa' })).toHaveAttribute('aria-pressed', 'true')
    // The desk seeds what it holds from the daemon: the request is the
    // observable proof the desk view actually came up.
    await waitFor(() => {
      const asked = fetchStub.mock.calls.map((call) => String(call[0]))
      expect(asked).toContain('/api/v1/simpledesk/1')
    })
  })
})

describe('the live feed on screen', () => {
  it('surfaces a daemon error as a toast', async () => {
    const handlers = await mountApp()

    await act(async () => {
      handlers.onError?.('La mesa rechazó la orden: función 99 no existe')
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'La mesa rechazó la orden: función 99 no existe',
    )
  })

  it('does not mark the project unsaved when a remote client arrives', async () => {
    const handlers = await mountApp()

    /* An arrival is not an edit: the remote event must bump the remote
       screen's revision and nothing else. */
    await act(async () => {
      handlers.onRemote?.(2)
    })

    expect(screen.queryByText(/sin guardar/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument()

    /* The positive control: the project event is exactly what flips the
       flag, so the machinery the first half relies on demonstrably works. */
    await act(async () => {
      handlers.onProject?.(true, 'Prueba.qxw')
    })

    expect(await screen.findByText(/sin guardar/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeInTheDocument()
  })
})
