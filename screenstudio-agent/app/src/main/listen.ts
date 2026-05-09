// Voice-driven event marking via OpenAI Realtime (gpt-realtime-2).
//
// Tools accept optional `time` (seconds from recording start) so the user
// can say things like "zoom on second 12" or "cut from 5 to 8". When time
// is omitted, "now" is used. Every utterance + tool call is mirrored into
// the local SQLite store so the agent has memory across sessions.

import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { EventEmitter } from "node:events";
import { screen } from "electron";

import { StudioSession, TimelineEvent, appendEvent, loadActiveSession } from "./studio";
import * as db from "./db";
import { getAgent, isConfigured as isCursorConfigured } from "./agent";
import { scheduleRefine } from "./refine";
import {
  PcmChunker,
  REALTIME_AUDIO,
  buildEditingSessionUpdate,
  functionCallOutputEvent,
  inputAudioAppendEvent,
  parseRealtimeToolCall,
  responseCreateEvent,
  spawnMacMicPcm,
  type RealtimeToolCall,
} from "./realtime-primitives";

export interface ListenOptions {
  model?: string;
  micDevice?: string;
  // If provided, the agent attaches to THIS session (edit mode) instead of
  // pulling from the live recording pointer. "now" still maps via start_epoch.
  sessionProvider?: () => Promise<StudioSession | null>;
  // If provided, "now" with no `time` argument resolves to this playhead
  // instead of clock-since-start_epoch. Used in edit mode for existing takes.
  playheadProvider?: () => number;
  // Pipe model audio output to ffplay so the user hears the agent.
  // Default: true. Use headphones — speakers will create a mic feedback loop.
  speakBack?: boolean;
  voice?: string;
}

export type ListenLogLine = { kind: "info" | "heard" | "mark" | "error"; text: string };

export class VoiceAgent extends EventEmitter {
  private ws: OpenAIRealtimeWS | null = null;
  private ffmpeg: ReturnType<typeof spawnMacMicPcm> | null = null;
  private muted = false;
  private turnTranscript = "";
  private turnLogged = false;
  // Track whether the server has an active response. response.create
  // while one is active errors with "Conversation already has an active
  // response in progress". So we queue triggers and drain on response.done.
  private responseActive = false;
  private responseStartedAt = 0;
  private responseTriggerPending = false;
  private session: StudioSession | null = null;
  private runName: string | null = null;
  active = false;

  constructor(private opts: ListenOptions = {}) {
    super();
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not set; populate screenstudio-agent/.env");
    }
    const session = await (this.opts.sessionProvider
      ? this.opts.sessionProvider()
      : loadActiveSession());
    if (!session) throw new Error("No session to attach to. Select a take or start a recording first.");
    this.session = session;
    this.runName = (session.run_dir.split("/").pop() || null);
    this.active = true;

    const model =
      this.opts.model ||
      db.getPreference("realtime_model") ||
      process.env.OPENAI_REALTIME_MODEL ||
      "gpt-realtime-2";
    this.log("info", `attached to ${session.run_dir}`);
    this.log("info", `model: ${model}`);

    const mic = this.opts.micDevice || db.getPreference("mic_device") || ":0";
    this.ffmpeg = spawnMacMicPcm({ device: mic, sampleRate: REALTIME_AUDIO.sampleRate });
    this.ffmpeg.stderr?.on("data", (d: Buffer) => this.log("error", d.toString().trim()));

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const ws = new OpenAIRealtimeWS({ model }, client);
    this.ws = ws;

    ws.socket.on("open", () => {
      ws.send(buildEditingSessionUpdate());
      if (this.opts.speakBack !== false) {
        this.log("info", "voice-back on — audio routes to renderer");
      }
      this.startAudioPump();
    });

    ws.on("response.function_call_arguments.done", (event) => {
      const call = parseRealtimeToolCall(event);
      this.handleToolCall(call).catch((err: Error) =>
        this.log("error", `tool dispatch failed: ${err.message}`),
      );
    });

    ws.on("conversation.item.input_audio_transcription.completed", (event) => {
      const text = String((event as { transcript?: string }).transcript || "").trim();
      if (!text) return;
      this.log("heard", text);
      const recTime = this.session
        ? Math.round((Date.now() / 1000 - this.session.start_epoch) * 1000) / 1000
        : undefined;
      try {
        db.recordUtterance(this.runName, text, recTime);
      } catch (e) {
        // DB errors should never break the voice flow
      }
    });

    // Pipe model audio chunks to ffplay (24kHz mono s16le) so the user
    // hears the agent talk back. Only wired when speakBack is on. The
    // SDK's typed .on signatures don't enumerate every Realtime event, so
    // cast for the audio events we want to subscribe to.
    const wsAny = ws as unknown as {
      on(event: string, cb: (e: unknown) => void): void;
    };
    wsAny.on("response.output_audio.delta", (event) => {
      const delta = (event as { delta?: string })?.delta;
      if (!delta) return;
      const bytes = Buffer.from(delta, "base64");
      // Emit chunks for the main process to forward to the renderer's
      // Web Audio API. ffplay was unreliable on macOS so we play in-browser.
      this.emit("audio-chunk", bytes);
    });

    // Stream model text token-by-token so the renderer can show it flowing
    // in alongside the audio. We also accumulate locally so we can guarantee
    // a final log line on response.done even if .done's transcript field is
    // empty (which happens occasionally when interrupted).
    wsAny.on("response.output_audio_transcript.delta", (event) => {
      const delta = String((event as { delta?: string })?.delta || "");
      if (!delta) return;
      this.turnTranscript += delta;
      this.emit("transcript-delta", { role: "model", delta });
    });

    // Final transcript for the audio output. Per the GA Realtime API this
    // fires both on normal completion AND on interruption (with a partial
    // transcript). Either way we render the model bubble.
    wsAny.on("response.output_audio_transcript.done", (event) => {
      const text = String((event as { transcript?: string })?.transcript || "").trim();
      const final = text || this.turnTranscript.trim();
      if (final) {
        this.log("info", `model: ${final}`);
        this.turnLogged = true;
      }
      this.emit("transcript-done", { role: "model" });
    });

    // Surface text-only responses (model emitting prose instead of tools)
    // so we can see why a tool didn't fire.
    ws.on("response.output_text.done", (event) => {
      const text = String((event as { text?: string }).text || "").trim();
      if (text) this.log("info", `model said (no tool): ${text}`);
    });

    // Track when the model is mid-response so the audio pump knows to drop
    // mic input. Without this gate, server VAD picks up the model's own voice
    // bouncing back through the speakers and INTERRUPTS the model — the
    // response can be cut short and we lose the rest of the reply.
    ws.on("response.created", () => {
      this.responseActive = true;
      this.responseStartedAt = Date.now();
      this.turnTranscript = "";
      this.turnLogged = false;
    });

    // Flush queued model audio in the renderer the instant VAD says the
    // user started talking. The API cancels the active response on its end
    // (interrupt_response:true) but our renderer has already scheduled
    // ~seconds of PCM into AudioContext for gapless playback — without
    // this flush the model keeps talking from the buffer.
    wsAny.on("input_audio_buffer.speech_started", () => {
      // Renderer flushes the queued PCM so the speakers stop immediately.
      // The API's interrupt_response:true setting cancels the active
      // response on its own; sending response.cancel manually was causing
      // races (status=cancelled gets confused with our own cancel).
      this.emit("audio-flush");
    });
    ws.on("response.done", (event) => {
      const r = (event as {
        response?: {
          status?: string;
          status_details?: { error?: { message?: string }; reason?: string };
        };
      }).response;
      if (r?.status === "failed") {
        this.log("error", `response failed: ${r.status_details?.error?.message || "unknown"}`);
      }
      // Last-chance fallback: if the audio_transcript.done handler didn't
      // log a model line for this turn (events arrived out of order, or
      // .done's transcript was empty), but we accumulated deltas, log them
      // here so the model bubble always appears.
      if (!this.turnLogged && this.turnTranscript.trim()) {
        this.log("info", `model: ${this.turnTranscript.trim()}`);
        this.turnLogged = true;
        this.emit("transcript-done", { role: "model" });
      }
      this.responseActive = false;
      // Drain any queued response.create — async tool results that landed
      // while a response was active.
      if (this.responseTriggerPending) {
        this.responseTriggerPending = false;
        try {
          (this.ws as unknown as { send(e: unknown): void }).send(responseCreateEvent());
        } catch (err) {
          this.log("error", `queued response.create failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    ws.on("error", (err) => {
      const msg = err.message || String(err);
      // Benign race when our async tool result lands while VAD is mid-turn.
      if (msg.includes("already has an active response")) return;
      // Benign race when VAD speech_started fires right as the response
      // naturally ended — we sent response.cancel a hair too late.
      if (msg.includes("no active response found")) return;
      this.log("error", msg);
    });
    ws.socket.on("close", () => this.log("info", "ws closed"));
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.ffmpeg = null;
    }
    this.log("info", "stopped");
  }

  private startAudioPump(): void {
    if (!this.ffmpeg || !this.ws) return;
    const stream = this.ffmpeg.stdout;
    if (!stream) return;
    const chunker = new PcmChunker((chunk) => {
      if (!this.ws || !this.active || this.muted) return;
      try {
        this.ws.send(inputAudioAppendEvent(chunk));
      } catch {
        chunker.clear();
      }
    });
    stream.on("data", (chunk: Buffer) => {
      chunker.push(chunk);
    });
    stream.on("end", () => this.log("info", "ffmpeg stream ended"));
  }

  setMuted(value: boolean): void {
    this.muted = value;
    this.log("info", value ? "mic muted" : "mic listening");
  }

  // Force the server to commit whatever audio it has buffered and (with
  // create_response:true) immediately fire a response, instead of waiting
  // out the full silence_duration_ms after the user lets go of PTT.
  // Cuts ~600ms of dead air per turn.
  commitInputAudio(): void {
    if (!this.ws) return;
    try {
      (this.ws as unknown as { send(e: unknown): void }).send({ type: "input_audio_buffer.commit" });
    } catch (err) {
      this.log("error", `commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Required by the Realtime API: every tool call the model makes needs a
  // matching function_call_output, otherwise the conversation thread is
  // broken and the model improvises ("still running in the background")
  // because it has no idea what happened to its tool call.
  //
  // For sync tools (mark_*) we ack with brief output and skip response.create
  // since the model already verbalized. For async tools (cursor, web_search)
  // we ack with status:running + create a response so the model says "okay,
  // on it" — then sendSystemNote delivers the final result.
  private sendToolOutput(callId: string, output: unknown, triggerResponse: boolean): void {
    if (!this.ws) return;
    try {
      const wsAny = this.ws as unknown as { send(e: unknown): void };
      // function_call_output can be added to conversation history at any
      // time — even mid-response — without erroring. It just sits there
      // until the next response uses it.
      wsAny.send(functionCallOutputEvent(callId, output));
      if (triggerResponse) this.requestResponseCreate();
    } catch (err) {
      this.log(
        "error",
        `sendToolOutput failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Send response.create now if no response is active, otherwise queue
  // until the next response.done.
  private requestResponseCreate(): void {
    if (!this.ws) return;
    // Safety net: if responseActive has been stuck true for >15s with no
    // response.done coming back, force-clear it to unstick the queue.
    if (this.responseActive && this.responseStartedAt && Date.now() - this.responseStartedAt > 15_000) {
      this.log("info", "force-clearing stale responseActive");
      this.responseActive = false;
    }
    if (this.responseActive) {
      this.responseTriggerPending = true;
      return;
    }
    try {
      (this.ws as unknown as { send(e: unknown): void }).send(responseCreateEvent());
    } catch (err) {
      this.log(
        "error",
        `response.create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleToolCall(call: RealtimeToolCall): Promise<void> {
    if (!this.session) return;
    const { name, argsRaw, args } = call;
    // Visual ping for the renderer — every tool fire pops a balloon on the home
    // screen so the user knows the function call landed before the audio reply.
    this.emit("tool-fired", { name, args });

    // In edit mode (playheadProvider given), "now" = video playhead.
    // In recording mode, "now" = clock - start_epoch.
    const nowFromStart = this.opts.playheadProvider
      ? Math.round(this.opts.playheadProvider() * 1000) / 1000
      : Math.round((Date.now() / 1000 - this.session.start_epoch) * 1000) / 1000;
    const requestedTime = numOrUndef(args.time);
    const eventTime = requestedTime !== undefined ? requestedTime : nowFromStart;

    const callRecord = (status: "ok" | "skipped" | "error", event: TimelineEvent | null, error?: string) => {
      try {
        db.recordToolCall({
          run_name: this.runName,
          tool_name: name,
          arguments: argsRaw,
          event_type: event?.type ?? null,
          event_time: event?.time as number | undefined ?? null,
          status,
          error: error ?? null,
        });
      } catch {
        /* ignore DB errors */
      }
    };

    let event: TimelineEvent | null = null;
    // In edit mode (no live recording), the desktop cursor doesn't map to
    // anything useful in the video, so default zoom/click to canvas center.
    // The agent can override via x/y in tool args when known.
    const editMode = !!this.opts.playheadProvider;
    function pickXY(): { x: number; y: number } {
      const ax = numOrUndef(args.x);
      const ay = numOrUndef(args.y);
      if (ax !== undefined && ay !== undefined) return { x: ax, y: ay };
      if (editMode) return { x: 960, y: 540 }; // 1920x1080 canvas center
      const c = readCursor();
      return c ?? { x: 960, y: 540 };
    }

    try {
      switch (name) {
        case "mark_zoom": {
          const { x, y } = pickXY();
          event = {
            type: "zoom",
            time: eventTime,
            x,
            y,
            scale: numOr(args.scale, 1.4),
            duration: numOr(args.duration, 1.6),
            lead: 0.25,
            label: strOrUndef(args.label),
          };
          if (event.label) db.bumpSuggestion("zoom_label", event.label as string);
          break;
        }
        case "mark_click": {
          const { x, y } = pickXY();
          event = {
            type: "click",
            time: eventTime,
            x,
            y,
            scale: numOr(args.scale, 1.4),
            duration: numOr(args.duration, 1.6),
            lead: 0.25,
            label: strOrUndef(args.label),
            zoom: true,
          };
          if (event.label) db.bumpSuggestion("click_label", event.label as string);
          break;
        }
        case "mark_caption": {
          const text = String(args.text || "").trim();
          if (!text) {
            this.sendToolOutput(call.callId, { ok: false, error: "empty caption" }, false);
            return;
          }
          event = {
            type: "caption",
            time: eventTime,
            text,
            duration: numOr(args.duration, 2.0),
            position: String(args.position || "bottom"),
          };
          db.bumpSuggestion("caption", text);
          break;
        }
        case "mark_speed": {
          const start = numOrUndef(args.start);
          const end = numOrUndef(args.end);
          let resolvedStart: number;
          let resolvedEnd: number;
          if (start !== undefined && end !== undefined) {
            resolvedStart = start;
            resolvedEnd = end;
          } else {
            const back = numOr(args.seconds_back, 6.0);
            resolvedEnd = nowFromStart;
            resolvedStart = Math.max(0, nowFromStart - back);
          }
          if (resolvedEnd <= resolvedStart) {
            this.log("error", `mark_speed: bad range ${resolvedStart}-${resolvedEnd}`);
            callRecord("skipped", null, "bad range");
            this.sendToolOutput(call.callId, { ok: false, error: "bad range" }, false);
            return;
          }
          event = {
            type: "speed",
            time: resolvedStart,
            start: resolvedStart,
            end: resolvedEnd,
            factor: numOr(args.factor, 2.5),
            label: strOrUndef(args.label),
          };
          break;
        }
        case "mark_cut": {
          const start = numOrUndef(args.start);
          const end = numOrUndef(args.end);
          if (start === undefined || end === undefined || end <= start) {
            this.log("error", `mark_cut requires start<end (got ${start}-${end})`);
            callRecord("skipped", null, "bad range");
            this.sendToolOutput(call.callId, { ok: false, error: "need start and end with end>start" }, false);
            return;
          }
          event = {
            type: "cut",
            time: start,
            start,
            end,
            label: strOrUndef(args.label),
          };
          break;
        }
        case "mark_marker": {
          event = {
            type: "marker",
            time: eventTime,
            label: String(args.label || "").trim() || "marker",
          };
          break;
        }
        case "delegate_to_cursor": {
          const task = String(args.task || "").trim();
          if (!task) {
            this.log("error", "delegate_to_cursor: empty task");
            callRecord("skipped", null, "empty task");
            this.sendToolOutput(call.callId, { ok: false, error: "task required" }, false);
            return;
          }
          if (!isCursorConfigured()) {
            this.log("error", "delegate_to_cursor: CURSOR_API_KEY not set");
            callRecord("error", null, "no cursor key");
            this.sendToolOutput(call.callId, { ok: false, error: "CURSOR_API_KEY missing" }, false);
            return;
          }
          this.log("info", `delegating to cursor: ${task}`);
          callRecord("ok", null);
          // Ack the tool call so the conversation thread doesn't break.
          // The actual result lands later via sendSystemNote when the
          // Cursor run finishes.
          this.sendToolOutput(call.callId, { status: "running", task }, true);
          void this.runCursorTask(task);
          return;
        }
        case "web_search": {
          const query = String(args.query || "").trim();
          if (!query) {
            this.log("error", "web_search: empty query");
            callRecord("skipped", null, "empty query");
            this.sendToolOutput(call.callId, { ok: false, error: "query required" }, false);
            return;
          }
          const numResults = Math.min(8, Math.max(1, numOr(args.num_results, 4)));
          this.log("info", `web search: ${query}`);
          callRecord("ok", null);
          this.sendToolOutput(call.callId, { status: "searching", query }, true);
          void this.runWebSearch(query, numResults);
          return;
        }
        default:
          this.log("error", `unknown tool: ${name}`);
          callRecord("error", null, "unknown tool");
          this.sendToolOutput(call.callId, { ok: false, error: `unknown tool: ${name}` }, false);
          return;
      }

      if (event) {
        const written = await appendEvent(this.session, event);
        const note = (written.label as string) || (written.text as string) || "";
        this.log(
          "mark",
          `${written.type.padEnd(7, " ")} t=${Number(written.time).toFixed(2)}s  ${note}`,
        );
        callRecord("ok", written);
        // Close the Realtime conversation loop with a brief ack. No
        // response.create — the model already verbalized briefly when it
        // emitted the tool call, so we don't want it to speak again.
        this.sendToolOutput(call.callId, { ok: true, type: written.type, time: written.time }, false);
        // Fire-and-forget: kick off a debounced Cursor refine pass.
        scheduleRefine(this.session.run_dir, (kind, text) => this.log(kind, text));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", message);
      callRecord("error", event, message);
      this.sendToolOutput(call.callId, { ok: false, error: message }, false);
    }
  }


  private sendSystemNote(text: string): void {
    if (!this.ws) return;
    try {
      const wsAny = this.ws as unknown as { send(e: unknown): void };
      wsAny.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text }],
        },
      });
      this.requestResponseCreate();
    } catch (err) {
      this.log("error", `sendSystemNote failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runCursorTask(task: string): Promise<void> {
    try {
      const agent = await getAgent();
      const run = await agent.send(task);
      const result = await run.wait();
      const summary = (result.result || `${result.status}`).slice(0, 600);
      this.log("info", `cursor done: ${summary}`);
      this.sendSystemNote(`The coding agent finished: ${summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("error", `cursor failed: ${msg}`);
      this.sendSystemNote(`The coding agent failed: ${msg}`);
    }
  }

  private async runWebSearch(query: string, numResults: number): Promise<void> {
    const apiKey = process.env.EXA_API_KEY || process.env["EXA-API-KEY"];
    if (!apiKey) {
      this.log("error", "web_search: EXA_API_KEY not set");
      this.sendSystemNote("Web search unavailable: EXA_API_KEY missing.");
      return;
    }
    try {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          type: "auto",
          numResults,
          contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.log("error", `exa ${res.status}: ${detail.slice(0, 200)}`);
        this.sendSystemNote(`Web search failed (${res.status}). Tell the user briefly.`);
        return;
      }
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; highlights?: string[] }>;
      };
      const items = (data.results || []).slice(0, numResults);
      if (items.length === 0) {
        this.sendSystemNote(`No web results for "${query}". Tell the user.`);
        return;
      }
      const summary = items
        .map((r, i) => {
          const snippet = (r.highlights?.[0] || "").replace(/\s+/g, " ").trim().slice(0, 220);
          const title = (r.title || r.url || "result").slice(0, 90);
          return `${i + 1}. ${title} — ${snippet}`;
        })
        .join("\n");
      const note = `Web search results for "${query}":\n${summary}\n\nSummarize these naturally for the user in 2-4 sentences. Cite the most relevant title.`;
      this.log("info", `exa: ${items.length} results`);
      this.sendSystemNote(note);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("error", `web_search failed: ${msg}`);
      this.sendSystemNote(`Web search failed: ${msg}`);
    }
  }

  private log(kind: ListenLogLine["kind"], text: string): void {
    const line: ListenLogLine = { kind, text };
    this.emit("log", line);
    const prefix = kind === "mark" ? "+" : `[${kind}]`;
    console.log(`[listen] ${prefix} ${text}`);
  }
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrUndef(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function strOrUndef(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function readCursor(): { x: number; y: number } | null {
  try {
    const point = screen.getCursorScreenPoint();
    return { x: point.x, y: point.y };
  } catch {
    return null;
  }
}
