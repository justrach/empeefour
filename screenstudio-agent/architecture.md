# Architecture

A single-machine, voice-first screen-recording editor. Three runtimes cooperate
through plain files; nothing is centralised behind a service.

```
                 ┌────────────────────────── Electron main (Node) ──────────────────────────┐
                 │                                                                          │
 ┌──────────┐    │   ┌───────────────┐   IPC    ┌───────────────┐    HTTP    ┌────────────┐  │
 │  micro-  │── PCM ─►   listen.ts   │◄────────►│    main.ts    │◄──────────►│ server.py  │◄─┼── browser
 │  phone   │    │   │  VoiceAgent   │  voice:* │   (window,    │  /api/...  │ (editor +  │  │   (in-app
 │ (avfound │    │   │  + OpenAI     │  polish: │   menu, IPC,  │            │  recorder  │  │    webview
 │  ation)  │    │   │   Realtime    │  agent:* │   run sync)   │            │   facade)  │  │    or std
 └──────────┘    │   └──┬────────┬───┘          └──┬────────────┘            └─────┬──────┘  │     browser)
                 │      │        │                 │                               │         │
                 │      │        │   sqlite        │    spawnStudio (child tool)   │         │
                 │      │        ▼                 │                               ▼         │
                 │      │   ┌────────────┐         │   ┌────────────────────────────────┐    │
                 │      │   │  store.db  │         │   │ tool/dist/cli.js or py fallback│    │
                 │      │   │ utterances │         │   │  cli · session · render · ...  │    │
                 │      │   │ tool_calls │         │   └────────────────────────────────┘    │
                 │      │   │ runs idx   │         │              │      │                   │
                 │      │   │ prefs      │         │   screencapture     ffmpeg              │
                 │      │   │ suggest    │         │              │      │                   │
                 │      │   └────────────┘         │              ▼      ▼                   │
                 │      │                          │     ┌────────────────────┐              │
                 │      └──── appendEvent ─────────┴────►│ runs/<take>/       │              │
                 │                                       │  raw.mov           │              │
                 │                                       │  events.json   ◄── source of      │
                 │                                       │  session.json      truth for      │
                 │                                       │  final.mp4         the timeline   │
                 │                                       └────────────────────┘              │
                 │                                                                            │
                 │                            .agentic-studio/current.json  (active session)  │
                 └──────────────────────────────────────────────────────────────────────────┘
```

## Three runtimes

| Runtime | Where | Owns |
|---|---|---|
| **TypeScript tool** | `tool/src/*`, built to `tool/dist/cli.js`, spawned by Electron main when present | the recorder (`screencapture`), the renderer (`ffmpeg`), the editor HTTP server, scripted UI actions, the on-disk run layout |
| **Python `studio_agent`** | fallback implementation, runnable standalone via `python3 -m studio_agent` | the original recorder/renderer/editor/tool surface |
| **Electron main (Node/TS)** | `electron/src/{main,listen,polish,db,studio}.ts` | window + menu, voice agent, polish pass, SQLite store, IPC, run-folder mirroring |
| **Browser UI** | `studio_agent/web/{index.html,app.js,styles.css}` served by `server.py`, loaded into the Electron `BrowserWindow` (or any browser) | timeline view, JSON pane, manual event form, recorder controls, render config, voice-mode hero |

The Electron main does *not* re-implement the recorder. It shells the local tool (`node tool/dist/cli.js editor` when built, otherwise `python3 -m studio_agent editor`), points the `BrowserWindow` at `http://127.0.0.1:8765`, and POSTs to the editor's HTTP API for start/stop/render. `events.json` remains the source of truth for everything that touches `ffmpeg` or the filesystem.

## State on disk

```
runs/<take>/
  raw.mov          # screencapture output
  events.json      # the timeline (zoom/click/caption/speed/cut/marker) — source of truth
  session.json     # PID, start_epoch, render config
  final.mp4        # ffmpeg output

.agentic-studio/
  current.json     # pointer → session.json of the active take
  store.db         # SQLite (WAL): utterances, tool_calls, runs, preferences, suggestions
```

`events.json` is the only thing the renderer reads. SQLite is **additive** — it stores agent memory (every utterance, every tool call, run index, suggestion counters), not the timeline itself. This means the Python renderer keeps working even if the Electron app is gone, and `events.json` stays git-diffable / hand-editable.

The `current.json` pointer is how `mark` and the voice agent know which run to append to without being told.

## Voice path (the interesting one)

```
mic → ffmpeg (avfoundation, 24 kHz s16le, 100 ms chunks)
     → OpenAIRealtimeWS (gpt-realtime-2)
     → tool call: mark_zoom | mark_click | mark_caption
                  | mark_speed | mark_cut | mark_marker
     → parseRealtimeToolCall (realtime-primitives.ts)
     → VoiceAgent.handleToolCall (listen.ts)
        ├─ resolves "now" → time-since-start_epoch  (or "here" → cursor via Quartz)
        ├─ db.recordToolCall + db.bumpSuggestion     (memory)
        └─ appendEvent → events.json                (timeline)
     → editor UI polls /api/runs/<name>/events     (UI updates live)
```

Key design choice: the model emits **structured tool calls**, never free-form text. The local Realtime primitives in `app/src/main/realtime-primitives.ts` own the session payload, tool schemas, PCM chunking, and tool-call parsing; `VoiceAgent` stays focused on lifecycle and timeline effects. The system prompt is deliberately aggressive — questions like "can we zoom in?" count as commands. False positives are cheap (you delete an event); missed marks ruin the take.

Time resolution rule: every mark tool accepts an optional `time` (seconds from start). Omitted means "now." `mark_cut` requires `start` + `end` because there's no sensible "now" for a range.

## Render pipeline

`tool/src/render.ts` and the fallback `render.py` read `events.json` and produce `final.mp4` in roughly this order:

1. **Parse events** into typed dataclasses (`ZoomEvent`, `CaptionEvent`, `SpeedEvent`, `CutEvent`, …).
2. **Compute timeline segments** from speeds + cuts. `mapped_time` translates source-time → output-time so any zoom/caption that lives inside a sped-up or cut span ends up on the right output frame.
3. **Speed-adjust + cut the source** if needed (`render_speed_adjusted_source`) by emitting a temp video that excludes cut spans and rescales speed spans via `atempo`/`setpts`.
4. **Build the `-filter_complex`** with eased zoom/pan, click pulses, caption `drawtext`, and an optional 1920×1080 background canvas (`build_filter`, `canvas_filter`, `caption_filter`).
5. **Encode** with the chosen `crf` + `preset`.

Cuts are first-class — they actually shorten the video, not fast-forward it.

## SQLite schema (electron/src/db.ts)

| Table | Purpose |
|---|---|
| `runs` | mirror of every `runs/<take>/` folder — name, paths, started/stopped, status, duration |
| `utterances` | every transcript line the realtime model emits, scoped to a run |
| `tool_calls` | every tool invocation: name, JSON arguments, resolved event type/time, status, error |
| `preferences` | key/value, used for UI preferences and agent defaults |
| `suggestions` | (kind, text) → uses count. Powers "you used these zoom labels before" hints |

Synced on Electron boot (`syncRunsToDb` in `main.ts:280`) by walking `runs/`, then kept live by `listen.ts` writing as it goes. Closed cleanly on `app` quit.

## HTTP API surface (`tool/src/server.ts` / fallback `server.py`)

Used by both the in-window UI and the Electron main process.

| Method + path | Purpose |
|---|---|
| `GET /api/status` | health probe (Electron uses this in `waitForEditor`) |
| `GET /api/runs` | list of takes |
| `GET /api/runs/<name>` | one take's metadata |
| `GET /api/runs/<name>/events` | events.json |
| `PUT /api/runs/<name>/events` | overwrite events.json |
| `POST /api/runs/<name>/render` | trigger render, returns output path |
| `POST /api/record/start` | start a new recording |
| `POST /api/record/stop` | stop active recording, optionally render |
| `GET /media/runs/<name>/<file>` | serves raw.mov / final.mp4 with HTTP `Range` (browser scrubbing) |

## IPC surface (Electron preload → main)

| Channel | Purpose |
|---|---|
| `voice:toggle` / `voice:state` | start/stop the voice agent (auto-starts a recording if none active) |
| `polish:run` | run the post-recording polish pass on a chosen run |
| `agent:stats` | utterance/mark counts for the bottom-of-panel badge |
| `agent:suggestions` | top-N suggestions for a kind (e.g. zoom labels) |
| `agent:recent-utterances` | recent transcript lines |
| `agent:get-pref` / `agent:set-pref` | UI preferences |
| `listen:log` / `listen:state` | main → renderer push channel for voice-log lines and active state |

## CLI surface

`studio-agent-ts {start | mark | stop | render | run | status | editor}` via `node tool/dist/cli.js`, with `python3 -m studio_agent` still available as fallback. Voice-mode and polish are intentionally **not** in the low-level CLI — they live in the Electron Node layer because they depend on `openai-node` + the Electron lifecycle. The CLI is the lowest-level driver; everything else composes on top of it.

## Voice-mode lifecycle

`setVoiceMode(true)` in `main.ts:114` is the single button:

1. If no recording is active → POST `/api/record/start`, wait for `current.json` to land. Set `voiceOwnsRecording = true`.
2. Construct `VoiceAgent`, attach a `log` listener that forwards to the renderer.
3. `voice.start()` opens the OpenAI Realtime WS, spawns ffmpeg-mic, pumps audio.

`setVoiceMode(false)`:

1. Stop the voice agent, close the WS.
2. **Only if voice owned the recording**: POST `/api/record/stop` with render config (canvas 1920×1080, crf 18, medium). The `voiceOwnsRecording` flag is what keeps a manually-started recording from being killed by Voice Mode.

## Open questions / drift

- **`polish.ts` no longer uses `graff`.** `NOTES.md` documents `studio-agent polish` as a `graff` shell-out (Codex / gpt-5.5). The TS port in `electron/src/polish.ts:32` calls `openai-node` directly with `gpt-5.5` instead. If the goal of polish is "let a smarter coding agent re-shape the timeline," restoring the `graff` invocation is a one-function change — `polish()` would `spawn("graff", ["-p", prompt])` and parse JSON from stdout. Worth deciding before more polish features are added.
- **`graff` could also drive `mark_*` tools.** Right now the Realtime model emits tool calls directly. A more agentic flow would have `graff` (or any Codex-class agent) sit between transcripts and tool calls — i.e. transcribe in Realtime, but plan edits with a coding-grade model. Adds latency; gains better label/caption quality.
- **Recorder is `screencapture`, not ScreenCaptureKit.** No build step required, but no cursor path reconstruction or per-window anchoring. Listed as "next layers" in the README.
- **`current.json` is a single global pointer.** Two takes cannot run concurrently; the voice agent attaches to whichever take is active. Fine for a single-user demo tool; not fine for multi-user.
- **No undo for events.json edits.** SQLite has the full tool-call history, so `events.json` *could* be reconstructed at any timestamp, but there's no UI for it.

## Why this shape

- **Files over a database for the timeline.** `events.json` is human-readable, git-friendly, survives any of the three runtimes crashing. The renderer is pure-Python and can be tested without the Electron app at all.
- **SQLite for memory, not data.** Memory is the kind of thing you query (`top zoom labels`, `last N utterances`); files are the kind of thing you ship and edit.
- **The renderer is now mirrored in TypeScript.** The Python renderer remains useful as a reference/fallback, but `tool/src/render.ts` lets the desktop app move toward one Node/TS toolchain.
- **HTTP between Electron-main and the tool, not stdio.** The same server backs the in-window UI and any external browser — one mental model.
