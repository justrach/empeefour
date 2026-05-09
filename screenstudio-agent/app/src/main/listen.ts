// Voice-driven event marking via OpenAI Realtime (gpt-realtime-2).
//
// Tools accept optional `time` (seconds from recording start) so the user
// can say things like "zoom on second 12" or "cut from 5 to 8". When time
// is omitted, "now" is used. Every utterance + tool call is mirrored into
// the local SQLite store so the agent has memory across sessions.

import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { screen } from "electron";

import { StudioSession, TimelineEvent, appendEvent, loadActiveSession } from "./studio";
import * as db from "./db";
import { scheduleRefine } from "./refine";
import {
  PcmChunker,
  REALTIME_AUDIO,
  buildEditingSessionUpdate,
  inputAudioAppendEvent,
  parseRealtimeToolCall,
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
  private speaker: import("node:child_process").ChildProcess | null = null;
  private muted = false;
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
        this.startSpeaker();
        this.log("info", "voice-back on — wear headphones to avoid mic feedback");
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
      if (!delta || !this.speaker?.stdin?.writable) return;
      try {
        this.speaker.stdin.write(Buffer.from(delta, "base64"));
      } catch {
        /* speaker died — ignore */
      }
    });

    // Show what the model is saying alongside its audio.
    wsAny.on("response.output_audio_transcript.done", (event) => {
      const text = String((event as { transcript?: string })?.transcript || "").trim();
      if (text) this.log("info", `model: ${text}`);
    });

    // Surface text-only responses (model emitting prose instead of tools)
    // so we can see why a tool didn't fire.
    ws.on("response.output_text.done", (event) => {
      const text = String((event as { text?: string }).text || "").trim();
      if (text) this.log("info", `model said (no tool): ${text}`);
    });
    ws.on("response.done", (event) => {
      const r = (event as { response?: { status?: string; status_details?: { error?: { message?: string } } } }).response;
      if (r?.status === "failed") {
        this.log("error", `response failed: ${r.status_details?.error?.message || "unknown"}`);
      }
    });

    ws.on("error", (err) => this.log("error", err.message || String(err)));
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
    this.stopSpeaker();
    this.log("info", "stopped");
  }

  private startSpeaker(): void {
    try {
      this.speaker = spawn(
        "ffplay",
        [
          "-autoexit",
          "-nodisp",
          "-loglevel", "quiet",
          "-f", "s16le",
          "-ar", String(REALTIME_AUDIO.sampleRate),
          "-ac", String(REALTIME_AUDIO.channels),
          "-",
        ],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      this.speaker.on("exit", () => {
        this.speaker = null;
      });
      this.speaker.on("error", (err) => {
        this.log("error", `speaker failed: ${err.message}`);
        this.speaker = null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", `couldn't start ffplay: ${message}`);
      this.speaker = null;
    }
  }

  private stopSpeaker(): void {
    if (!this.speaker) return;
    try {
      this.speaker.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.speaker.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.speaker = null;
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

  private async handleToolCall(call: RealtimeToolCall): Promise<void> {
    if (!this.session) return;
    const { name, argsRaw, args } = call;

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
          if (!text) return;
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
        default:
          this.log("error", `unknown tool: ${name}`);
          callRecord("error", null, "unknown tool");
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
        // Fire-and-forget: kick off a debounced Cursor refine pass.
        scheduleRefine(this.session.run_dir, (kind, text) => this.log(kind, text));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log("error", message);
      callRecord("error", event, message);
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
