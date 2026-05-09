// SQLite persistence for agentic-video.
//
// - videos: one row per source file (keyed by sha1 of the bytes)
// - transcripts: cached whisper-1 output per video (keyed by sha1 too)
// - runs: one row per Agent.prompt invocation (prompt, status, outputs)
//
// The DB lives at runs/agentic-video.db so it travels with the project.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface VideoRow {
  sha1: string;
  source_path: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  has_audio: number;
  indexed_at: number;
}

export interface TranscriptRow {
  video_sha1: string;
  text: string;
  words_json: string;
  segments_json: string;
  transcribed_at: number;
}

export interface RunRow {
  id: number;
  name: string;
  video_sha1: string;
  prompt: string;
  model: string;
  status: string | null;
  started_at: number;
  finished_at: number | null;
  agent_duration_ms: number | null;
  cuts_json: string | null;
  music_json: string | null;
  summary: string | null;
  final_path: string | null;
  final_duration_s: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS videos (
  sha1 TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  duration_s REAL,
  width INTEGER,
  height INTEGER,
  has_audio INTEGER NOT NULL DEFAULT 1,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  video_sha1 TEXT PRIMARY KEY,
  text TEXT,
  words_json TEXT,
  segments_json TEXT,
  transcribed_at INTEGER NOT NULL,
  FOREIGN KEY (video_sha1) REFERENCES videos(sha1)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  video_sha1 TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  agent_duration_ms INTEGER,
  cuts_json TEXT,
  music_json TEXT,
  summary TEXT,
  final_path TEXT,
  final_duration_s REAL,
  FOREIGN KEY (video_sha1) REFERENCES videos(sha1)
);

CREATE INDEX IF NOT EXISTS idx_runs_video ON runs(video_sha1);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
`;

export function open(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function sha1File(filePath: string): string {
  const hash = crypto.createHash("sha1");
  const stream = fs.createReadStream(filePath);
  return new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  }) as unknown as string;
}

// Synchronous version because run.ts is straight-line. ~1s per 200MB, fine.
export function sha1FileSync(filePath: string): string {
  const hash = crypto.createHash("sha1");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(1 << 20);
  let read: number;
  while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    hash.update(buf.subarray(0, read));
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

export function upsertVideo(db: Database.Database, row: Omit<VideoRow, "indexed_at">): void {
  db.prepare(
    `INSERT INTO videos (sha1, source_path, duration_s, width, height, has_audio, indexed_at)
     VALUES (@sha1, @source_path, @duration_s, @width, @height, @has_audio, @indexed_at)
     ON CONFLICT(sha1) DO UPDATE SET
       source_path = excluded.source_path,
       duration_s = excluded.duration_s,
       width = excluded.width,
       height = excluded.height,
       has_audio = excluded.has_audio`,
  ).run({ ...row, indexed_at: Date.now() });
}

export function getTranscript(db: Database.Database, sha1: string): TranscriptRow | undefined {
  return db.prepare(`SELECT * FROM transcripts WHERE video_sha1 = ?`).get(sha1) as TranscriptRow | undefined;
}

export function putTranscript(
  db: Database.Database,
  sha1: string,
  transcript: { text?: string; words?: unknown[]; segments?: unknown[] },
): void {
  db.prepare(
    `INSERT INTO transcripts (video_sha1, text, words_json, segments_json, transcribed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(video_sha1) DO UPDATE SET
       text = excluded.text,
       words_json = excluded.words_json,
       segments_json = excluded.segments_json,
       transcribed_at = excluded.transcribed_at`,
  ).run(
    sha1,
    transcript.text ?? null,
    JSON.stringify(transcript.words ?? []),
    JSON.stringify(transcript.segments ?? []),
    Date.now(),
  );
}

export function startRun(db: Database.Database, row: {
  name: string;
  video_sha1: string;
  prompt: string;
  model: string;
}): number {
  const result = db.prepare(
    `INSERT INTO runs (name, video_sha1, prompt, model, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.name, row.video_sha1, row.prompt, row.model, Date.now());
  return result.lastInsertRowid as number;
}

export function finishRun(db: Database.Database, id: number, fields: {
  status: string;
  agent_duration_ms: number;
  cuts_json: string | null;
  music_json: string | null;
  summary: string | null;
  final_path: string | null;
  final_duration_s: number | null;
}): void {
  db.prepare(
    `UPDATE runs
     SET finished_at = @finished_at,
         status = @status,
         agent_duration_ms = @agent_duration_ms,
         cuts_json = @cuts_json,
         music_json = @music_json,
         summary = @summary,
         final_path = @final_path,
         final_duration_s = @final_duration_s
     WHERE id = @id`,
  ).run({ ...fields, id, finished_at: Date.now() });
}

export function listRuns(db: Database.Database, limit = 20): RunRow[] {
  return db.prepare(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as RunRow[];
}
