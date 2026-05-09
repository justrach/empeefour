import { promises as fs } from "node:fs"
import * as path from "node:path"
import { EventsDoc, TimelineEvent } from "./types.js"
import { ensureTool, exists, readJson, run, StudioError } from "./util.js"

const FILTER_CACHE = new Map<string, boolean>()

export interface VideoInfo {
  width: number
  height: number
  duration: number | null
  fps: number
}

interface ZoomEvent {
  time: number
  x: number
  y: number
  scale: number
  duration: number
  lead: number
  out: number
}

interface CaptionEvent {
  time: number
  text: string
  duration: number
  position: string
}

interface SpeedEvent {
  start: number
  end: number
  factor: number
  label?: unknown
}

interface CutEvent {
  start: number
  end: number
  label?: unknown
}

interface TimelineSegment {
  start: number
  end: number
  factor: number
  cut: boolean
}

export interface RenderOptions {
  crf?: number
  preset?: string
  maxZoomEvents?: number
  canvas?: string | null
  background?: string
}

const DEFAULT_RENDER_OPTIONS: Required<RenderOptions> = {
  crf: 18,
  preset: "medium",
  maxZoomEvents: 32,
  canvas: null,
  background: "#f3f0ea",
}

function renderOptions(options: RenderOptions = {}): Required<RenderOptions> {
  return { ...DEFAULT_RENDER_OPTIONS, ...options }
}

function numberFrom(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function numberRequired(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new StudioError(`${label} must be a number`)
  return parsed
}

export async function ffprobe(file: string): Promise<VideoInfo> {
  await ensureTool("ffprobe")
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration,avg_frame_rate,r_frame_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { reject: false },
  )
  if (result.code !== 0) throw new StudioError(result.stderr.trim() || `Unable to probe ${file}`)
  const data = JSON.parse(result.stdout) as {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  const stream = data.streams?.[0]
  if (!stream) throw new StudioError(`No video stream found in ${file}`)
  const duration = stream.duration ?? data.format?.duration
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    duration: duration === undefined || duration === null ? null : Number(duration),
    fps: parseFrameRate(String(stream.avg_frame_rate || stream.r_frame_rate || "30/1")),
  }
}

export function parseFrameRate(value: string): number {
  if (value.includes("/")) {
    const [numerator, denominator] = value.split("/", 2)
    const den = Number(denominator)
    if (den === 0) return 30
    return Math.max(1, Number(numerator) / den)
  }
  return Math.max(1, Number(value))
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      file,
    ],
    { reject: false },
  )
  return result.code === 0 && result.stdout.trim().length > 0
}

export async function hasFfmpegFilter(name: string): Promise<boolean> {
  const cached = FILTER_CACHE.get(name)
  if (cached !== undefined) return cached
  await ensureTool("ffmpeg")
  const result = await run("ffmpeg", ["-hide_banner", "-filters"], { reject: false })
  const available = result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[1] === name)
  FILTER_CACHE.set(name, available)
  return available
}

export async function readEvents(eventsFile: string): Promise<TimelineEvent[]> {
  const doc = await readJson<EventsDoc>(eventsFile)
  return Array.isArray(doc.events) ? doc.events : []
}

function zoomsFromEvents(events: TimelineEvent[], maxEvents = 32): ZoomEvent[] {
  const zooms: ZoomEvent[] = []
  for (const event of events) {
    const kind = event.type
    if (kind !== "zoom" && !(kind === "click" && event.zoom !== false)) continue
    if (event.x === undefined || event.y === undefined) continue
    const scale = numberFrom(event.scale, 1.35)
    if (scale <= 1) continue
    const duration = Math.max(0.2, numberFrom(event.duration, 1.4))
    let lead = Math.max(0, numberFrom(event.lead, 0.25))
    let out = Math.max(0.05, numberFrom(event.out, Math.min(0.35, duration / 3)))
    if (lead + out >= duration) {
      lead = Math.min(lead, duration * 0.4)
      out = Math.min(out, duration * 0.4)
    }
    zooms.push({
      time: Math.max(0, numberFrom(event.time, 0)),
      x: numberRequired(event.x, "x"),
      y: numberRequired(event.y, "y"),
      scale,
      duration,
      lead,
      out,
    })
  }
  return zooms.sort((a, b) => a.time - b.time).slice(0, maxEvents)
}

function captionsFromEvents(events: TimelineEvent[]): CaptionEvent[] {
  const captions: CaptionEvent[] = []
  for (const event of events) {
    if (event.type !== "caption" || !event.text) continue
    captions.push({
      time: Math.max(0, numberFrom(event.time, 0)),
      text: String(event.text),
      duration: Math.max(0.2, numberFrom(event.duration, 2)),
      position: String(event.position || "bottom"),
    })
  }
  return captions.sort((a, b) => a.time - b.time)
}

function speedEventsFromEvents(events: TimelineEvent[], duration: number | null): SpeedEvent[] {
  const speeds: SpeedEvent[] = []
  for (const event of events) {
    if (event.type !== "speed") continue
    let start = numberFrom(event.start ?? event.time, 0)
    let end = event.end !== undefined ? numberRequired(event.end, "end") : start + numberFrom(event.duration, 0)
    const factor = numberFrom(event.factor ?? event.speed, 1)
    if (factor <= 0) throw new StudioError("Speed factor must be greater than 0")
    if (duration !== null) {
      start = Math.min(Math.max(0, start), duration)
      end = Math.min(Math.max(0, end), duration)
    }
    if (end > start) speeds.push({ start, end, factor, label: event.label })
  }
  speeds.sort((a, b) => a.start - b.start)

  const normalized: SpeedEvent[] = []
  let lastEnd = 0
  for (const speed of speeds) {
    const start = Math.max(speed.start, lastEnd)
    if (speed.end <= start) continue
    normalized.push({ ...speed, start })
    lastEnd = speed.end
  }
  return normalized
}

function cutEventsFromEvents(events: TimelineEvent[], duration: number | null): CutEvent[] {
  const cuts: CutEvent[] = []
  for (const event of events) {
    if (event.type !== "cut") continue
    let start = numberFrom(event.start ?? event.time, 0)
    let end = numberFrom(event.end, start)
    if (duration !== null) {
      start = Math.min(Math.max(0, start), duration)
      end = Math.min(Math.max(0, end), duration)
    }
    if (end > start) cuts.push({ start, end, label: event.label })
  }
  return cuts.sort((a, b) => a.start - b.start)
}

function timelineSegments(duration: number, speeds: SpeedEvent[], cuts: CutEvent[] = []): TimelineSegment[] {
  const cutRanges = cuts.map((cut) => [cut.start, cut.end] as const)
  const trimmedSpeeds: SpeedEvent[] = []
  for (const speed of speeds) {
    let cur = speed.start
    const overlaps = cutRanges
      .filter(([start, end]) => end > speed.start && start < speed.end)
      .sort((a, b) => a[0] - b[0])
    for (const [cutStart, cutEnd] of overlaps) {
      if (cur < cutStart) trimmedSpeeds.push({ ...speed, start: cur, end: cutStart })
      cur = Math.max(cur, cutEnd)
    }
    if (cur < speed.end) trimmedSpeeds.push({ ...speed, start: cur })
  }

  const items = [
    ...trimmedSpeeds.map((speed) => ({ start: speed.start, end: speed.end, factor: speed.factor, cut: false })),
    ...cuts.map((cut) => ({ start: cut.start, end: cut.end, factor: 1, cut: true })),
  ].sort((a, b) => a.start - b.start)

  const segments: TimelineSegment[] = []
  let cursor = 0
  for (const item of items) {
    if (item.start > cursor) segments.push({ start: cursor, end: item.start, factor: 1, cut: false })
    segments.push(item)
    cursor = item.end
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration, factor: 1, cut: false })
  return segments.filter((segment) => segment.end - segment.start > 0.001)
}

function mappedTime(timeValue: number, segments: TimelineSegment[]): number {
  let elapsed = 0
  for (const segment of segments) {
    if (segment.cut) {
      if (segment.start <= timeValue && timeValue < segment.end) return elapsed
      if (timeValue >= segment.end) continue
      return elapsed
    }
    if (timeValue >= segment.end) {
      elapsed += (segment.end - segment.start) / segment.factor
      continue
    }
    if (timeValue <= segment.start) return elapsed
    elapsed += (timeValue - segment.start) / segment.factor
    return elapsed
  }
  return elapsed
}

function speedFactorAt(timeValue: number, segments: TimelineSegment[]): number {
  for (const segment of segments) {
    if (segment.cut) continue
    if (segment.start <= timeValue && timeValue < segment.end) return segment.factor
  }
  return 1
}

function isInCut(timeValue: number, segments: TimelineSegment[]): boolean {
  return segments.some((segment) => segment.cut && segment.start <= timeValue && timeValue < segment.end)
}

function retimeEvents(events: TimelineEvent[], segments: TimelineSegment[]): TimelineEvent[] {
  const retimed: TimelineEvent[] = []
  for (const event of events) {
    if (event.type === "speed" || event.type === "cut") continue
    const item = { ...event }
    if (item.time !== undefined) {
      const originalTime = numberRequired(item.time, "time")
      if (isInCut(originalTime, segments)) continue
      item.time = Math.round(mappedTime(originalTime, segments) * 1000) / 1000
      const factor = speedFactorAt(originalTime, segments)
      for (const key of ["duration", "lead", "out"] as const) {
        if (item[key] !== undefined) {
          item[key] = Math.round((numberRequired(item[key], key) / factor) * 1000) / 1000
        }
      }
    }
    retimed.push(item)
  }
  return retimed.sort((a, b) => numberFrom(a.time, 0) - numberFrom(b.time, 0))
}

function num(value: number): string {
  if (Math.abs(value - Math.round(value)) < 1e-9) return String(Math.round(value))
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
}

function pulseExpr(event: ZoomEvent, timeVar = "t"): string {
  const start = Math.max(0, event.time - event.lead)
  const inD = Math.max(0.001, event.time - start)
  const end = start + event.duration
  const outStart = Math.max(event.time, end - event.out)

  const s = num(start)
  const tInEnd = num(start + inD)
  const tHoldEnd = num(outStart)
  const tEnd = num(end)
  const inDS = num(inD)
  const outDS = num(event.out)
  const outStartS = num(outStart)

  const easeIn = `(0.5-0.5*cos(PI*((${timeVar})-${s})/${inDS}))`
  const easeOut = `(0.5+0.5*cos(PI*((${timeVar})-${outStartS})/${outDS}))`
  return (
    `if(lt((${timeVar}),${s}),0,` +
    `if(lt((${timeVar}),${tInEnd}),${easeIn},` +
    `if(lt((${timeVar}),${tHoldEnd}),1,` +
    `if(lt((${timeVar}),${tEnd}),${easeOut},0))))`
  )
}

function buildZoomFilter(info: VideoInfo, zooms: ZoomEvent[]): string {
  if (zooms.length === 0) return "setsar=1"
  const fps = "60"
  const timeVar = `(on/${fps})`
  const pulses = zooms.map((event) => pulseExpr(event, timeVar))
  const pulseSum = pulses.map((pulse) => `(${pulse})`).join("+")
  const zoomExpr = `1+${zooms
    .map((event, index) => `(${num(event.scale - 1)})*(${pulses[index]})`)
    .join("+")}`
  const cxWeighted = zooms.map((event, index) => `(${num(event.x)})*(${pulses[index]})`).join("+")
  const cyWeighted = zooms.map((event, index) => `(${num(event.y)})*(${pulses[index]})`).join("+")
  const cxExpr = `if(gt((${pulseSum}),0.001),(${cxWeighted})/(${pulseSum}),${num(info.width / 2)})`
  const cyExpr = `if(gt((${pulseSum}),0.001),(${cyWeighted})/(${pulseSum}),${num(info.height / 2)})`
  const cropX = `min(max((${cxExpr})-iw/(${zoomExpr})/2,0),iw-iw/(${zoomExpr}))`
  const cropY = `min(max((${cyExpr})-ih/(${zoomExpr})/2,0),ih-ih/(${zoomExpr}))`
  return `fps=${fps},zoompan=z='${zoomExpr}':x='${cropX}':y='${cropY}':d=1:s=${info.width}x${info.height}:fps=${fps},setsar=1`
}

function parseCanvas(canvas: string | null | undefined): [number, number] | null {
  if (!canvas) return null
  if (!canvas.includes("x")) throw new StudioError("Canvas must be formatted like 1920x1080")
  const [widthRaw, heightRaw] = canvas.toLowerCase().split("x", 2)
  const width = Number(widthRaw)
  const height = Number(heightRaw)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new StudioError("Canvas dimensions must be positive integers")
  }
  return [width, height]
}

function canvasFilter(canvas: string | null | undefined, background: string): string | null {
  const parsed = parseCanvas(canvas)
  if (!parsed) return null
  const [width, height] = parsed
  const maxW = Math.max(2, width - 192)
  const maxH = Math.max(2, height - 144)
  return `scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${background}`
}

function drawtextEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/\n/g, " ")
}

function captionFilter(caption: CaptionEvent): string {
  const start = num(caption.time)
  const end = num(caption.time + caption.duration)
  const y = caption.position === "top" ? "48" : "h-text_h-56"
  const text = drawtextEscape(caption.text)
  return (
    `drawtext=text='${text}':` +
    "x=(w-text_w)/2:" +
    `y=${y}:` +
    "fontsize=42:" +
    "fontcolor=white:" +
    "box=1:" +
    "boxcolor=black@0.58:" +
    "boxborderw=18:" +
    `enable='between(t,${start},${end})'`
  )
}

function buildFilter(
  info: VideoInfo,
  events: TimelineEvent[],
  options: Required<RenderOptions>,
  captionsEnabled: boolean,
): string {
  const parts = [buildZoomFilter(info, zoomsFromEvents(events, options.maxZoomEvents))]
  const canvas = canvasFilter(options.canvas, options.background)
  if (canvas) parts.push(canvas)
  if (captionsEnabled) parts.push(...captionsFromEvents(events).map(captionFilter))
  parts.push("format=yuv420p")
  return parts.join(",")
}

function atempoChain(factor: number): string {
  const parts: number[] = []
  let remaining = factor
  while (remaining > 2) {
    parts.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    parts.push(0.5)
    remaining /= 0.5
  }
  parts.push(remaining)
  return parts.map((part) => `atempo=${num(part)}`).join(",")
}

async function renderSpeedAdjustedSource(rawVideo: string, tempVideo: string, segments: TimelineSegment[]): Promise<string> {
  await ensureTool("ffmpeg")
  const audio = await hasAudioStream(rawVideo)
  const filters: string[] = []
  const concatInputs: string[] = []
  let kept = 0
  for (const [index, segment] of segments.entries()) {
    if (segment.cut) continue
    const start = num(segment.start)
    const end = num(segment.end)
    const factor = num(segment.factor)
    filters.push(`[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${factor}[v${index}]`)
    concatInputs.push(`[v${index}]`)
    if (audio) {
      filters.push(
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempoChain(segment.factor)}[a${index}]`,
      )
      concatInputs.push(`[a${index}]`)
    }
    kept += 1
  }
  if (kept === 0) throw new StudioError("Cuts removed every frame; nothing to render")

  let mapArgs: string[]
  if (audio) {
    filters.push(`${concatInputs.join("")}concat=n=${kept}:v=1:a=1[v][a]`)
    mapArgs = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"]
  } else {
    filters.push(`${concatInputs.join("")}concat=n=${kept}:v=1:a=0[v]`)
    mapArgs = ["-map", "[v]", "-an"]
  }

  await fs.mkdir(path.dirname(tempVideo), { recursive: true })
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      rawVideo,
      "-filter_complex",
      filters.join(";"),
      ...mapArgs,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "14",
      "-movflags",
      "+faststart",
      tempVideo,
    ],
    { reject: false },
  )
  if (result.code !== 0) throw new StudioError(result.stderr.trim())
  return tempVideo
}

export async function renderVideo(rawVideo: string, eventsFile: string, output: string, options: RenderOptions = {}): Promise<string> {
  await ensureTool("ffmpeg")
  if (!(await exists(rawVideo))) throw new StudioError(`Raw recording does not exist: ${rawVideo}`)
  if (!(await exists(eventsFile))) throw new StudioError(`Events file does not exist: ${eventsFile}`)

  const opts = renderOptions(options)
  let info = await ffprobe(rawVideo)
  const events = await readEvents(eventsFile)
  const speedEvents = speedEventsFromEvents(events, info.duration)
  const cutEvents = cutEventsFromEvents(events, info.duration)
  let sourceVideo = rawVideo
  let renderEvents = events
  let tempVideo: string | null = null

  if (speedEvents.length > 0 || cutEvents.length > 0) {
    if (info.duration === null) throw new StudioError("Cannot apply speed/cut events when input duration is unknown")
    const segments = timelineSegments(info.duration, speedEvents, cutEvents)
    renderEvents = retimeEvents(events, segments)
    tempVideo = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.${process.pid}.speed.mp4`)
    sourceVideo = await renderSpeedAdjustedSource(rawVideo, tempVideo, segments)
    info = await ffprobe(sourceVideo)
  }

  const captionsEnabled = await hasFfmpegFilter("drawtext")
  const vf = buildFilter(info, renderEvents, opts, captionsEnabled)
  await fs.mkdir(path.dirname(output), { recursive: true })
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      sourceVideo,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      opts.preset,
      "-crf",
      String(opts.crf),
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      output,
    ],
    { reject: false },
  )
  if (tempVideo) await fs.unlink(tempVideo).catch(() => undefined)
  if (result.code !== 0) throw new StudioError(result.stderr.trim())
  return output
}
