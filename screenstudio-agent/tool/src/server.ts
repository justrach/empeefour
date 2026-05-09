import { createReadStream, promises as fs } from "node:fs"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import * as path from "node:path"
import { URL } from "node:url"
import { renderVideo, RenderOptions } from "./render.js"
import { listRuns, loadActiveSession, startSession, stopSession } from "./session.js"
import { PROJECT_ROOT, readJson, StudioError, writeJson, exists } from "./util.js"
import { StudioSession } from "./types.js"

const MEDIA_FILES = new Set(["raw.mov", "final.mp4", "final-ts.mp4"])

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".mp4": "video/mp4",
      ".mov": "video/quicktime",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[ext] || "application/octet-stream"
  )
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
} as const

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(data, null, 2))
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    ...CORS_HEADERS,
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString("utf-8")
  return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

function safeRunDir(root: string, name: string): string {
  const decoded = decodeURIComponent(name)
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
    throw new StudioError("Invalid run name")
  }
  const runsRoot = path.resolve(root, "runs")
  const runDir = path.resolve(runsRoot, decoded)
  if (runDir !== runsRoot && !runDir.startsWith(runsRoot + path.sep)) throw new StudioError("Run path escaped runs directory")
  return runDir
}

async function safeMediaFile(root: string, runName: string, fileName: string): Promise<string> {
  if (!MEDIA_FILES.has(fileName)) throw new StudioError("Invalid media file")
  const file = path.join(safeRunDir(root, runName), fileName)
  if (!(await exists(file))) throw new StudioError(`Media file not found: ${fileName}`)
  return file
}

function outputInsideRun(runDir: string, outputName: unknown): string {
  const output = path.resolve(runDir, String(outputName || "final.mp4"))
  if (output !== runDir && !output.startsWith(runDir + path.sep)) throw new StudioError("Output path escaped run directory")
  return output
}

function optionsFromPayload(payload: Record<string, unknown>): RenderOptions {
  return {
    crf: Number(payload.crf ?? 18),
    preset: String(payload.preset || "medium"),
    maxZoomEvents: Number(payload.maxZoomEvents ?? payload.max_zoom_events ?? 32),
    canvas: payload.canvas ? String(payload.canvas) : null,
    background: String(payload.background || "#f3f0ea"),
  }
}

async function serveStatic(root: string, res: ServerResponse, urlPath: string): Promise<void> {
  const webDir = path.join(root, "studio_agent", "web")
  const requested = urlPath === "/" || urlPath === "" ? "index.html" : urlPath === "/debug" ? "debug.html" : urlPath.slice(1)
  const file = path.resolve(webDir, requested)
  const webRoot = path.resolve(webDir)
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
    res.writeHead(404, CORS_HEADERS)
    res.end()
    return
  }
  try {
    const payload = await fs.readFile(file)
    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Content-Length": payload.length,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      ...CORS_HEADERS,
    })
    res.end(payload)
  } catch {
    res.writeHead(404, CORS_HEADERS)
    res.end()
  }
}

async function serveFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const stat = await fs.stat(file)
  const size = stat.size
  const range = req.headers.range
  if (range?.startsWith("bytes=")) {
    const [startRaw, endRaw] = range.slice("bytes=".length).split("-", 2)
    const start = Number(startRaw || 0)
    const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, ...CORS_HEADERS })
      res.end()
      return
    }
    res.writeHead(206, {
      "Content-Type": contentType(file),
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      ...CORS_HEADERS,
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    "Content-Type": contentType(file),
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    ...CORS_HEADERS,
  })
  createReadStream(file).pipe(res)
}

async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Browser preflight (Next.js dev → 127.0.0.1:8765 is cross-origin).
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Length": "0", ...CORS_HEADERS })
    res.end()
    return
  }
  const parsed = new URL(req.url || "/", "http://127.0.0.1")
  const urlPath = parsed.pathname

  if (req.method === "GET" && urlPath === "/api/status") {
    sendJson(res, { active: await loadActiveSession(root, false) })
    return
  }
  if (req.method === "GET" && urlPath === "/api/runs") {
    sendJson(res, { runs: await listRuns(root) })
    return
  }
  if (req.method === "GET" && urlPath.startsWith("/api/runs/") && urlPath.endsWith("/events")) {
    const name = urlPath.slice("/api/runs/".length, -"/events".length).replace(/^\/|\/$/g, "")
    sendJson(res, await readJson(path.join(safeRunDir(root, name), "events.json")))
    return
  }
  if (req.method === "PUT" && urlPath.startsWith("/api/runs/") && urlPath.endsWith("/events")) {
    const name = urlPath.slice("/api/runs/".length, -"/events".length).replace(/^\/|\/$/g, "")
    const payload = await readJsonBody(req)
    if (!Array.isArray(payload.events)) throw new StudioError("events payload must contain an events array")
    await writeJson(path.join(safeRunDir(root, name), "events.json"), payload)
    sendJson(res, { ok: true })
    return
  }
  if (req.method === "POST" && urlPath === "/api/record/start") {
    const payload = await readJsonBody(req)
    const session = await startSession(root, {
      name: payload.name ? String(payload.name) : undefined,
      display: payload.display === undefined || payload.display === "" ? null : Number(payload.display),
      audio: Boolean(payload.audio),
      cursor: payload.cursor === undefined ? true : Boolean(payload.cursor),
      showClicks: payload.show_clicks === undefined ? true : Boolean(payload.show_clicks),
      duration: payload.duration === undefined || payload.duration === "" ? null : Number(payload.duration),
    })
    sendJson(res, { ok: true, session })
    return
  }
  if (req.method === "POST" && urlPath === "/api/record/stop") {
    const payload = await readJsonBody(req)
    const session = await stopSession(root, Number(payload.timeout ?? 20))
    const result: Record<string, unknown> = { ok: true, session }
    if (payload.render) {
      const output = outputInsideRun(session.run_dir, payload.output)
      await renderVideo(session.raw_video, session.events_file, output, optionsFromPayload(payload))
      result.output = output
    }
    sendJson(res, result)
    return
  }
  if (req.method === "POST" && urlPath.startsWith("/api/runs/") && urlPath.endsWith("/render")) {
    const name = urlPath.slice("/api/runs/".length, -"/render".length).replace(/^\/|\/$/g, "")
    const runDir = safeRunDir(root, name)
    const payload = await readJsonBody(req)
    const sessionFile = path.join(runDir, "session.json")
    let rawVideo = path.join(runDir, "raw.mov")
    let eventsFile = path.join(runDir, "events.json")
    if (await exists(sessionFile)) {
      const session = await readJson<StudioSession>(sessionFile)
      rawVideo = session.raw_video
      eventsFile = session.events_file
    }
    const output = outputInsideRun(runDir, payload.output)
    await renderVideo(rawVideo, eventsFile, output, optionsFromPayload(payload))
    sendJson(res, { ok: true, output })
    return
  }
  if (req.method === "GET" && urlPath.startsWith("/media/runs/")) {
    const [runName, fileName] = urlPath.slice("/media/runs/".length).split("/", 2)
    if (!runName || !fileName) throw new StudioError("Invalid media path")
    await serveFile(req, res, await safeMediaFile(root, runName, fileName))
    return
  }
  if (req.method === "GET") {
    await serveStatic(root, res, urlPath)
    return
  }
  sendJson(res, { error: "Not found" }, 404)
}

export function runEditor(root = PROJECT_ROOT, host = "127.0.0.1", port = 8765): Promise<void> {
  const resolvedRoot = path.resolve(root)
  const server = createServer((req, res) => {
    handle(resolvedRoot, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, { error: message }, error instanceof StudioError ? 400 : 500)
    })
  })
  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, host, () => {
      console.log(`Timeline editor: http://${host}:${port}`)
      console.log(`Project root: ${resolvedRoot}`)
    })
  })
}
