// SQLite store for the agent's memory: utterances, tool calls, run index,
// preferences, and a suggestion cache. Source of truth for the *timeline*
// stays in events.json; this DB stores everything around the agent's
// behavior so we can power "the agent remembers your past commands."

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { PROJECT_ROOT } from "./studio";

const DB_DIR = path.join(PROJECT_ROOT, ".agentic-studio");
const DB_PATH = path.join(DB_DIR, "store.db");

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  name        TEXT PRIMARY KEY,
  run_dir     TEXT NOT NULL,
  raw_video   TEXT,
  events_file TEXT,
  started_at  TEXT,
  stopped_at  TEXT,
  duration    REAL,
  status      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS utterances (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_name   TEXT,
  transcript TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  rec_time   REAL,
  FOREIGN KEY (run_name) REFERENCES runs(name) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS utterances_run ON utterances(run_name);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_name    TEXT,
  tool_name   TEXT NOT NULL,
  arguments   TEXT NOT NULL,
  event_type  TEXT,
  event_time  REAL,
  status      TEXT NOT NULL,
  error       TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_name) REFERENCES runs(name) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_name);
CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 1,
  last_used  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, text)
);
CREATE INDEX IF NOT EXISTS suggestions_kind ON suggestions(kind, uses DESC);

-- Journal of every timeline mutation. Source of truth for "what edits has
-- this take seen?" — useful for undo, audit, and rendering from history.
CREATE TABLE IF NOT EXISTS edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_name    TEXT NOT NULL,
  op          TEXT NOT NULL,           -- add|update|delete|render|polish
  payload     TEXT NOT NULL,           -- JSON of the event/patch/render-opts
  source      TEXT NOT NULL,           -- voice|manual|agent
  event_index INTEGER,                 -- nullable; the index touched, if any
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS edits_run_time ON edits(run_name, created_at DESC);
`;

export interface RunRow {
  name: string;
  run_dir: string;
  raw_video: string | null;
  events_file: string | null;
  started_at: string | null;
  stopped_at: string | null;
  duration: number | null;
  status: string | null;
}

export interface ToolCallInsert {
  run_name: string | null;
  tool_name: string;
  arguments: string;
  event_type?: string | null;
  event_time?: number | null;
  status: "ok" | "skipped" | "error";
  error?: string | null;
}

export function open(): Database.Database {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  db = conn;
  return conn;
}

export function close(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function recordUtterance(runName: string | null, transcript: string, recTime?: number): void {
  open().prepare(
    "INSERT INTO utterances (run_name, transcript, rec_time) VALUES (?, ?, ?)",
  ).run(runName, transcript, recTime ?? null);
}

export function recordToolCall(call: ToolCallInsert): void {
  open().prepare(
    `INSERT INTO tool_calls
       (run_name, tool_name, arguments, event_type, event_time, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.run_name,
    call.tool_name,
    call.arguments,
    call.event_type ?? null,
    call.event_time ?? null,
    call.status,
    call.error ?? null,
  );
}

export type EditOp = "add" | "update" | "delete" | "render" | "polish";
export type EditSource = "voice" | "manual" | "agent";

export interface EditEntry {
  run_name: string;
  op: EditOp;
  payload: unknown;
  source: EditSource;
  event_index?: number | null;
}

export function recordEdit(e: EditEntry): void {
  open().prepare(
    `INSERT INTO edits (run_name, op, payload, source, event_index)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(
    e.run_name,
    e.op,
    JSON.stringify(e.payload ?? null),
    e.source,
    e.event_index ?? null,
  );
}

export interface EditRow {
  id: number;
  run_name: string;
  op: EditOp;
  payload: string;
  source: EditSource;
  event_index: number | null;
  created_at: string;
}

export function recentEdits(run_name: string, limit = 50): EditRow[] {
  return open()
    .prepare(
      "SELECT id, run_name, op, payload, source, event_index, created_at " +
      "FROM edits WHERE run_name = ? ORDER BY id DESC LIMIT ?",
    )
    .all(run_name, limit) as EditRow[];
}

export function upsertRun(row: RunRow): void {
  open().prepare(
    `INSERT INTO runs (name, run_dir, raw_video, events_file, started_at, stopped_at, duration, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         run_dir     = excluded.run_dir,
         raw_video   = COALESCE(excluded.raw_video, runs.raw_video),
         events_file = COALESCE(excluded.events_file, runs.events_file),
         started_at  = COALESCE(excluded.started_at, runs.started_at),
         stopped_at  = COALESCE(excluded.stopped_at, runs.stopped_at),
         duration    = COALESCE(excluded.duration, runs.duration),
         status      = excluded.status,
         updated_at  = datetime('now')`,
  ).run(
    row.name,
    row.run_dir,
    row.raw_video,
    row.events_file,
    row.started_at,
    row.stopped_at,
    row.duration,
    row.status,
  );
}

export function getPreference(key: string): string | null {
  const row = open().prepare("SELECT value FROM preferences WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setPreference(key: string, value: string): void {
  open().prepare(
    `INSERT INTO preferences (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function bumpSuggestion(kind: string, text: string): void {
  if (!text || !text.trim()) return;
  open().prepare(
    `INSERT INTO suggestions (kind, text)
       VALUES (?, ?)
       ON CONFLICT(kind, text) DO UPDATE SET
         uses = uses + 1,
         last_used = datetime('now')`,
  ).run(kind, text.trim());
}

export function topSuggestions(kind: string, limit = 10): { text: string; uses: number }[] {
  return open()
    .prepare(
      "SELECT text, uses FROM suggestions WHERE kind = ? ORDER BY uses DESC, last_used DESC LIMIT ?",
    )
    .all(kind, limit) as { text: string; uses: number }[];
}

export interface RecentUtterance {
  transcript: string;
  recorded_at: string;
  run_name: string | null;
  rec_time: number | null;
}

export function recentUtterances(limit = 50): RecentUtterance[] {
  return open()
    .prepare(
      "SELECT transcript, recorded_at, run_name, rec_time FROM utterances ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as RecentUtterance[];
}

export interface AgentStats {
  utterances: number;
  tool_calls: number;
  runs: number;
}

export function stats(): AgentStats {
  const row = open()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM utterances) AS utterances,
         (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
         (SELECT COUNT(*) FROM runs) AS runs`,
    )
    .get() as AgentStats;
  return row;
}
