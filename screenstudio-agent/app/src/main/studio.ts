// Helpers for talking to the studio-agent CLI and the .agentic-studio state
// directory. Prefer the TypeScript tool when it has been built, while keeping
// the Python implementation available as a fallback.

import { spawn, ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";

// Build layout: out/main/index.js → three ".." up = screenstudio-agent project root
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
export const PYTHON = process.env.STUDIO_PYTHON || "python3";
export const NODE = process.env.STUDIO_NODE || "node";
export const TS_CLI = path.join(PROJECT_ROOT, "tool", "dist", "cli.js");
export const STUDIO_ENGINE = process.env.STUDIO_ENGINE || (existsSync(TS_CLI) ? "ts" : "python");

export interface StudioSession {
  pid: number;
  run_dir: string;
  raw_video: string;
  events_file: string;
  session_file: string;
  start_epoch: number;
  status: string;
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

export function spawnStudio(args: string[], opts: SpawnOptions = {}): ChildProcess {
  const command = STUDIO_ENGINE === "ts" ? NODE : PYTHON;
  const commandArgs = STUDIO_ENGINE === "ts" ? [TS_CLI, ...args] : ["-m", "studio_agent", ...args];
  return spawn(command, commandArgs, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

export async function loadActiveSession(): Promise<StudioSession | null> {
  const pointer = path.join(PROJECT_ROOT, ".agentic-studio", "current.json");
  try {
    const raw = await fs.readFile(pointer, "utf-8");
    const { session_file } = JSON.parse(raw) as { session_file: string };
    const sessionRaw = await fs.readFile(session_file, "utf-8");
    return JSON.parse(sessionRaw) as StudioSession;
  } catch {
    return null;
  }
}

export async function appendEvent(
  session: StudioSession,
  event: TimelineEvent,
): Promise<TimelineEvent> {
  const raw = await fs.readFile(session.events_file, "utf-8");
  const doc = JSON.parse(raw) as EventsDoc;
  if (event.time === undefined) {
    event.time = Math.max(0, (Date.now() / 1000) - session.start_epoch);
    event.time = Math.round(event.time * 1000) / 1000;
  }
  if (!doc.events) doc.events = [];
  doc.events.push(event);
  doc.events.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  await atomicWriteJson(session.events_file, doc);
  return event;
}

async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, target);
}

export async function readEventsDoc(events_file: string): Promise<EventsDoc> {
  const raw = await fs.readFile(events_file, "utf-8");
  return JSON.parse(raw) as EventsDoc;
}
