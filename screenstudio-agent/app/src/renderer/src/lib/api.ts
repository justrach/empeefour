// Talks to the Python `studio_agent editor` server running on 127.0.0.1:8765.
// The Electron main process spawns it on app boot.

const BASE = 'http://127.0.0.1:8765'

export interface RunSummary {
  name: string
  events: number
  raw: boolean
  final: boolean
}

export interface TimelineEvent {
  type: string
  time: number
  [key: string]: unknown
}

export interface EventsDoc {
  version: number
  recording: { start_epoch: number; [key: string]: unknown }
  events: TimelineEvent[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
  const text = await res.text()
  let payload: unknown = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = (payload as { error?: string })?.error || res.statusText || `HTTP ${res.status}`
    throw new Error(err)
  }
  return payload as T
}

export const status = (): Promise<{ active: unknown }> => api('/api/status')
export const listRuns = (): Promise<{ runs: RunSummary[] }> => api('/api/runs')
export const getEvents = (name: string): Promise<EventsDoc> =>
  api(`/api/runs/${encodeURIComponent(name)}/events`)
export const putEvents = (name: string, doc: EventsDoc): Promise<unknown> =>
  api(`/api/runs/${encodeURIComponent(name)}/events`, {
    method: 'PUT',
    body: JSON.stringify(doc)
  })

export interface RecordOpts {
  name?: string
  display?: string | number
  duration?: string | number
  audio?: boolean
  cursor?: boolean
  show_clicks?: boolean
}
export const startRecording = (opts: RecordOpts): Promise<unknown> =>
  api('/api/record/start', { method: 'POST', body: JSON.stringify(opts) })

export interface StopOpts {
  render?: boolean
  output?: string
  canvas?: string
  crf?: number
  preset?: string
  background?: string
}
export const stopRecording = (opts: StopOpts): Promise<{ session: { run_dir: string } }> =>
  api('/api/record/stop', { method: 'POST', body: JSON.stringify(opts) })

export const renderRun = (
  name: string,
  opts: StopOpts
): Promise<{ output: string }> =>
  api(`/api/runs/${encodeURIComponent(name)}/render`, {
    method: 'POST',
    body: JSON.stringify(opts)
  })

export function mediaUrl(name: string, file: string): string {
  return `${BASE}/media/runs/${encodeURIComponent(name)}/${file}`
}
