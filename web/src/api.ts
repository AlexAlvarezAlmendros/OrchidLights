/** REST client. Same origin as the page, so no base URL and no CORS. */

export interface FunctionState {
  id: number
  name: string
  type: string
  running: boolean

  /** Chasers only: the cue that is up, and how many there are. Live, so a cue
   *  list follows the show rather than describing it. */
  step?: number
  steps?: number

  /** Timings, in milliseconds. Exposed so a speed dial's effect is observable
   *  rather than merely acknowledged. */
  fadeIn?: number
  fadeOut?: number
  duration?: number
}

export interface FunctionBody {
  id: number
  type: string
  steps?: import('./cuelist').Step[]
  values?: {
    fixture: number
    channel: number
    value: number
    fixtureName?: string
    channelName?: string
  }[]
  members?: { function: number; name: string }[]

  /* EFX: the pattern, its geometry, and the heads that follow it. `fixtures`
     is what PUT takes back; `heads` is the same list with names on it. */
  algorithm?: string
  geometry?: { width: number; height: number; xOffset: number; yOffset: number; rotation: number }
  fixtures?: number[]
  heads?: { fixture: number; head: number; name: string }[]

  /* RGB matrix: the group it runs across and the colours it accepts. */
  fixtureGroup?: number
  groupName?: string
  colors?: string[]
  acceptsColors?: number

  data?: string // Script: the program
  source?: string // Audio and Video: the file or URL
  volume?: number

  scene?: number // Sequence
  sceneName?: string

  /** Present only when the body is honestly not readable yet. */
  note?: string
}

export interface FixtureGroup {
  id: number
  name: string
  fixtures: number[]
}

export interface FixtureState {
  id: number
  name: string
  universe: number
  address: number
  channels: number
  resolved: boolean
  manufacturer?: string
  model?: string
  mode?: string
}

/** Universes are numbered from 1 here, as they are on a desk. */
export interface UniverseState {
  id: number
  name: string
  outputs: { plugin: string; output: string }[]
  input?: { plugin: string; line: string; profile: string }
  passthrough: boolean
  /** False means this universe reaches nothing, however healthy the rest of
   *  the project looks. */
  patched: boolean
}

export interface IoOptions {
  outputPlugins: { name: string; lines: string[] }[]
  inputPlugins: { name: string; lines: string[] }[]
  inputProfiles: string[]
}

export interface UniverseMap {
  universe: number
  used: number
  free: number
  fixtures: { id: number; name: string; address: number; channels: number }[]
}

/** One fixture with its channels named. Only the detail route carries these. */
export interface FixtureDetail extends FixtureState {
  channelList: { index: number; name: string; group?: string }[]
}

/**
 * What can be changed about a widget.
 *
 * These are the same keys GET /vc answers with, so a widget can be read,
 * changed and sent back without translating field names on the way.
 */
export interface WidgetPatch {
  caption?: string
  page?: number
  geometry?: Partial<import('./layout').Geometry>
  functionId?: number | null
  chaserId?: number | null
  action?: string
  sliderMode?: string
  levelChannels?: { fixture: number; channel: number }[]
  clockType?: string
  clockTime?: number
}

export interface Status {
  name: string
  version: string
  apiVersion: number
  fixtures: number
  functions: number
  universes: number
  runningFunctions: number
  outputPlugins: string[]
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

export const api = {
  status: () => json<Status>('/api/v1/status'),
  functions: () => json<FunctionState[]>('/api/v1/functions'),
  vc: () => json<import('./layout').VcWidget>('/api/v1/vc'),
  layout: () => json<{ pages: { id: number; rows: number[][] }[] }>('/api/v1/layout'),
  putLayout: (body: { pages: { id: number; rows: number[][] }[] }) =>
    json<unknown>('/api/v1/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  functionBody: (id: number) => json<FunctionBody>(`/api/v1/functions/${id}/body`),
  fixtures: () => json<FixtureState[]>('/api/v1/fixtures'),
  fixture: (id: number) => json<FixtureDetail>(`/api/v1/fixtures/${id}`),

  /* Functions: the ten types, their timings, and their bodies. */
  createFunction: (type: string, name: string) =>
    json<FunctionState>('/api/v1/functions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name }),
    }),
  patchFunction: (
    id: number,
    patch: { name?: string; fadeIn?: number; fadeOut?: number; duration?: number },
  ) =>
    json<FunctionState>(`/api/v1/functions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** `force` skips the check for who still references this function. */
  removeFunction: (id: number, force = false) =>
    json<{ removed: number }>(`/api/v1/functions/${id}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),

  setSceneValue: (id: number, fixture: number, channel: number, value: number) =>
    json<unknown>(`/api/v1/functions/${id}/values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture, channel, value }),
    }),
  addChaserStep: (
    id: number,
    step: { function: number; fadeIn?: number; hold?: number; fadeOut?: number; index?: number },
  ) =>
    json<unknown>(`/api/v1/functions/${id}/steps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step),
    }),
  removeChaserStep: (id: number, index: number) =>
    json<unknown>(`/api/v1/functions/${id}/steps/${index}`, { method: 'DELETE' }),
  /** One route for every remaining type: the daemon dispatches on the
   *  function's own type, so a caller need not know which shape it takes. */
  setBody: (id: number, body: Record<string, unknown>) =>
    json<unknown>(`/api/v1/functions/${id}/body`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  algorithms: () => json<{ algorithms: string[] }>('/api/v1/algorithms'),

  groups: () => json<FixtureGroup[]>('/api/v1/fixture-groups'),
  addGroup: (name: string, fixtures: number[]) =>
    json<{ id: number }>('/api/v1/fixture-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fixtures }),
    }),
  patchGroup: (id: number, patch: { name?: string; fixtures?: number[] }) =>
    json<unknown>(`/api/v1/fixture-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeGroup: (id: number) => json<unknown>(`/api/v1/fixture-groups/${id}`, { method: 'DELETE' }),

  setMembers: (id: number, members: number[]) =>
    json<unknown>(`/api/v1/functions/${id}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functions: members }),
    }),

  /* Patching: universes, their output, and the fixtures in them. This is what
     makes light come out, and until now none of it was reachable from a
     browser. */
  universes: () => json<UniverseState[]>('/api/v1/universes'),
  universeMap: (id: number) => json<UniverseMap>(`/api/v1/universes/${id}/map`),
  io: () => json<IoOptions>('/api/v1/io'),

  addUniverse: (name?: string) =>
    json<{ id: number }>('/api/v1/universes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(name === undefined ? {} : { name }),
    }),
  removeUniverse: (id: number) =>
    json<{ removed: number }>(`/api/v1/universes/${id}`, { method: 'DELETE' }),
  patchUniverse: (
    id: number,
    patch: {
      name?: string
      passthrough?: boolean
      output?: { plugin: string; line: string }
      input?: { plugin: string; line: string; profile?: string }
    },
  ) =>
    json<unknown>(`/api/v1/universes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  manufacturers: (search?: string) =>
    json<{ manufacturers: string[]; total: number }>(
      `/api/v1/library${search ? `?q=${encodeURIComponent(search)}` : ''}`,
    ),
  models: (manufacturer: string) =>
    json<{ models: string[] }>(`/api/v1/library/${encodeURIComponent(manufacturer)}`),
  modes: (manufacturer: string, model: string) =>
    json<{ modes: { name: string; channels: number }[] }>(
      `/api/v1/library/${encodeURIComponent(manufacturer)}/${encodeURIComponent(model)}`,
    ),

  addFixtures: (body: {
    manufacturer: string
    model: string
    mode: string
    name?: string
    universe: number
    address: number
    quantity?: number
    gap?: number
  }) =>
    json<{ created: number[] }>('/api/v1/fixtures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patchFixture: (id: number, patch: { name?: string; universe?: number; address?: number }) =>
    json<FixtureState>(`/api/v1/fixtures/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeFixture: (id: number) =>
    json<{ removed: number; consoleReferencesRemoved: number }>(`/api/v1/fixtures/${id}`, {
      method: 'DELETE',
    }),

  /* Undo and redo, scoped to the console. A deleted widget comes back; a
     deleted fixture is re-patched by hand, because undoing a change to the
     document would drop every running function. */
  vcHistory: () => json<{ undo: number; redo: number }>('/api/v1/vc/history'),
  undoConsole: () => json<{ undo: number; redo: number }>('/api/v1/vc/undo', { method: 'POST' }),
  redoConsole: () => json<{ undo: number; redo: number }>('/api/v1/vc/redo', { method: 'POST' }),

  /** Give every widget an id, so a console from QLC+ 4 can be edited at all. */
  assignWidgetIds: () => json<{ assigned: number }>('/api/v1/vc/widgets/ids', { method: 'POST' }),

  addWidget: (body: WidgetPatch & { type: string; parent?: number }) =>
    json<{ id: string; type: string }>('/api/v1/vc/widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  editWidget: (id: number, patch: WidgetPatch) =>
    json<import('./layout').VcWidget>(`/api/v1/vc/widgets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeWidget: (id: number) =>
    json<{ removed: string }>(`/api/v1/vc/widgets/${id}`, { method: 'DELETE' }),

  saveProject: () => json<{ path: string }>('/api/v1/project/save', { method: 'POST' }),
  blackout: (on: boolean) =>
    json<{ blackout: boolean }>('/api/v1/blackout', { method: on ? 'POST' : 'DELETE' }),
}
