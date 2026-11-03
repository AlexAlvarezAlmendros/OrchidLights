/**
 * Cliente del API de OrchidLights.
 *
 * Una capa fina sobre `fetch`: el contrato ya está escrito y comprobado contra
 * el código en `docs/api/openapi.yaml`, así que esto no valida nada que el
 * daemon vaya a validar mejor. Lo que sí hace es convertir sus errores en
 * excepciones con el mensaje que él da, que está escrito para que se le pueda
 * enseñar a un operador.
 */

/** Lo que el daemon contesta cuando algo va mal. */
export class OrchidError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(`${method} ${path} → ${status}: ${message}`)
    this.name = 'OrchidError'
  }
}

export interface Fixture {
  id: number
  name: string
  type?: string
  universe: number
  address: number
  channels: number
  manufacturer?: string
  model?: string
  mode?: string
  resolved?: boolean
  heads?: number
  channelList?: { index: number; name: string; group?: string }[]
  modifiers?: Record<string, string>
}

export interface FunctionSummary {
  id: number
  name: string
  type: string
  running?: boolean
  path?: string
  fadeIn?: number
  fadeOut?: number
  duration?: number
  runOrder?: string
  direction?: string
  tempoType?: string
}

export interface PatchEndpoint {
  plugin?: string
  line?: string
  output?: string
  profile?: string
}

export interface Universe {
  id: number
  name: string
  patched?: boolean
  passthrough?: boolean
  outputs?: PatchEndpoint[]
  input?: PatchEndpoint
  feedback?: PatchEndpoint
}

export interface PlanFixture {
  id: number
  name: string
  universe: number
  address: number
  channels: number
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
}

export interface Plan {
  grid: { width: number; height: number; depth: number; units: string }
  background: boolean
  pointOfView: string
  fixtures: PlanFixture[]
}

export interface FixtureGroup {
  id: number
  name: string
  size?: { width: number; height: number }
  fixtures?: number[]
  cells?: { x: number; y: number; fixture: number; head: number }[]
}

export interface DmxSnapshot {
  universe: number
  blackout: boolean
  values: number[]
  active: {
    channel: number
    value: number
    fixture?: number
    fixtureName?: string
    channelName?: string
  }[]
}

export interface ClientOptions {
  /** Dónde escucha el daemon. Por defecto, donde escucha por defecto. */
  baseUrl?: string
  /**
   * El token de ~/.orchidlights/api-token. En loopback no hace falta; fuera de
   * él el daemon lo exige, y también para lo que llega al disco.
   */
  token?: string
  /** Milisegundos antes de rendirse. Una mesa que no contesta en diez segundos está colgada. */
  timeoutMs?: number
}

export class OrchidClient {
  readonly baseUrl: string
  private readonly token: string | undefined
  private readonly timeoutMs: number

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:9998').replace(/\/+$/, '')
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    }
    if (body !== undefined) init.body = JSON.stringify(body)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/v1${path}`, init)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new OrchidError(0, method, path, `no se pudo alcanzar la mesa (${reason})`)
    }

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      parsed = null
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 200) || response.statusText
      throw new OrchidError(response.status, method, path, message)
    }

    return parsed as T
  }

  get<T>(path: string) {
    return this.request<T>('GET', path)
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body)
  }
  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body)
  }
  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body)
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path)
  }

  /* ---- lo que usa el motor de spec ------------------------------------ */

  discovery() {
    return this.get<{
      name: string
      version: string
      apiVersion: number
      openapi: string
      websocket: string
      authRequired: boolean
      access: Record<string, boolean>
      project?: { path: string; name: string; modified: boolean }
    }>('')
  }

  status() {
    return this.get<Record<string, unknown>>('/status')
  }

  project() {
    return this.get<{
      path: string
      name: string
      directory: string
      modified: boolean
      startupFunction: number
    }>('/project')
  }

  fixtures() {
    return this.get<Fixture[]>('/fixtures')
  }

  fixture(id: number) {
    return this.get<Fixture>(`/fixtures/${id}`)
  }

  functions() {
    return this.get<FunctionSummary[]>('/functions')
  }

  functionBody(id: number) {
    return this.get<Record<string, unknown>>(`/functions/${id}/body`)
  }

  universes() {
    return this.get<Universe[]>('/universes')
  }

  plan() {
    return this.get<Plan>('/plan')
  }

  fixtureGroups() {
    return this.get<FixtureGroup[]>('/fixture-groups')
  }

  io() {
    return this.get<{
      outputPlugins: { name: string; lines: string[] }[]
      inputPlugins: { name: string; lines: string[] }[]
      inputProfiles: string[]
    }>('/io')
  }

  dmx(universe: number) {
    return this.get<DmxSnapshot>(`/universes/${universe}/dmx`)
  }

  save() {
    return this.post<{ path: string }>('/project/save')
  }
}
