/** REST client. Same origin as the page, so no base URL and no CORS. */

export interface FunctionState {
  id: number
  name: string
  type: string
  running: boolean
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
  blackout: (on: boolean) =>
    json<{ blackout: boolean }>('/api/v1/blackout', { method: on ? 'POST' : 'DELETE' }),
}
