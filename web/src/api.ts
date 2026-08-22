/** REST client. Same origin as the page, so no base URL and no CORS. */
import { authHeaders } from './token'

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
  /** The folder tree this function lives in, absent at the root. */
  path?: string
  runOrder?: string
  direction?: string
  tempoType?: string
  /** Lit by the engine's flash overlay (not the same as running). */
  flashing?: boolean
}

/** Who uses a function: other functions, console widgets, the autostart. */
export interface FunctionUsage {
  functions: { id: number; name: string; type: string }[]
  widgets: { id?: number; caption: string; type: string }[]
  startup: boolean
}

export interface PaletteFanning {
  type: string
  layout: string
  amount: number
  value: string | number | null
}

/** One palette: a named value scenes can reference. */
export interface PaletteState {
  id: number
  name: string
  type: string
  values: (string | number)[]
  fanning: PaletteFanning
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
  heads?: {
    fixture: number
    head: number
    name: string
    offset?: number
    reverse?: boolean
    mode?: string
  }[]

  /* RGB matrix: the group it runs across and the colours it accepts. */
  fixtureGroup?: number
  groupName?: string
  colors?: string[]
  acceptsColors?: number
  blendMode?: string
  controlMode?: string
  /** Text algorithm settings, present only while the matrix runs Text. */
  text?: { content: string; font: string; animation: string }
  /** Image algorithm settings, present only while the matrix runs Image. */
  image?: { file: string; animation: string }
  /** Animation styles the current text/image algorithm offers. */
  animations?: string[]
  /** A script algorithm's own knobs, values included. */
  properties?: {
    name: string
    label: string
    type: string
    value: string
    values?: string[]
    min?: number
    max?: number
  }[]

  /* EFX extras */
  propagation?: string

  data?: string // Script: the program
  source?: string // Audio and Video: the file or URL
  volume?: number
  /** Audio: which output it plays through, absent for the system default. */
  device?: string

  scene?: number // Sequence
  sceneName?: string
  /** Scene: the palettes it resolves at start, with names. */
  palettes?: { id: number; name: string }[]
  /** Chaser speed modes: "common" | "perstep" (+ "default" for duration). */
  fadeInMode?: string
  fadeOutMode?: string
  durationMode?: string

  // Show
  tracks?: ShowTrack[]
  duration?: number
  timeDivision?: string
  bpm?: number

  /** Present only when the body is honestly not readable yet. */
  note?: string
}

/** One track of a show: a scene, and the functions placed along it in time. */
export interface ShowTrack {
  id: number
  name: string
  mute: boolean
  scene?: number
  sceneName?: string
  functions: ShowItem[]
}

export interface ShowItem {
  id: number
  function: number
  /** Milliseconds from the start of the show. */
  start: number
  /** Milliseconds. Never 0 on the way out: an item stored at 0 borrows the
   *  function's own duration, and that is what the timeline honours. */
  duration: number
  locked: boolean
  color?: string
  name: string
  type?: string
  /** The function it points at is gone. The show plays silence there. */
  missing?: boolean
}

export interface GroupCell {
  x: number
  y: number
  fixture: number
  head: number
}

export interface FixtureGroup {
  id: number
  name: string
  fixtures: number[]
  /** The 2D grid: which way an effect snakes across the rig. */
  size: { width: number; height: number }
  cells: GroupCell[]
}

/**
 * What this machine can do with sound, which is two separate questions: what it
 * can listen to (the audio triggers) and what it can play through (an Audio
 * function). Neither was reachable from the interface before.
 */
export interface AudioDevices {
  inputs: string[]
  selected: string
  capturing: boolean
  /** Why the capture is not running, when it asked to be. */
  unavailable?: string
  outputs: string[]
  /** File extensions the loaded decoder plugins can read. */
  formats: string[]
  /** A decoder and an output, both present. */
  canPlay: boolean
  /** Which of the two is missing, in words. */
  silentBecause?: string
}

export interface PlanState {
  grid: { width: number; height: number; depth: number; units: 'meters' | 'feet' }
  /** The project names a background image and the daemon can serve it. */
  background: boolean
  fixtures: PlanFixture[]
}

export interface PlanHeadItem {
  head: number
  x: number
  y: number
  rotation: number
  gel?: string
  zoom?: number
  hidden?: boolean
  locked?: boolean
  invertPan?: boolean
  invertTilt?: boolean
}

export interface PlanLinkedItem {
  linked: number
  head: number
  name: string
  x: number
  y: number
  rotation: number
}

export interface PlanFixture {
  id: number
  name: string
  universe: number
  address: number
  channels: number
  resolved: boolean
  /** Absent when nobody has placed this fixture yet. A plan that quietly stacks
   *  every unplaced lamp at the origin looks like a plan, and is not. */
  x?: number
  y?: number
  /** Height in millimetres; absent while the lamp sits on the floor. */
  z?: number
  rotation?: number
  rotationX?: number
  rotationZ?: number
  gel?: string
  zoom?: number
  /** Real footprint in millimetres, from the definition's physical block. */
  width?: number
  depth?: number
  hidden?: boolean
  locked?: boolean
  invertPan?: boolean
  invertTilt?: boolean
  heads?: number
  /** Heads beyond the fixture's own that carry their own plan item. */
  headItems?: PlanHeadItem[]
  /** The same lamp drawn again: plan-only copies over the same patch. */
  linkedItems?: PlanLinkedItem[]
  /** Offsets from the fixture's address, so the interface can read them against
   *  the DMX frames it already receives. */
  roles: {
    intensity?: number
    red?: number
    green?: number
    blue?: number
    cyan?: number
    magenta?: number
    yellow?: number
    white?: number
    amber?: number
    uv?: number
    pan?: number
    tilt?: number
  }
}

/**
 * A channels group: one fader over a handful of channels picked by hand.
 *
 * Not a fixture group. A fixture group gathers whole fixtures so an effect can
 * run across them; this gathers the dimmer of one lamp and the strobe of
 * another so one fader moves both. Different id space, too: a channels group
 * and a console widget can both be number 3 and have nothing to do with each
 * other.
 */
export interface ChannelGroup {
  id: number
  name: string
  channels: ChannelRef[]
  value: number
  /** False when nothing it names still exists. The fader would move and no
   *  light would. */
  controllable: boolean
  /** How many of its channels have lost their fixture. */
  missing?: number
}

export interface ChannelRef {
  fixture: number
  channel: number
  /** Absent when the fixture is gone; the pair is still reported. */
  fixtureName?: string
  name?: string
  group?: string
  address?: number
  universe?: number
  missing?: boolean
}

export interface FixtureState {
  id: number
  name: string
  universe: number
  address: number
  channels: number
  resolved: boolean
  /** How many of its channels pass through a modifier curve. Absent when
   *  none do, which is the usual case. */
  modifiers?: number
  manufacturer?: string
  model?: string
  mode?: string
  /** How many heads the mode defines; a pixel bar is one fixture, many heads. */
  heads?: number
  /** What the definition's physical block says, for the rigger's summary.
   *  Only what it actually says: an invented zero would read as "weightless". */
  physical?: { weight?: number; power?: number; width?: number; height?: number; depth?: number }
}

/** Universes are numbered from 1 here, as they are on a desk. */
export interface UniverseState {
  id: number
  name: string
  outputs: { plugin: string; output: string; parameters?: Record<string, unknown> }[]
  input?: {
    plugin: string
    line: string
    profile: string
    parameters?: Record<string, unknown>
  }
  /** Where this universe's feedback goes out (motorized faders, LEDs). */
  feedback?: { plugin: string; line: string }
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
  channelList: { index: number; name: string; group?: string; modifier?: string }[]
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
  /** null puts a colour or a font back to the desk's default, which is a thing
   *  an operator asks for and which an empty string does not say. */
  background?: string | null
  foreground?: string | null
  font?: string | null
  frameStyle?: string
  /** null unbinds the external control. lower/upper are the custom feedback
   *  values (the control's LED in each state); null puts one back to 0/255. */
  input?: {
    universe: number
    channel: number
    lower?: number | null
    upper?: number | null
  } | null
  /** Keyboard shortcut as QKeySequence text ("Ctrl+F1"); null unbinds. */
  key?: string | null
  /** Slider drawing style: "Knob" or "Slider" (the file's own spellings). */
  sliderStyle?: string
  /** Adjust-mode slider target; null removes it. */
  adjust?: { function: number; attribute: number } | null
  /** Flash buttons: override running functions / force LTP. */
  flashOverride?: boolean
  flashForceLTP?: boolean
  /** Startup intensity a button applies before starting; null removes. */
  startupIntensity?: { enabled: boolean; value: number } | null
  /** A clock's whole agenda, replaced at once. */
  schedules?: { function: number; start: string; stop?: string; weekFlags?: number }[]
  /** Multipage frames. */
  pages?: number
  pagesLoop?: boolean
  pageInputs?: {
    next?: { universe: number; channel: number } | null
    prev?: { universe: number; channel: number } | null
  }
  pageShortcuts?: { page: number; name: string }[]
  /** Cue list side fader mode: None, Crossfade or Steps. */
  sideFaderMode?: string
  /** XY pad heads with their travel slices, replaced whole. */
  padHeads?: {
    fixture: number
    head?: number
    x?: { low?: number; high?: number; reverse?: boolean }
    y?: { low?: number; high?: number; reverse?: boolean }
  }[]
  /** XY pad presets, replaced whole. */
  padPresets?: { type: string; name: string; x?: number; y?: number; function?: number }[]
}

/** The show the daemon has open. */
export interface ProjectState {
  name: string
  path: string
  directory: string
  /** The function the show opens with; -1 when none. */
  startupFunction?: number
  /** Edited since it was loaded or last saved. Nothing here writes to disk on
   *  its own, so this is the only warning there is. */
  modified: boolean
  /** A recovery copy newer than the project, when one exists. Reported, never
   *  auto-loaded: whether the crash's last thirty seconds beat the file is
   *  the operator's call. */
  autosave?: { name: string; savedAt: string }
}

export interface RecentProject {
  path: string
  name: string
  exists: boolean
}

export interface GrandMasterState {
  value: number
  /** "Intensity" | "All" -- QLC+'s own strings, verbatim. */
  channelMode: string
  /** "Reduce" | "Limit" */
  valueMode: string
  visible: boolean
  /** The external control bound to the big fader; null when none. */
  input?: { universe: number; channel: number } | null
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
  /** Whether the rig is blacked out right now. */
  blackout: boolean
}

/** Thrown on a 401 so the shell can tell "the daemon wants a token" apart
 *  from every other failure and show the connect screen instead of a toast. */
export class Unauthorized extends Error {
  constructor() {
    super('El daemon pide un token')
    this.name = 'Unauthorized'
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    /* Every request carries the token this client holds -- one place, so a
       route added later cannot forget it. On loopback without a token the
       spread adds nothing and the daemon does not mind. */
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (response.status === 401) throw new Unauthorized()
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

export const api = {
  status: () => json<Status>('/api/v1/status'),
  project: () => json<ProjectState>('/api/v1/project'),
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
    patch: {
      name?: string
      fadeIn?: number
      fadeOut?: number
      duration?: number
      path?: string
      runOrder?: string
      direction?: string
      tempoType?: string
      fadeInMode?: string
      fadeOutMode?: string
      durationMode?: string
      timeDivision?: string
      bpm?: number
    },
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
  patchChaserStep: (
    id: number,
    index: number,
    patch: {
      fadeIn?: number
      hold?: number
      fadeOut?: number
      duration?: number
      note?: string
      function?: number
    },
  ) =>
    json<FunctionBody>(`/api/v1/functions/${id}/steps/${index}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** The whole permutation at once: what lands in the file is exactly this. */
  setStepsOrder: (id: number, order: number[]) =>
    json<FunctionBody>(`/api/v1/functions/${id}/steps/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    }),
  /** A sequence step's own DMX values. */
  setSequenceStepValues: (
    id: number,
    index: number,
    values: { fixture: number; channel: number; value: number }[],
  ) =>
    json<FunctionBody>(`/api/v1/functions/${id}/steps/${index}/values`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  /** The engine's own tokenizer, on whatever text: WHICH lines it refuses. */
  scriptCheck: (data: string) =>
    json<{ errors: number[] }>('/api/v1/script/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }),
  /** Solo, the reference way: the chosen track unmutes, the rest mute. */
  soloTrack: (showId: number, trackId: number, solo: boolean) =>
    json<unknown>(`/api/v1/functions/${showId}/tracks/${trackId}/solo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solo }),
    }),
  /** Time surgery at the cursor: insert stretches and pushes, cut shrinks
   *  and pulls back. */
  showTime: (showId: number, action: 'insert' | 'cut', at: number, amount: number) =>
    json<{ stretched?: number; shrunk?: number; moved: number }>(
      `/api/v1/functions/${showId}/time`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, at, amount }),
      },
    ),
  /** The engine's metronome: internal source and its tempo. */
  beat: () => json<{ source: string; bpm: number }>('/api/v1/beat'),
  setBeat: (body: { source?: string; bpm?: number }) =>
    json<{ source: string; bpm: number }>('/api/v1/beat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** Plugin knobs on a patch (ArtNet's IP, OSC's ports…), persisted with it. */
  setPatchParameters: (
    universe: number,
    body: { target: 'input' | 'output'; index?: number; parameters: Record<string, unknown> },
  ) =>
    json<unknown>(`/api/v1/universes/${universe}/parameters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  inputProfile: (name: string) =>
    json<{
      name: string
      manufacturer: string
      model: string
      type: string
      editable: boolean
      channels: { channel: number; name: string; type: string }[]
    }>(`/api/v1/inputprofiles/${encodeURIComponent(name)}`),
  createInputProfile: (body: { manufacturer: string; model: string; type?: string }) =>
    json<{ name: string }>('/api/v1/inputprofiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  setProfileChannel: (profile: string, channel: number, body: { name: string; type: string }) =>
    json<unknown>(`/api/v1/inputprofiles/${encodeURIComponent(profile)}/channels/${channel}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  removeProfileChannel: (profile: string, channel: number) =>
    json<unknown>(`/api/v1/inputprofiles/${encodeURIComponent(profile)}/channels/${channel}`, {
      method: 'DELETE',
    }),
  /** Peak per bucket, 0-100, over the whole audio file. */
  waveform: (id: number, points = 200) =>
    json<{ points: number[]; duration: number }>(
      `/api/v1/functions/${id}/waveform?points=${points}`,
    ),
  /** Palettes: one value with a name; scenes reference them by id. */
  palettes: () => json<{ palettes: PaletteState[] }>('/api/v1/palettes'),
  createPalette: (body: {
    type: string
    name: string
    values: (string | number)[]
    fanning?: PaletteFanning
  }) =>
    json<{ id: number }>('/api/v1/palettes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patchPalette: (
    id: number,
    body: { name?: string; values?: (string | number)[]; fanning?: Partial<PaletteFanning> },
  ) =>
    json<{ id: number }>(`/api/v1/palettes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  removePalette: (id: number) =>
    json<{ removed: number }>(`/api/v1/palettes/${id}`, { method: 'DELETE' }),
  /** Resolve onto fixtures and hold on the live desk (the dump sees it). */
  applyPalette: (id: number, fixtures: number[]) =>
    json<{ applied: number }>(`/api/v1/palettes/${id}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixtures }),
    }),

  /** The gel books: named colour collections shipped with the daemon. */
  colorFilters: () =>
    json<{ filters: { name: string; colors: { name: string; rgb: string }[] }[] }>(
      '/api/v1/colorfilters',
    ),
  bakeMatrix: (id: number) =>
    json<{ scene: number; sequence: number }>(`/api/v1/functions/${id}/bake`, {
      method: 'POST',
    }),
  /** Raw-body upload; the daemon drops it next to the projects. */
  uploadAsset: async (file: File) =>
    json<{ path: string; size: number }>(`/api/v1/assets?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    }),
  cloneFunction: (id: number) =>
    json<{ id: number }>(`/api/v1/functions/${id}/clone`, { method: 'POST' }),
  functionUsage: (id: number) => json<FunctionUsage>(`/api/v1/functions/${id}/usage`),
  patchProject: (patch: { startupFunction?: number }) =>
    json<{ startupFunction: number }>('/api/v1/project', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
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
  patchGroup: (
    id: number,
    patch: {
      name?: string
      fixtures?: number[]
      size?: { width: number; height: number }
      cells?: GroupCell[]
    },
  ) =>
    json<unknown>(`/api/v1/fixture-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** rotate90 | rotate180 | rotate270 | flipH | flipV, in place. */
  transformGroup: (id: number, op: string) =>
    json<unknown>(`/api/v1/fixture-groups/${id}/transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op }),
    }),
  removeGroup: (id: number) => json<unknown>(`/api/v1/fixture-groups/${id}`, { method: 'DELETE' }),

  addTrack: (showId: number, body: { name?: string; scene?: number }) =>
    json<{ id: number }>(`/api/v1/functions/${showId}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patchTrack: (
    showId: number,
    trackId: number,
    patch: { name?: string; mute?: boolean; scene?: number },
  ) =>
    json<unknown>(`/api/v1/functions/${showId}/tracks/${trackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeTrack: (showId: number, trackId: number) =>
    json<unknown>(`/api/v1/functions/${showId}/tracks/${trackId}`, { method: 'DELETE' }),

  addShowItem: (
    showId: number,
    trackId: number,
    body: { function: number; start: number; duration?: number },
  ) =>
    json<{ id: number }>(`/api/v1/functions/${showId}/tracks/${trackId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patchShowItem: (
    showId: number,
    itemId: number,
    patch: { start?: number; duration?: number; color?: string; locked?: boolean },
  ) =>
    json<unknown>(`/api/v1/functions/${showId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeShowItem: (showId: number, itemId: number) =>
    json<unknown>(`/api/v1/functions/${showId}/items/${itemId}`, { method: 'DELETE' }),

  audioDevices: () => json<AudioDevices>('/api/v1/audio'),
  /** The input the capture uses. A machine setting, not a project one: it is
   *  written to QSettings and outlives the show that is loaded. */
  selectAudioInput: (input: string) =>
    json<AudioDevices>('/api/v1/audio', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }),

  plan: () => json<PlanState>('/api/v1/plan'),
  /**
   * The live desk: absolute values pinned on individual channels.
   *
   * Not an edit — nothing here reaches the document, and nothing survives a
   * reload. It is the desk you reach for when you want to see what four lamps
   * look like in amber before deciding anything.
   */
  setLive: (values: { fixture: number; channel: number; value: number }[]) =>
    json<{ held: number }>('/api/v1/live', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  releaseLive: () => json<{ held: number }>('/api/v1/live', { method: 'DELETE' }),

  /** Millimetres against the monitor grid. X and Y only: a plan is a top view,
   *  and a height would not survive being saved. */
  setPlanPosition: (
    id: number,
    position: {
      head?: number | undefined
      linked?: number | undefined
      x?: number
      y?: number
      z?: number
      rotation?: number
      rotationX?: number
      rotationZ?: number
      gel?: string
      zoom?: number
      hidden?: boolean
      locked?: boolean
      invertPan?: boolean
      invertTilt?: boolean
    },
  ) =>
    json<{ id: number }>(`/api/v1/plan/fixtures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(position),
    }),
  clearPlanPosition: (id: number) =>
    json<unknown>(`/api/v1/plan/fixtures/${id}`, { method: 'DELETE' }),
  /** The stage itself: size in metres or feet. */
  setPlanGrid: (body: { width?: number; height?: number; depth?: number; units?: string }) =>
    json<unknown>('/api/v1/plan/grid', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** Hang an uploaded asset behind the plan, or take it down. */
  setPlanBackground: (asset: string) =>
    json<unknown>('/api/v1/plan/background', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset }),
    }),
  removePlanBackground: () => json<unknown>('/api/v1/plan/background', { method: 'DELETE' }),

  /** The channel modifier templates the daemon loaded, by name. */
  modifiers: () => json<{ modifiers: string[] }>('/api/v1/modifiers'),
  /** The 256 values a modifier maps to. Names like "Exponential Medium" say
   *  nothing on their own; drawn, they are obvious. */
  modifierCurve: (name: string) =>
    json<{ name: string; curve: number[] }>(`/api/v1/modifiers/${encodeURIComponent(name)}`),
  /** Replace a fixture's modifiers. A channel not named loses its curve. */
  setModifiers: (id: number, modifiers: Record<string, string | null>) =>
    json<unknown>(`/api/v1/fixtures/${id}/modifiers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modifiers }),
    }),

  channelGroups: () => json<ChannelGroup[]>('/api/v1/channel-groups'),
  addChannelGroup: (name: string, channels: { fixture: number; channel: number }[]) =>
    json<{ id: number }>('/api/v1/channel-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, channels }),
    }),
  patchChannelGroup: (
    id: number,
    patch: { name?: string; channels?: { fixture: number; channel: number }[] },
  ) =>
    json<ChannelGroup>(`/api/v1/channel-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  removeChannelGroup: (id: number) =>
    json<unknown>(`/api/v1/channel-groups/${id}`, { method: 'DELETE' }),

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
      output?: { plugin: string; line: string; index?: number }
      input?: { plugin: string; line: string; profile?: string }
      feedback?: { plugin: string; line: string }
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
  /** Same definition, same mode, first hole in the universe that fits. */
  cloneFixture: (id: number, body: { quantity?: number; gap?: number } = {}) =>
    json<{ created: number[] }>(`/api/v1/fixtures/${id}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** One fixture per row, a group wired snake or zigzag: the panel wizard. */
  addRgbPanel: (body: {
    name: string
    universe: number
    address: number
    rows: number
    columns: number
    components?: string
    direction?: string
    startCorner?: string
    displacement?: string
  }) =>
    json<{ group: number; created: number[] }>('/api/v1/fixtures/rgbpanel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** Swap the model, carry the show across: scenes, EFX, groups and the
   *  console's sliders follow, channels matched semantically. */
  remapFixture: (
    id: number,
    body: {
      manufacturer: string
      model: string
      mode: string
      name?: string
      universe?: number
      address?: number
    },
  ) =>
    json<{ id: number; channelsCarried: number; slidersTouched: number; fixture: FixtureState }>(
      `/api/v1/fixtures/${id}/remap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  addLinkedFixture: (id: number, body: { head?: number; name?: string; x?: number; y?: number }) =>
    json<{ id: number; linked: number }>(`/api/v1/plan/fixtures/${id}/linked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  removeLinkedFixture: (id: number, linked: number, head = 0) =>
    json<unknown>(`/api/v1/plan/fixtures/${id}/linked/${linked}?head=${head}`, {
      method: 'DELETE',
    }),
  /** What another .qxw offers, so somebody can choose. Token: a disk path. */
  importPreview: (path: string) =>
    json<{
      fixtures: { id: number; name: string; universe: number; address: number; channels: number }[]
      functions: { id: number; name: string; type: string }[]
      groups: number
      palettes: number
    }>('/api/v1/project/import/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  importProject: (body: {
    path: string
    fixtures?: 'all' | number[]
    functions?: 'all' | number[]
  }) =>
    json<{
      fixturesCreated: number
      fixturesReused: number
      groupsCreated: number
      palettesCreated: number
      functionsCreated: number
      skipped?: string[]
    }>('/api/v1/project/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  /* The disk-path routes: the daemon demands the token on these whatever the
     loopback policy, so they only work from a client that holds it -- the
     desktop shell, or a browser someone deliberately authorized. */
  newProject: () => json<{ path: string }>('/api/v1/project/new', { method: 'POST' }),
  openProjectPath: (path: string) =>
    json<{ path: string; unresolved?: string }>('/api/v1/project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  saveProjectAs: (path: string) =>
    json<{ path: string }>('/api/v1/project/save-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  recentProjects: () => json<{ recents: RecentProject[] }>('/api/v1/project/recents'),
  /* The phone-safe pair: names inside the projects directory, never paths. */
  listProjects: () => json<{ directory: string; projects: string[] }>('/api/v1/projects'),
  loadProject: (name: string) =>
    json<{ path: string; unresolved?: string }>(
      `/api/v1/project/load/${encodeURIComponent(name)}`,
      { method: 'POST' },
    ),
  saveProjectNamed: (name: string) =>
    json<{ path: string }>(`/api/v1/project/save/${encodeURIComponent(name)}`, {
      method: 'POST',
    }),
  recoverAutosave: () =>
    json<{ path: string; modified: boolean }>('/api/v1/project/recover', { method: 'POST' }),
  dumpState: () => json<{ count: number; bare: number; groups: string[] }>('/api/v1/dump'),
  dumpToScene: (body: {
    name?: string
    sceneId?: number
    nonZeroOnly?: boolean
    groups?: string[]
  }) =>
    json<{ scene: number; written: number }>('/api/v1/dump', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deskHeld: (universe: number) =>
    json<{ universe: number; held: Record<string, number> }>(`/api/v1/simpledesk/${universe}`),
  deskSet: (universe: number, values: Record<string, number>) =>
    json<{ universe: number; held: number }>(`/api/v1/simpledesk/${universe}/channels`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  deskReleaseChannel: (universe: number, channel: number) =>
    json<{ released: number }>(`/api/v1/simpledesk/${universe}/channels/${channel}`, {
      method: 'DELETE',
    }),
  deskReleaseUniverse: (universe: number) =>
    json<{ released: number }>(`/api/v1/simpledesk/${universe}`, { method: 'DELETE' }),
  deskKeypad: (universe: number, command: string) =>
    json<{ universe: number; applied: { channel: number; value: number }[] }>(
      `/api/v1/simpledesk/${universe}/keypad`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      },
    ),
  grandMaster: () => json<GrandMasterState>('/api/v1/grandmaster'),
  setGrandMaster: (patch: Partial<GrandMasterState>) =>
    json<GrandMasterState>('/api/v1/grandmaster', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  /** Stop every running function; with fadeMs, fade them out first. The
   *  panic button -- distinct from blackout, which silences the rig without
   *  ending anything. */
  stopAll: (fadeMs = 0) =>
    json<{ stopping: number; fadeMs: number }>('/api/v1/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fadeMs }),
    }),
  blackout: (on: boolean) =>
    json<{ blackout: boolean }>('/api/v1/blackout', { method: on ? 'POST' : 'DELETE' }),
}
