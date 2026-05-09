import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { EventsDoc, RunSummary, StudioSession, TimelineEvent } from "./types.js"
import { ensureTool, exists, nowIso, PROJECT_ROOT, readJson, StudioError, timestampName, writeJson } from "./util.js"

const STATE_DIR_NAME = ".agentic-studio"
const CURRENT_FILE = "current.json"

export interface SessionPaths {
  root: string
  stateDir: string
  currentFile: string
  runDir: string
  rawVideo: string
  eventsFile: string
  sessionFile: string
  recorderLog: string
}

export interface StartOptions {
  name?: string
  outDir?: string
  display?: number | null
  audio?: boolean
  cursor?: boolean
  showClicks?: boolean
  duration?: number | null
}

export function projectPaths(root: string, runDir?: string): SessionPaths {
  const stateDir = path.join(root, STATE_DIR_NAME)
  const actualRunDir = runDir ?? path.join(root, "runs", "manual")
  return {
    root,
    stateDir,
    currentFile: path.join(stateDir, CURRENT_FILE),
    runDir: actualRunDir,
    rawVideo: path.join(actualRunDir, "raw.mov"),
    eventsFile: path.join(actualRunDir, "events.json"),
    sessionFile: path.join(actualRunDir, "session.json"),
    recorderLog: path.join(actualRunDir, "recorder.log"),
  }
}

export function buildScreencaptureCommand(rawVideo: string, opts: StartOptions): string[] {
  const args = ["-v", "-x"]
  if (opts.cursor ?? true) args.push("-C")
  if (opts.showClicks ?? true) args.push("-k")
  if (opts.audio) args.push("-g")
  if (opts.display !== undefined && opts.display !== null) args.push(`-D${opts.display}`)
  if (opts.duration !== undefined && opts.duration !== null) args.push(`-V${opts.duration}`)
  args.push(rawVideo)
  return args
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function loadActiveSession(root = PROJECT_ROOT, required = true): Promise<StudioSession | null> {
  const currentFile = projectPaths(root).currentFile
  if (!(await exists(currentFile))) {
    if (required) throw new StudioError("No active recording session found.")
    return null
  }
  const pointer = await readJson<{ session_file: string }>(currentFile)
  if (!(await exists(pointer.session_file))) {
    if (required) throw new StudioError(`Active session metadata is missing: ${pointer.session_file}`)
    return null
  }
  return readJson<StudioSession>(pointer.session_file)
}

export async function resolveSession(root = PROJECT_ROOT, runDir?: string): Promise<StudioSession> {
  if (!runDir) {
    const active = await loadActiveSession(root, true)
    if (!active) throw new StudioError("No active recording session found.")
    return active
  }
  const sessionFile = path.join(runDir, "session.json")
  if (!(await exists(sessionFile))) throw new StudioError(`No session.json found in ${runDir}`)
  return readJson<StudioSession>(sessionFile)
}

export async function startSession(root = PROJECT_ROOT, opts: StartOptions = {}): Promise<StudioSession> {
  await ensureTool("screencapture")
  const active = await loadActiveSession(root, false)
  if (active && isProcessRunning(active.pid)) {
    throw new StudioError(`A recording is already active in ${active.run_dir} with pid ${active.pid}.`)
  }

  const runName = opts.name || timestampName()
  const baseOut = path.resolve(root, opts.outDir || "runs")
  const runDir = path.join(baseOut, runName)
  const paths = projectPaths(root, runDir)
  await fs.mkdir(paths.runDir, { recursive: true })
  await fs.mkdir(paths.stateDir, { recursive: true })
  if (await exists(paths.rawVideo)) throw new StudioError(`Refusing to overwrite existing video: ${paths.rawVideo}`)

  const logHandle = await fs.open(paths.recorderLog, "a")
  const startedAt = nowIso()
  const startEpoch = Date.now() / 1000
  const child = spawn("screencapture", buildScreencaptureCommand(paths.rawVideo, opts), {
    cwd: root,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  })
  child.unref()
  await new Promise((resolve) => setTimeout(resolve, 700))
  await logHandle.close()
  if (child.exitCode !== null) {
    throw new StudioError(`screencapture exited immediately with code ${child.exitCode}. See ${paths.recorderLog}`)
  }

  const session: StudioSession = {
    version: 1,
    pid: child.pid ?? 0,
    root,
    run_dir: paths.runDir,
    raw_video: paths.rawVideo,
    events_file: paths.eventsFile,
    session_file: paths.sessionFile,
    recorder_log: paths.recorderLog,
    started_at: startedAt,
    start_epoch: startEpoch,
    record: {
      display: opts.display ?? null,
      audio: !!opts.audio,
      cursor: opts.cursor ?? true,
      show_clicks: opts.showClicks ?? true,
      duration: opts.duration ?? null,
    },
    status: "recording",
  }
  const events: EventsDoc = {
    version: 1,
    recording: { started_at: startedAt, start_epoch: startEpoch, raw_video: paths.rawVideo },
    events: [],
  }
  await writeJson(paths.sessionFile, session)
  await writeJson(paths.eventsFile, events)
  await writeJson(paths.currentFile, { session_file: paths.sessionFile })
  return session
}

export async function appendEvent(root = PROJECT_ROOT, event: TimelineEvent, runDir?: string): Promise<TimelineEvent> {
  const session = await resolveSession(root, runDir)
  const doc = await readJson<EventsDoc>(session.events_file)
  const normalized = { ...event }
  if (normalized.time === undefined) {
    normalized.time = Math.max(0, Date.now() / 1000 - doc.recording.start_epoch)
    normalized.time = Math.round(normalized.time * 1000) / 1000
  }
  normalized.created_at ??= nowIso()
  doc.events ??= []
  doc.events.push(normalized)
  doc.events.sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
  await writeJson(session.events_file, doc)
  return normalized
}

export async function stopSession(root = PROJECT_ROOT, timeout = 20): Promise<StudioSession> {
  const session = await resolveSession(root)
  if (session.status !== "stopped" && isProcessRunning(session.pid)) {
    try {
      process.kill(-session.pid, "SIGINT")
    } catch {
      // ignore
    }
    const deadline = Date.now() + timeout * 1000
    while (Date.now() < deadline && isProcessRunning(session.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (isProcessRunning(session.pid)) {
      try {
        process.kill(-session.pid, "SIGTERM")
      } catch {
        // ignore
      }
    }
  }

  const stoppedAt = nowIso()
  const stopEpoch = Date.now() / 1000
  session.status = "stopped"
  session.stopped_at = stoppedAt
  session.stop_epoch = stopEpoch
  await writeJson(session.session_file, session)

  if (await exists(session.events_file)) {
    const doc = await readJson<EventsDoc>(session.events_file)
    doc.recording.stopped_at = stoppedAt
    doc.recording.stop_epoch = stopEpoch
    doc.recording.duration = Math.round((stopEpoch - doc.recording.start_epoch) * 1000) / 1000
    await writeJson(session.events_file, doc)
  }

  const currentFile = projectPaths(root).currentFile
  if (await exists(currentFile)) {
    const pointer = await readJson<{ session_file?: string }>(currentFile)
    if (pointer.session_file === session.session_file) await fs.unlink(currentFile)
  }
  return session
}

export async function listRuns(root = PROJECT_ROOT): Promise<RunSummary[]> {
  const runsDir = path.join(root, "runs")
  if (!(await exists(runsDir))) return []
  const entries = await fs.readdir(runsDir, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(runsDir, entry.name))
  const withTimes = await Promise.all(dirs.map(async (dir) => ({ dir, stat: await fs.stat(dir) })))
  withTimes.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  const runs: RunSummary[] = []
  for (const { dir } of withTimes) {
    const eventsFile = path.join(dir, "events.json")
    let events = 0
    if (await exists(eventsFile)) {
      try {
        events = (await readJson<EventsDoc>(eventsFile)).events?.length ?? 0
      } catch {
        events = 0
      }
    }
    runs.push({
      name: path.basename(dir),
      run_dir: dir,
      raw: await exists(path.join(dir, "raw.mov")),
      final: await exists(path.join(dir, "final.mp4")),
      events,
      session: await exists(path.join(dir, "session.json")),
    })
  }
  return runs
}
