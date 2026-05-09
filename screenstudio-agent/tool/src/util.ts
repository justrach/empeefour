import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"

export class StudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StudioError"
  }
}

export const PROJECT_ROOT = path.resolve(new URL("../..", import.meta.url).pathname)

export function nowIso(): string {
  return new Date().toISOString()
}

export function timestampName(prefix = "take"): string {
  const d = new Date()
  const pad = (value: number): string => String(value).padStart(2, "0")
  return [
    `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  ].join("-")
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as T
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8")
  await fs.rename(tmp, file)
}

export async function ensureTool(name: string): Promise<string> {
  const result = await run("which", [name], { reject: false })
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new StudioError(`Required tool not found on PATH: ${name}`)
  }
  return result.stdout.trim()
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  command: string,
  args: string[] = [],
  opts: { cwd?: string; input?: string; reject?: boolean } = {},
): Promise<RunResult> {
  const reject = opts.reject ?? true
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf-8")
    child.stderr.setEncoding("utf-8")
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr }
      if (reject && result.code !== 0) {
        rejectPromise(new StudioError(stderr.trim() || stdout.trim() || `${command} exited ${result.code}`))
      } else {
        resolve(result)
      }
    })
    if (opts.input) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

export function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
