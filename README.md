# empeefour

A voice-driven screen-recording editor for macOS. Hold the mic, talk like you would to a director ("zoom in here", "cut from five to eight", "make me a nice intro"), and the agent does the editing.

![status](https://img.shields.io/badge/status-prototype-orange) ![platform](https://img.shields.io/badge/platform-macOS-black) ![voice](https://img.shields.io/badge/voice-gpt--realtime--2-22c55e)

---

## What it is

**Studio Agent** — an Electron desktop app that listens, edits, and ships. Voice in, edit operations out. Built on top of OpenAI's GA Realtime API with a fan-out of tools: timeline marks, web search, image generation, autonomous video compositing, Apple Health analysis, and delegation to a Cursor coding agent for anything else.

The mental model is simple:
1. Click the orb to start a voice session
2. Hold the orb (or `Space`) to talk
3. Release — the agent fires the right tool and tells you what it did
4. The transcript fills in left-to-right with timestamps, speaker pills, and embedded action cards

No menus. No buttons buried four levels deep. Just talk.

---

## Repo layout

```
empeefour/
├── screenstudio-agent/       # The actual desktop app
│   ├── app/                  # electron-vite + React 19 + Tailwind v4
│   │   ├── src/main/         # Electron main: voice agent, tools, IPC
│   │   ├── src/preload/      # contextBridge surface
│   │   └── src/renderer/     # React UI (HomePage, DebugPage, Timeline)
│   ├── tool/                 # TypeScript port of the editor pipeline
│   │   └── src/server.ts     # Local HTTP editor at :8765
│   └── runs/                 # Per-take recordings + events.json + final.mp4
├── agentic-video/            # Standalone autonomous video runner (mock target)
│   └── runs/cartels-intro/   # Demo footage referenced by compose_video
├── frontend/                 # Next.js voice-tester harness (browser WebRTC)
└── .env.example              # OPENAI_API_KEY, CURSOR_API_KEY, EXA_API_KEY
```

---

## Voice tools

The realtime model is given a focused tool palette. Anything outside it gets handed to the Cursor agent.

| Tool | Trigger | What it does |
|------|---------|---|
| `mark_zoom` | "zoom in here" | Drops a zoom event at the playhead |
| `mark_click` | "click this" | Click + zoom emphasis |
| `mark_caption` | "caption this as ..." | On-screen caption |
| `mark_speed` | "speed up from 5 to 8" | Speed ramp on a span |
| `mark_cut` | "cut from 5 to 8" | Removes a span |
| `mark_marker` | "mark this" | Generic timeline marker |
| `delegate_to_cursor` | Anything multi-step | Hands a brief to Cursor (composer-2) with bash/read/edit |
| `web_search` | "what's the latest news on ..." | Exa `/search` with highlights |
| `health_data_analysis` | "how's my sleep" | Reads `~/apple-health/analysis/*.csv` directly |
| `generate_image` | "make me a sunset" | gpt-image-2-2026-04-21 → PNG → `open` |
| `compose_video` | "make a nice intro for X" | Async edit-runner mock (cartels-intro demo) |

Every tool fires a colored balloon over the orb the moment it lands, and persists as an action card in the transcript so you can scroll back and see exactly what was done.

---

## How the voice flow actually works

It took a lot of trial and error to make this feel natural. Notes for whoever inherits the codebase:

### Push-to-talk, not always-on
**Hold to talk, release to send.** Server VAD is disabled (`turn_detection: null`) — the client controls every turn boundary. On press: unmute mic, locally flush any queued model audio (cuts the agent off mid-word). On release: mute, send `input_audio_buffer.commit`, queue `response.create`. This kills:
- The speaker → mic → VAD-interrupt feedback loop
- The 600ms silence wait the API otherwise imposed
- The "model talks over you" problem

### Audio reactivity
The audio pump computes RMS of every 100ms PCM chunk and streams it to the renderer. The orb scales `1.05–1.23×` with your voice and the ripples expand 180→260px. Smoothed with a 0.55/0.45 EMA so it follows your contour without jitter.

### Tool ack lifecycle
Each tool call needs a matching `function_call_output`, otherwise the conversation thread is broken and the model improvises ("still running in the background..."). The `requestResponseCreate` helper queues `response.create` until the active response ends — without this you get `Conversation already has an active response in progress` errors.

### Transcript bubble fallback
Streaming `response.output_audio_transcript.delta` events fill a pending model bubble in real time. If that fails, the `[info] model: ...` log line at the end is authoritative — replaces any pending bubble or creates a fresh one. Means the model side never goes silent.

### The conversation panel
Three-column row: `MM:SS` elapsed (mono, neutral-400) | `YOU` / `AGENT` pill (uppercase, green-50) | message text + action cards. Every tool fire embeds a card under the agent's row with the icon, label, detail, and meta sub-line. Pure transcript, no chat-bubble whiplash.

---

## Setup

```bash
git clone https://github.com/justrach/empeefour.git
cd empeefour/screenstudio-agent/app
npm install
cp ../../.env.example ../.env  # then fill in your keys
npm run dev
```

`.env` keys you'll want:
```
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2
CURSOR_API_KEY=crsr_...        # for delegate_to_cursor
CURSOR_AGENT_MODEL=composer-2
EXA_API_KEY=...                # for web_search
```

For `health_data_analysis` to do anything useful, generate the CSVs at `~/apple-health/analysis/` (e.g. via the Apple Health export → CSV pipeline).

For `compose_video` (mock), the demo asset is at `agentic-video/runs/cartels-intro/final.mp4` — already in the repo.

### Wear headphones
Without echo cancellation the mic loops the model's voice back through the speakers. The PTT push fixes most of it, but headphones are the right answer.

---

## Architecture pieces worth knowing

- **`app/src/main/listen.ts`** — `VoiceAgent` class. Orchestrates the WS, the audio pump, the tool dispatcher, the response-active queue, and all the async tool runners. Most of the system lives here.
- **`app/src/main/realtime-primitives.ts`** — Tool definitions, system prompt, session config, PCM chunker.
- **`app/src/renderer/src/pages/HomePage.tsx`** — Voice-first home with audio-reactive orb, transcript, action cards, drawer of recent takes.
- **`app/src/renderer/src/pages/DebugPage.tsx`** — Timeline editor, multi-track lanes, drag-to-retime, render controls.
- **`app/src/main/db.ts`** — SQLite journal (`utterances`, `tool_calls`, `runs`, `edits`).

---

## Adding a tool

Three files:

1. **`realtime-primitives.ts`** → add to `EDITOR_TOOLS` (name, description, parameters). Mention it in `EDITOR_SYSTEM_INSTRUCTIONS` so the model knows when to fire it.
2. **`listen.ts`** → add a `case "your_tool":` to `handleToolCall`. For sync ops, set `event = { ... }` and let `appendEvent` flow handle it. For async work, call `this.sendToolOutput(call.callId, ack, true)` then fire-and-forget your runner; deliver the result via `this.sendSystemNote(...)`.
3. **`HomePage.tsx`** (optional polish) → add to `TOOL_LOOKS` (emoji + tint), `shortDetail`, `metaForTool` so the action card looks right.

That's it. The model picks it up on next session.

---

## Status

This is a working prototype, not a product yet. Things that work today:
- Voice-driven editing with all six mark tools, immediate visual feedback, undoable via `/debug`
- Real-time streaming transcripts, audio reactivity, push-to-talk barge-in
- All async tools (web_search, generate_image, health, delegate, compose_video mock)
- SQLite journaling, debounced Cursor refine pass after each edit, render to MP4

Things on the radar:
- Real `agentic-video` runner replacing the `compose_video` mock
- HTTP editor server → Electron IPC + `studio://` protocol (kill the localhost server)
- Long-form session memory across runs
- Mac App Store packaging

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
