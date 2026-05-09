#!/usr/bin/env node
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { runActions } from "./actions.js"
import { renderVideo, RenderOptions } from "./render.js"
import { runEditor } from "./server.js"
import { appendEvent, listRuns, loadActiveSession, startSession, stopSession } from "./session.js"
import { EventsDoc, TimelineEvent } from "./types.js"
import { readJson, StudioError } from "./util.js"

type Flags = Record<string, string | boolean>

function parseFlags(argv: string[], booleanFlags: string[] = []): { flags: Flags; positionals: string[] } {
  const bools = new Set(booleanFlags)
  const flags: Flags = {}
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf("=")
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (bools.has(body)) {
      flags[body] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) flags[body] = true
    else {
      flags[body] = next
      i += 1
    }
  }
  return { flags, positionals }
}

function stringFlag(flags: Flags, name: string, fallback?: string): string | undefined {
  const value = flags[name]
  return typeof value === "string" ? value : fallback
}

function numberFlag(flags: Flags, name: string, fallback?: number): number | undefined {
  const value = flags[name]
  if (value === undefined || value === true) {
    return fallback === undefined || !Number.isFinite(fallback) ? undefined : fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new StudioError(`--${name} must be a number`)
  return parsed
}

function positiveNumberFlag(flags: Flags, name: string, fallback?: number): number | undefined {
  const parsed = numberFlag(flags, name, fallback)
  if (parsed !== undefined && parsed <= 0) throw new StudioError(`--${name} must be greater than 0`)
  return parsed
}

function boolFlag(flags: Flags, name: string): boolean {
  return flags[name] === true
}

function renderOptionsFromFlags(flags: Flags): RenderOptions {
  return {
    crf: numberFlag(flags, "crf", 18),
    preset: stringFlag(flags, "preset", "medium"),
    maxZoomEvents: numberFlag(flags, "max-zoom-events", 32),
    canvas: stringFlag(flags, "canvas", undefined) || null,
    background: stringFlag(flags, "background", "#f3f0ea"),
  }
}

async function eventTime(flags: Flags): Promise<Partial<TimelineEvent>> {
  if (flags.at !== undefined) return { time: Math.round(Number(flags.at) * 1000) / 1000 }
  if (flags.ago !== undefined) {
    const active = await loadActiveSession(process.cwd(), true)
    if (!active) throw new StudioError("No active recording session found.")
    return { time: Math.round(Math.max(0, Date.now() / 1000 - active.start_epoch - Number(flags.ago)) * 1000) / 1000 }
  }
  return {}
}

async function commandStart(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv, ["audio", "no-cursor", "no-clicks"])
  const session = await startSession(process.cwd(), {
    name: stringFlag(flags, "name"),
    outDir: stringFlag(flags, "out-dir", "runs"),
    display: numberFlag(flags, "display"),
    audio: boolFlag(flags, "audio"),
    cursor: !boolFlag(flags, "no-cursor"),
    showClicks: !boolFlag(flags, "no-clicks"),
    duration: positiveNumberFlag(flags, "duration"),
  })
  console.log(`Recording started: ${session.run_dir}`)
  console.log(`Raw video: ${session.raw_video}`)
  console.log(`PID: ${session.pid}`)
}

async function commandMark(argv: string[]): Promise<void> {
  const [eventType, ...rest] = argv
  if (!eventType) throw new StudioError("mark requires an event type")
  const { flags, positionals } = parseFlags(rest, ["no-zoom"])
  const event: TimelineEvent = { type: eventType, ...(await eventTime(flags)) }

  if (eventType === "zoom") {
    Object.assign(event, {
      x: numberFlag(flags, "x"),
      y: numberFlag(flags, "y"),
      scale: numberFlag(flags, "scale", 1.35),
      duration: numberFlag(flags, "duration", 1.4),
      lead: numberFlag(flags, "lead", 0.25),
      label: stringFlag(flags, "label"),
    })
  } else if (eventType === "click") {
    Object.assign(event, {
      x: numberFlag(flags, "x"),
      y: numberFlag(flags, "y"),
      scale: numberFlag(flags, "scale", 1.35),
      duration: numberFlag(flags, "duration", 1.4),
      lead: numberFlag(flags, "lead", 0.25),
      label: stringFlag(flags, "label"),
      zoom: !boolFlag(flags, "no-zoom"),
    })
  } else if (eventType === "caption") {
    Object.assign(event, {
      text: positionals[0],
      duration: numberFlag(flags, "duration", 2),
      position: stringFlag(flags, "position", "bottom"),
    })
  } else if (eventType === "speed") {
    const start = numberFlag(flags, "start", numberFlag(flags, "at"))
    if (start === undefined) throw new StudioError("speed events require --start or --at")
    const end = numberFlag(flags, "end", start + Number(numberFlag(flags, "duration", 2)))
    Object.assign(event, {
      type: "speed",
      start,
      end,
      factor: positiveNumberFlag(flags, "factor", 2.5),
      label: stringFlag(flags, "label"),
    })
  } else if (eventType === "marker") {
    Object.assign(event, { label: positionals[0] || stringFlag(flags, "label") })
  } else {
    throw new StudioError("mark event type must be zoom, click, caption, speed, or marker")
  }

  if ((eventType === "zoom" || eventType === "click") && (event.x === undefined || event.y === undefined)) {
    throw new StudioError(`${eventType} requires --x and --y`)
  }
  const written = await appendEvent(process.cwd(), event)
  console.log(`Marked ${written.type} at ${Number(written.time || 0).toFixed(3)}s`)
}

async function commandStop(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv, ["render"])
  const session = await stopSession(process.cwd(), numberFlag(flags, "timeout", 20))
  console.log(`Recording stopped: ${session.run_dir}`)
  console.log(`Raw video: ${session.raw_video}`)
  if (boolFlag(flags, "render")) {
    const output = path.join(session.run_dir, stringFlag(flags, "output", "final.mp4") || "final.mp4")
    await renderVideo(session.raw_video, session.events_file, output, renderOptionsFromFlags(flags))
    console.log(`Rendered video: ${output}`)
  }
}

async function commandRender(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv)
  const runDir = path.resolve(positionals[0] || "")
  if (!positionals[0]) throw new StudioError("render requires a run directory")
  const sessionFile = path.join(runDir, "session.json")
  let rawVideo = path.join(runDir, "raw.mov")
  let eventsFile = path.join(runDir, "events.json")
  try {
    const session = await readJson<{ raw_video: string; events_file: string }>(sessionFile)
    rawVideo = session.raw_video
    eventsFile = session.events_file
  } catch {
    // Plain run directories are supported.
  }
  const output = path.resolve(stringFlag(flags, "output") || path.join(runDir, "final.mp4"))
  await renderVideo(rawVideo, eventsFile, output, renderOptionsFromFlags(flags))
  console.log(`Rendered video: ${output}`)
}

async function commandRun(argv: string[]): Promise<void> {
  const { flags, positionals } = parseFlags(argv, ["render", "audio", "no-cursor", "no-clicks"])
  const scenarioFile = positionals[0]
  if (!scenarioFile) throw new StudioError("run requires a scenario JSON file")
  const scenario = JSON.parse(await fs.readFile(path.resolve(scenarioFile), "utf-8")) as Record<string, unknown>
  const record = (scenario.record || {}) as Record<string, unknown>
  const render = (scenario.render || {}) as Record<string, unknown>
  const session = await startSession(process.cwd(), {
    name: stringFlag(flags, "name") || String(scenario.name || ""),
    outDir: stringFlag(flags, "out-dir", "runs"),
    display: numberFlag(flags, "display", Number(record.display)),
    audio: boolFlag(flags, "audio") || Boolean(record.audio),
    cursor: !boolFlag(flags, "no-cursor") && record.cursor !== false,
    showClicks: !boolFlag(flags, "no-clicks") && record.show_clicks !== false,
    duration: positiveNumberFlag(flags, "duration", Number(record.duration)),
  })
  console.log(`Recording started: ${session.run_dir}`)
  try {
    await runActions(process.cwd(), session, Array.isArray(scenario.actions) ? (scenario.actions as Array<Record<string, unknown>>) : [])
  } catch (error) {
    await stopSession(process.cwd(), numberFlag(flags, "timeout", 20))
    throw error
  }
  const stopped = await stopSession(process.cwd(), numberFlag(flags, "timeout", 20))
  console.log(`Recording stopped: ${stopped.raw_video}`)

  const shouldRender = boolFlag(flags, "render") || render.enabled !== false
  if (shouldRender) {
    const outputName = stringFlag(flags, "output") || String(render.output || "final.mp4")
    const output = path.join(stopped.run_dir, outputName)
    await renderVideo(stopped.raw_video, stopped.events_file, output, {
      ...renderOptionsFromFlags(flags),
      crf: numberFlag(flags, "crf", Number(render.crf ?? 18)),
      preset: stringFlag(flags, "preset", String(render.preset || "medium")),
      canvas: stringFlag(flags, "canvas") || (render.canvas ? String(render.canvas) : null),
      background: stringFlag(flags, "background", String(render.background || "#f3f0ea")),
    })
    console.log(`Rendered video: ${output}`)
  }
}

async function commandStatus(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv)
  const active = await loadActiveSession(process.cwd(), false)
  if (active) console.log(`Active: ${active.run_dir} pid=${active.pid} status=${active.status}`)
  else console.log("No active recording.")
  const runs = await listRuns(process.cwd())
  if (runs.length > 0) {
    console.log("Runs:")
    for (const run of runs.slice(0, Number(numberFlag(flags, "limit", 10)))) {
      console.log(`  ${run.name} raw=${run.raw} final=${run.final} events=${run.events}`)
    }
  }
}

async function commandEditor(argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv)
  await runEditor(process.cwd(), stringFlag(flags, "host", "127.0.0.1"), Number(numberFlag(flags, "port", 8765)))
}

function printHelp(): void {
  console.log(`studio-agent-ts

Commands:
  start [--name name] [--display n] [--audio] [--duration seconds]
  mark zoom|click|caption|speed|marker ...
  stop [--render] [--output final.mp4]
  render <run-dir> [--output file] [--canvas 1920x1080]
  run <scenario.json>
  status [--limit n]
  editor [--host 127.0.0.1] [--port 8765]`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv
  try {
    if (!command || command === "--help" || command === "-h") {
      printHelp()
      return 0
    }
    if (command === "start") await commandStart(rest)
    else if (command === "mark") await commandMark(rest)
    else if (command === "stop") await commandStop(rest)
    else if (command === "render") await commandRender(rest)
    else if (command === "run") await commandRun(rest)
    else if (command === "status") await commandStatus(rest)
    else if (command === "editor") await commandEditor(rest)
    else throw new StudioError(`Unknown command: ${command}`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`studio-agent-ts: ${message}`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main()
}
