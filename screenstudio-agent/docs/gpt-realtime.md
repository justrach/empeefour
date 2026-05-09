# gpt-realtime — how it works

How the OpenAI Realtime API is wired into this project, plus the wire-format
reference notes that future-you will want when the SDK shifts under you.
Anchored against `app/src/main/listen.ts`, the file that opens a Realtime
session, and `app/src/main/realtime-primitives.ts`, the small local wrapper
for the wire-format pieces.

Source for the protocol details: the `openai-node` SDK
(`src/resources/realtime/`) — the older `src/resources/beta/realtime/` is
deprecated, do not pattern-match against it.

## TL;DR for this codebase

```
mic ── ffmpeg avfoundation ──> 24 kHz s16le PCM ──> input_audio_buffer.append
                                                          │
                                                          ▼
                                              OpenAI Realtime WS
                                              (gpt-realtime-2)
                                                          │
                              response.function_call_arguments.done
                                                          │
                    parseRealtimeToolCall → VoiceAgent.handleToolCall
                                                          │
                                            appendEvent → events.json
```

We never play audio back; `output_modalities: ["text"]` keeps the model in
"text + tool calls only" mode. The only thing we want from the model is the
right tool call at the right moment.

The project-owned primitives live in `app/src/main/realtime-primitives.ts`:

| Primitive | Job |
|---|---|
| `buildEditingSessionUpdate()` | Builds the modern `session.update` payload with text-only output, nested `audio.input`, server VAD, transcription, tools, and `tool_choice: "auto"`. |
| `spawnMacMicPcm()` | Starts the macOS mic capture process (`ffmpeg avfoundation`) as 24 kHz mono s16le PCM. |
| `PcmChunker` | Turns arbitrary stdout buffers into fixed 100 ms PCM chunks. |
| `inputAudioAppendEvent()` | Converts a PCM chunk into `input_audio_buffer.append`. |
| `parseRealtimeToolCall()` | Parses `response.function_call_arguments.done` into `{ name, argsRaw, args, callId, ... }`. |
| `functionCallOutputEvent()` / `responseCreateEvent()` | The optional tool-result echo path for future non-fire-and-forget tools. |

## 1. Connection

Two transports ship in the SDK:

| Class | Module | Use |
|---|---|---|
| `OpenAIRealtimeWS` | `openai/realtime/ws` | Node — wraps the `ws` package. **What we use.** |
| `OpenAIRealtimeWebSocket` | `openai/realtime/websocket` | Browser — uses the native `WebSocket`. Refuses to start in a browser unless `dangerouslyAllowBrowser: true` or you pass an ephemeral `ek_…` token. |

There is **no first-party WebRTC class** in `openai-node` today. If you ever
need WebRTC, you're either rolling your own peer connection against the same
Realtime endpoint or using the OpenAI Agents SDK.

Auth in Node is just the Authorization header — `OpenAIRealtimeWS` reads it
from the `OpenAI` client you hand it:

```ts
import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ws = new OpenAIRealtimeWS({ model: "gpt-realtime-2" }, client);
```

(see `app/src/main/listen.ts`.)

For **client-side** apps, mint an ephemeral token first so your real key
never leaves the server:

```ts
const cs = await client.realtime.clientSecrets.create({
  model: "gpt-realtime",
  instructions: "...",
  voice: "alloy",
});
// hand cs.client_secret.value (the "ek_..." string) to the browser
```

## 2. Session lifecycle

The connection is event-pumped — both directions are JSON messages over a
single WebSocket. Both `OpenAIRealtimeWS` and the browser variant extend
`OpenAIRealtimeEmitter`, so you call `ws.send(...)` to emit and
`ws.on("event.name", handler)` to receive.

### Client → server events you actually use

| Event | Purpose |
|---|---|
| `session.update` | Configure the session: instructions, modalities, audio format, VAD, tools. Send once on `open`, can resend mid-stream to change config. |
| `input_audio_buffer.append` | Stream a chunk of base64-encoded raw audio. |
| `input_audio_buffer.commit` | Force the model to treat what you've sent as a complete user turn. Optional when server VAD is on — VAD commits for you. |
| `conversation.item.create` | Insert a message or a `function_call_output` into the conversation. |
| `response.create` | Manually ask the model to produce a response. Optional with `audio.input.turn_detection.create_response: true` — VAD triggers it. |

### Server → client events you actually handle

| Event | What it carries |
|---|---|
| `session.created` / `session.updated` | Confirms config landed. |
| `input_audio_buffer.speech_started` / `…speech_stopped` | Server VAD fired. |
| `conversation.item.input_audio_transcription.completed` | Whisper-style transcript of the user turn (`{ transcript }`). We log this as the "heard" line. |
| `response.output_text.delta` / `…done` | Streaming text from the model. We log `…done` so we can see when the model emitted prose *instead of* a tool. |
| `response.audio.delta` | Streaming audio output (we don't subscribe — text-only modality). |
| `response.audio_transcript.delta` | Transcript of the model's *spoken* output, when audio modality is on. |
| `response.function_call_arguments.delta` | Partial JSON for an in-flight tool call. |
| `response.function_call_arguments.done` | Final tool call: `{ call_id, name, arguments, item_id, output_index, response_id }`. **This is the one we care about.** |
| `response.done` | Wraps a turn. Inspect `response.status === "failed"` for errors. |
| `error` | Server-side problem — bad payload, rate limit, etc. |

Our `session.update` payload is built by `buildEditingSessionUpdate()`:

```ts
ws.send(buildEditingSessionUpdate());
```

Notes on the shape that bit us before:

- `output_modalities` is the new field name. Old examples use `modalities` —
  the deprecated beta path.
- Audio config lives under `session.audio.input` / `…output`, **not** at the
  root. The flat `input_audio_format` / `input_audio_transcription` keys are
  the legacy beta shape.
- `turn_detection.create_response: true` makes server VAD also fire
  `response.create` for you — that's why we never call it explicitly.

## 3. Tool / function calling end-to-end

### Register tools in `session.update`

Each tool is a `RealtimeFunctionTool`:

```ts
{
  type: "function",          // literal
  name: "mark_zoom",
  description: "...",        // when/how to call it; the model reads this
  parameters: {              // JSON Schema for arguments
    type: "object",
    properties: { time: { type: "number" }, /* ... */ },
    required: [],
  },
}
```

Set `tool_choice: "auto"` (default), `"required"`, `"none"`, or a specific
`{ type: "function", name: "..." }`.

### Receive a tool call

Subscribe to `response.function_call_arguments.done`. Payload:

```ts
{
  type: "response.function_call_arguments.done",
  event_id: "evt_…",
  response_id: "resp_…",
  item_id: "item_…",
  output_index: 0,
  call_id: "call_…",   // ← this is what you echo back
  name: "mark_zoom",
  arguments: '{"time":12,"label":"settings"}',  // JSON string
}
```

(Stream partials via `…delta` if you want progress; we don't.)

In `app/src/main/listen.ts`, the SDK event is normalized before dispatch:

```ts
ws.on("response.function_call_arguments.done", (event) => {
  const call = parseRealtimeToolCall(event);
  this.handleToolCall(call).catch(...);
});
```

### Send the result back (optional in our flow)

We don't currently echo results — our tools are fire-and-forget edits to
`events.json`, so the model doesn't need a reply. If/when we want the model
to *see* the result of a tool (e.g. "did the zoom land?"), the round-trip is:

```ts
ws.send(functionCallOutputEvent(call.callId, { ok: true }));
ws.send(responseCreateEvent());   // ask the model to react
```

The relevant SDK types: `RealtimeFunctionTool`,
`ResponseFunctionCallArgumentsDeltaEvent`,
`ResponseFunctionCallArgumentsDoneEvent`,
`RealtimeConversationItemFunctionCallOutput`.

## 4. Audio — formats, sample rates, streaming

Supported input/output formats:

| Format | Bitrate / shape |
|---|---|
| `audio/pcm` (a.k.a. `pcm16`) | 16-bit signed little-endian PCM, mono, 24 kHz default |
| `g711_ulaw` | 8 kHz μ-law (telephony) |
| `g711_alaw` | 8 kHz A-law (telephony) |

We use 24 kHz PCM16 mono. `spawnMacMicPcm()` starts `ffmpeg`, and
`PcmChunker` reads stdout in 100 ms chunks before `inputAudioAppendEvent()`
base64-encodes each one:

```ts
this.ffmpeg = spawnMacMicPcm({ device: mic, sampleRate: REALTIME_AUDIO.sampleRate });

const chunker = new PcmChunker((chunk) => {
  ws.send(inputAudioAppendEvent(chunk));
});

stream.on("data", (chunk) => chunker.push(chunk));
```

Server VAD does the turn-cutting. If you want push-to-talk, drop
`turn_detection`, then call `input_audio_buffer.commit` followed by
`response.create` yourself when the user releases the key.

`input_audio_transcription: { model: "whisper-1" }` is what produces the
`conversation.item.input_audio_transcription.completed` events we use to log
"heard" lines.

## 5. Model IDs

Picked these out of `RealtimeSession` in the SDK. Choose one of:

- `gpt-realtime`, `gpt-realtime-1.5`, `gpt-realtime-2025-08-28`
- `gpt-realtime-mini`, `gpt-realtime-mini-2025-10-06`,
  `gpt-realtime-mini-2025-12-15`
- `gpt-audio-1.5`, `gpt-audio-mini`, `gpt-audio-mini-2025-10-06`,
  `gpt-audio-mini-2025-12-15`
- `gpt-4o-realtime-preview` (and dated 2024-10-01 / 2024-12-17 /
  2025-06-03), `gpt-4o-mini-realtime-preview`,
  `gpt-4o-mini-realtime-preview-2024-12-17`

`gpt-realtime-2` (what `.env` sets for us) is the snapshot you get when you
ask for `gpt-realtime` today. The `gpt-4o-realtime-preview*` line is the
older preview family — works, but is the one you'd migrate *off*. The
`-mini` and `gpt-audio-*` families exist if you want cheaper/faster
realtime.

Resolution order in `app/src/main/listen.ts`:

```
this.opts.model
  ?? db.getPreference("realtime_model")
  ?? process.env.OPENAI_REALTIME_MODEL
  ?? "gpt-realtime-2"
```

## 6. Helper classes cheat sheet

| Symbol | Where | Role |
|---|---|---|
| `OpenAIRealtimeWS` | `openai/realtime/ws` | Node WS connection. `.send(event)`, `.close()`, `.socket` (raw `ws.WebSocket`), inherits `EventEmitter`. |
| `OpenAIRealtimeWebSocket` | `openai/realtime/websocket` | Browser WS connection. Same surface; refuses to start without `ek_…` or `dangerouslyAllowBrowser`. |
| `OpenAIRealtimeEmitter` | `openai/realtime/internal-base` | Common base — provides `.on("event_type", handler)` typed against the union of all server events. |
| `RealtimeSession` | type | Session config object — what goes inside `session.update.session`. |
| `RealtimeFunctionTool` | type | A single entry in `session.tools`. |
| `client.realtime.clientSecrets.create()` | REST | Mint an ephemeral `ek_…` token for browser/mobile. |
| `buildEditingSessionUpdate` | local primitive | Produces the current `session.update` shape from SDK types so old beta keys don't leak in. |
| `PcmChunker` | local primitive | Keeps audio chunks at the exact sample-rate-derived byte size. |

## 7. Failure modes you'll hit

- **`session.update` rejected with "unknown field"** — almost always the
  flat beta shape (`input_audio_format`) leaking back in. Move the field
  under `audio.input` / `audio.output`.
- **No tool calls fire** — the model decided your phrase is conversational.
  Make the system prompt explicit ("any mention of X IS a command") and
  watch `response.output_text.done` to see what the model said instead.
  `EDITOR_SYSTEM_INSTRUCTIONS` in `realtime-primitives.ts` is deliberately
  aggressive for exactly this reason.
- **`response.failed`** with no obvious cause — check `response.done` for
  `status_details.error.message`; it's usually a tool whose JSON Schema
  rejected the model's output.
- **Audio appears to send but nothing transcribes** — wrong sample rate.
  The format declaration (`rate: 24000`) and the ffmpeg `-ar` value have to
  agree, and the mic actually has to deliver mono s16le. `ffprobe -i raw`
  on a captured chunk is the fastest sanity check.
- **WebSocket closes immediately** — `OPENAI_API_KEY` not set, or set in a
  shell that didn't propagate to the Electron child. `listen.ts:156-158`
  fails fast on the unset case; if it's set but still failing, log the key
  prefix once at startup to confirm.
