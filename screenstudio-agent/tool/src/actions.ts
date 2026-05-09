import { TimelineEvent, StudioSession } from "./types.js"
import { appendEvent } from "./session.js"
import { run, StudioError } from "./util.js"

const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
}

const MODIFIERS: Record<string, string> = {
  command: "command down",
  cmd: "command down",
  shift: "shift down",
  option: "option down",
  alt: "option down",
  control: "control down",
  ctrl: "control down",
}

function appleString(value: string): string {
  return JSON.stringify(value)
}

async function osascript(lines: string[]): Promise<void> {
  const args = lines.flatMap((line) => ["-e", line])
  const result = await run("osascript", args, { reject: false })
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new StudioError(detail || "osascript failed")
  }
}

export async function focusApp(name: string): Promise<void> {
  await osascript([`tell application ${appleString(name)} to activate`])
}

export async function openUrl(url: string): Promise<void> {
  await run("open", [url])
}

export async function typeText(text: string): Promise<void> {
  await osascript(['tell application "System Events"', `keystroke ${appleString(text)}`, "end tell"])
}

export async function pasteText(text: string): Promise<void> {
  await run("pbcopy", [], { input: text })
  await hotkey(["command", "v"])
}

export async function hotkey(keys: string[]): Promise<void> {
  if (keys.length === 0) throw new StudioError("hotkey action requires keys")
  const modifiers = keys
    .slice(0, -1)
    .map((key) => MODIFIERS[key.toLowerCase()])
    .filter((value): value is string => Boolean(value))
  const key = keys[keys.length - 1].toLowerCase()
  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : ""
  let command: string
  if (KEY_CODES[key] !== undefined) command = `key code ${KEY_CODES[key]}${using}`
  else if (key.length === 1) command = `keystroke ${appleString(key)}${using}`
  else throw new StudioError(`Unsupported hotkey key: ${key}`)
  await osascript(['tell application "System Events"', command, "end tell"])
}

export async function press(key: string): Promise<void> {
  await hotkey([key])
}

export async function click(x: number, y: number): Promise<void> {
  await osascript(['tell application "System Events"', `click at {${Math.round(x)}, ${Math.round(y)}}`, "end tell"])
}

export async function runShell(command: string, cwd?: string): Promise<void> {
  await run("sh", ["-lc", command], { cwd })
}

function actionTime(session: StudioSession): number {
  return Math.round(Math.max(0, Date.now() / 1000 - session.start_epoch) * 1000) / 1000
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

function actionNumber(action: Record<string, unknown>, key: string, fallback?: number): number {
  const parsed = Number(action[key] ?? fallback)
  if (!Number.isFinite(parsed)) throw new StudioError(`${key} must be a number`)
  return parsed
}

export async function runActions(root: string, session: StudioSession, actions: Array<Record<string, unknown>>): Promise<void> {
  for (const [index, action] of actions.entries()) {
    const kind = String(action.type || "")
    if (!kind) throw new StudioError(`Action #${index + 1} is missing a type`)

    const before = actionTime(session)
    if (kind === "wait") {
      await sleep(actionNumber(action, "seconds", Number(action.duration ?? 1)))
    } else if (kind === "focus_app") {
      await focusApp(String(action.name))
    } else if (kind === "open_url") {
      await openUrl(String(action.url))
    } else if (kind === "type") {
      const text = String(action.text || "")
      if (action.paste || text.length > 80) await pasteText(text)
      else await typeText(text)
    } else if (kind === "paste") {
      await pasteText(String(action.text || ""))
    } else if (kind === "hotkey") {
      await hotkey((action.keys as unknown[]).map(String))
    } else if (kind === "press") {
      await press(String(action.key))
    } else if (kind === "click") {
      const x = actionNumber(action, "x")
      const y = actionNumber(action, "y")
      await appendEvent(root, {
        type: "click",
        time: before,
        x,
        y,
        scale: actionNumber(action, "scale", 1.35),
        duration: actionNumber(action, "duration", 1.4),
        lead: actionNumber(action, "lead", 0.25),
        label: action.label,
        zoom: action.zoom !== false,
      })
      await click(x, y)
    } else if (kind === "zoom") {
      await appendEvent(root, {
        type: "zoom",
        time: before,
        x: actionNumber(action, "x"),
        y: actionNumber(action, "y"),
        scale: actionNumber(action, "scale", 1.35),
        duration: actionNumber(action, "duration", 1.4),
        lead: actionNumber(action, "lead", 0.25),
        label: action.label,
      })
    } else if (kind === "caption") {
      await appendEvent(root, {
        type: "caption",
        time: before,
        text: String(action.text),
        duration: actionNumber(action, "duration", 2),
        position: String(action.position || "bottom"),
      })
    } else if (kind === "speed") {
      const start = actionNumber(action, "start", before)
      const end = action.end === undefined ? start + actionNumber(action, "duration", 2) : actionNumber(action, "end")
      await appendEvent(root, {
        type: "speed",
        time: start,
        start,
        end,
        factor: actionNumber(action, "factor", 2.5),
        label: action.label,
      })
    } else if (kind === "marker") {
      const event: TimelineEvent = { ...action, type: "marker", time: before }
      await appendEvent(root, event)
    } else if (kind === "shell") {
      await runShell(String(action.command), action.cwd === undefined ? undefined : String(action.cwd))
    } else {
      const known = "wait, focus_app, open_url, type, paste, hotkey, press, click, zoom, speed, caption, marker, shell"
      throw new StudioError(`Unsupported action #${index + 1}: ${kind}. Known actions: ${known}`)
    }

    const after = actionNumber(action, "after", 0)
    if (after > 0) await sleep(after)
  }
}
