// Minimal client for the TS editor server (node tool/dist/cli.js editor).
// Hits 127.0.0.1:8765 directly — no Python in the path.

const BASE = process.env.NEXT_PUBLIC_STUDIO_API ?? "http://127.0.0.1:8765";

export interface RunSummary {
  name: string;
  events: number;
  raw: boolean;
  final: boolean;
}

export interface TimelineEvent {
  type: string;
  time: number;
  [key: string]: unknown;
}

export interface EventsDoc {
  version: number;
  recording: { start_epoch: number; [key: string]: unknown };
  events: TimelineEvent[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...init,
  });
  const text = await res.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg = (payload as { error?: string })?.error || res.statusText;
    throw new Error(msg);
  }
  return payload as T;
}

export const status = (): Promise<{ active: unknown }> => api("/api/status");
export const listRuns = (): Promise<{ runs: RunSummary[] }> => api("/api/runs");
export const getEvents = (name: string): Promise<EventsDoc> =>
  api(`/api/runs/${encodeURIComponent(name)}/events`);
export const putEvents = (name: string, doc: EventsDoc) =>
  api(`/api/runs/${encodeURIComponent(name)}/events`, {
    method: "PUT",
    body: JSON.stringify(doc),
  });
export const renderRun = (name: string, opts: Record<string, unknown> = {}) =>
  api<{ output: string }>(`/api/runs/${encodeURIComponent(name)}/render`, {
    method: "POST",
    body: JSON.stringify(opts),
  });

export function mediaUrl(name: string, file: string): string {
  return `${BASE}/media/runs/${encodeURIComponent(name)}/${file}`;
}
