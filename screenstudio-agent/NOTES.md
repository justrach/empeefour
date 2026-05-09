# screenstudio-agent — How it works, how to use it, and the case for going CLI-only


## Hackathon build status (2026-05-09)

What's added on top of the original CLI:

- **`studio-agent listen`** — opens an OpenAI Realtime (`gpt-realtime-2`) WebSocket, streams the mic in via `ffmpeg -f avfoundation`, registers `mark_zoom` / `mark_click` / `mark_caption` / `mark_speed` / `mark_marker` as native tools. The model emits tool calls, which become events on the active session's `events.json`. "Here"/"this" resolves to the current cursor via Quartz.
- **`studio-agent polish <run-dir>`** — shells out to `graff` (Codex / gpt-5.5) with the timeline JSON, gets back an improved version with refined labels and added captions. Writes to `events.polished.json` by default; `--apply` overwrites.
- **`studio-agent demo`** — one-shot: starts a recording, runs the voice listener, on `Ctrl+C` stops + renders. The 60-second pitch button.
- **Electron shell (`electron/`)** — wraps the existing web editor in a native window, spawns the editor server on launch, and adds a "Voice Mode" toggle that drives `studio-agent listen` via IPC. Live event polling shows new events appearing as you speak.

### Demo script (60 seconds)

```bash
# one-time setup
pip install -e ".[voice]"        # websockets + pyobjc-framework-Quartz
cd electron && npm install        # one-time, ~150MB

# the actual demo
cd electron && npm start          # opens the Electron app
# inside the app:
#   1. Click "Start" — recording begins
#   2. Click "Start Voice Mode" — listener attaches
#   3. Talk: "zoom in here ... caption this as Click the menu ... speed this up"
#   4. Watch events stream into the timeline live
#   5. Click "Stop" — renders final.mp4
#   6. (Optional) studio-agent polish runs/<take>  for an extra graff pass
```

CLI-only flow (judges who want to see the engine):
```bash
studio-agent demo --canvas 1920x1080
# talk naturally; Ctrl+C when done; final.mp4 is written
```

### Track angles

- **OpenAI / Codex (Best use of GPT-5.5)** — the realtime model handles voice→intent→tool calls in one streaming connection; graff/Codex/gpt-5.5 does the post-recording polish.
- **Gemini Voice Agent (alternative)** — swap the listen.py WebSocket target for Gemini flash-3.1-live; structure is the same.
- **The agent decides the edits** — judge sees zero manual timeline work.

## What it actually is

A small local prototype for **agentic product-demo recording on macOS**. The premise:
something (a human, an agent like Codex `@Computer`, or a JSON scenario) drives the
screen while the agent records, logs timeline events as they happen, then renders a
Screen-Studio-style polished video — zooms, click pulses, captions, speed-ups —
through `ffmpeg`.

Every take lives in plain folders, no database:

```
runs/<take>/
  raw.mov         # what screencapture wrote
  events.json     # the timeline (zoom/click/caption/speed/marker)
  session.json    # PID, start_epoch, render config
  final.mp4       # ffmpeg output
.agentic-studio/
  current.json    # pointer to the active session.json
```

That's the whole state model. The pointer file is how `mark` knows which run
to append to without you naming it.

## How the pieces fit

| File | Role |
|------|------|
| `studio_agent/cli.py` | argparse entry. Subcommands: `start`, `mark {zoom,click,caption,speed,marker}`, `stop`, `render`, `run`, `status`, `editor`. Installed as `studio-agent`. |
| `studio_agent/session.py` | Spawns `screencapture -v -x` as a detached subprocess, writes `session.json` and the `current.json` pointer, appends to `events.json`, stops via SIGINT to the process group. |
| `studio_agent/actions.py` | AppleScript shim. `focus_app`, `open_url`, `type`, `paste` (via `pbcopy`+⌘V), `hotkey`, `press`, `click`, `shell` — plus event-emitting `click`/`zoom`/`caption`/`speed`/`marker` for scenarios. |
| `studio_agent/render.py` | The interesting one. Reads `events.json`, derives speed segments → retimes the rest, builds an ffmpeg `-filter_complex` with eased zoom/pan, draws caption overlays via `drawtext`, optionally composites onto a 1920×1080 canvas with a background color. |
| `studio_agent/server.py` | A `BaseHTTPRequestHandler` wrapping the same primitives. GETs runs/events, PUTs events.json, POSTs `/api/record/{start,stop}` and `/api/runs/<name>/render`. Serves `raw.mov` with HTTP Range support so the browser can scrub. |

The recorder is just `screencapture` — no AVFoundation, no ScreenCaptureKit. That's
why it works without a build step but also why some Screen-Studio things (cursor
path reconstruction, semantic anchoring) are listed as "next layers" in the README.

## How to use it (today)

### Live, agent-driven (what Codex would actually do)

```bash
python3 -m studio_agent start --name demo
# ...agent or human drives the screen...
python3 -m studio_agent mark click   --x 900 --y 520 --ago 0.2
python3 -m studio_agent mark zoom    --x 900 --y 520 --scale 1.45 --duration 1.6
python3 -m studio_agent mark speed   --start 8 --end 13 --factor 2.5 --label "Typing"
python3 -m studio_agent mark caption "The important setting is here" --duration 2
python3 -m studio_agent stop --render --canvas 1920x1080
```

`--ago 0.2` is the key UX trick: you don't need to know the absolute timestamp,
you say "0.2s ago" and the CLI subtracts from `start_epoch`.

### Scripted (deterministic demo)

A scenario JSON describes both the recording config and the action sequence:

```json
{
  "name": "browser-demo",
  "record": { "audio": false, "cursor": true, "show_clicks": true },
  "render": { "canvas": "1920x1080", "crf": 18, "preset": "medium" },
  "actions": [
    { "type": "open_url", "url": "https://example.com", "after": 1.5 },
    { "type": "zoom", "x": 640, "y": 360, "scale": 1.35, "duration": 1.4, "after": 0.8 },
    { "type": "caption", "text": "Editable events, agentic recording", "duration": 2.2, "after": 2.0 }
  ]
}
```

```bash
python3 -m studio_agent run examples/browser-demo.json
```

`run` does start → execute actions → stop → render in one shot. Failures
short-circuit but always call `stop_session` first, so you don't end up with a
zombie `screencapture` process.

### Render-only

`render runs/<take>` re-renders from `events.json` without touching the recorder.
Useful for iterating on captions and zoom params after the fact.

### Editor (the GUI surface)

`python3 -m studio_agent editor --port 8765` serves a small UI that does three
things the CLI can't currently do well:

1. **Scrub a video preview** and pull the current timestamp into the event form.
2. **Visual click-and-place** zoom targets without measuring pixels by hand.
3. **Form over JSON** for people who don't want to remember `--x --y --scale --duration --lead`.

Everything else the editor does (start, stop, render, edit events.json) is a
thin POST/PUT over the same Python functions used by `cli.py`.

## Can it be more CLI-based? Yes, but the right answer is *additive*

The package is already CLI-first — the web editor is a wrapper, not a parallel
implementation. So the question is really: **what does the editor still do that
the CLI doesn't, and is each of those worth a terminal-native replacement?**

Three things the editor uniquely provides:

| Editor capability | Hard to replace in CLI? | Suggested CLI move |
|---|---|---|
| Visual frame scrubbing | Yes — needs pixels | Open `raw.mov` in QuickTime; copy the timestamp manually. Don't try to replace this. |
| "Use video time" → autofill timestamp | Medium | A `studio-agent mark … --from-clipboard` that parses `mm:ss.fff` from the clipboard would close most of the gap. |
| Form over JSON | No | `mark` already covers this — the gap is *discoverability*, not capability. |

What I'd actually add to make the CLI flow nicer:

1. **A live TUI (`studio-agent watch`)** — when a recording is active, show
   elapsed time, last 10 events, and bind hotkeys (`z`/`c`/`s`) to fire a
   `mark zoom/click/speed` at the current cursor position via `cliclick` or a
   small Quartz helper. This is the *one* thing missing from the agentic flow:
   you currently have to leave the recording and run a CLI command, which
   wastes seconds and pollutes the cursor path.

2. **`studio-agent status --json`** — `cmd_status` already exists but prints
   formatted text. A `--json` flag would let agents poll state cleanly without
   parsing strings.

3. **A `studioagent.toml` for render defaults** — `--crf 18 --preset medium
   --canvas 1920x1080 --background '#f3f0ea'` shows up in every example. Project
   config would let `start`/`run`/`render` pick those up automatically.

4. **`studio-agent demo <name> [--scenario file]`** — wraps the
   start/drive/stop/render arc so the common case is one command, and the
   subcommands are reserved for when you need control.

5. **Pipe-friendly `mark`** — `studio-agent mark --stdin` reading newline-delimited
   JSON events lets you fan in marks from any source (a global hotkey daemon, a
   browser-driver script, a separate Codex session) without each of them needing
   to know about argparse flag names.

6. **Retire the editor or keep it for the one thing it's good at.** If you add
   the TUI + clipboard timestamp helper, the editor's only remaining unique
   value is *visual* scrubbing. That's fine — keep it as the optional GUI for
   people doing fine cuts, but stop building toward feature parity in two places.

## The thing that's *not* worth doing

Reimplementing the timeline editor as a TUI with frame thumbnails. macOS ASCII
video preview is a parlor trick, not a workflow. If you need to see the frame,
open the `.mov`. If you need to see the timeline shape (where events cluster),
print it as a text histogram — that's actually useful and trivial:

```
0s ────●─────●●──────────────────●───── 20s
       click  zoom              caption
```

That'd live in `studio-agent status --timeline` and cover 80% of the editor's
visual value for free.

## TL;DR

- It's a CLI tool already; the web editor is a thin convenience layer.
- The agentic flow is the interesting one: `start` → agent drives + emits `mark`
  events → `stop --render`.
- The CLI wins on automation; the editor wins on visual cut decisions.
- The valuable CLI additions are a live TUI for hands-free marking, JSON status
  output, and a config file. Don't try to replace the visual scrubber in a
  terminal.
