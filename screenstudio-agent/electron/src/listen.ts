// Voice-driven event marking via OpenAI Realtime (gpt-realtime-2).
//
// Tools accept optional `time` (seconds from recording start) so the user
// can say things like "zoom on second 12" or "cut from 5 to 8". When time
// is omitted, "now" is used. Every utterance + tool call is mirrored into
// the local SQLite store so the agent has memory across sessions.

import OpenAI from "openai";
import { OpenAIRealtimeWS } from "openai/realtime/ws";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { screen } from "electron";

import { StudioSession, TimelineEvent, appendEvent, loadActiveSession } from "./studio";
import * as db from "./db";
import { scheduleRefine } from "./refine";

const SAMPLE_RATE = 24_000;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

const SYSTEM_INSTRUCTIONS = [
  "You are an editing assistant for a screen recording. Your ONLY job is to call",
  "the right tool when the user mentions an editing action. Be liberal -- any",
  "mention of zoom/cut/caption/speed/click/mark, even phrased as a question or",
  "suggestion, IS a command. Examples of utterances that should fire tools:",
  "",
  "- 'zoom in here' -> mark_zoom (cursor, now)",
  "- 'can we zoom in a little?' -> mark_zoom (cursor, now)",
  "- 'lets zoom on second 12' -> mark_zoom(time=12)",
  "- 'this click is important' -> mark_click",
  "- 'caption this as Open settings' -> mark_caption(text='Open settings')",
  "- 'speed this up' -> mark_speed (last 6 sec at 2.5x)",
  "- 'speed from 4 to 9' -> mark_speed(start=4, end=9)",
  "- 'cut from 5 to 8' -> mark_cut(start=5, end=8)",
  "- 'delete this part' / 'remove that bit' -> mark_cut (recent span)",
  "- 'mark this' / 'remember this' -> mark_marker",
  "",
  "When in doubt, FIRE A TOOL. False positives are fine; missed marks are not.",
  "Do not respond with text. Only emit tool calls.",
].join("\n");

const TOOLS = [
  {
    type: "function",
    name: "mark_zoom",
    description:
      "Zoom in on the user's cursor at a moment in time. Use for 'zoom here' (now) or 'zoom on second N' (specific time).",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Seconds from recording start. Omit for 'now'." },
        label: { type: "string", description: "Brief label, e.g. 'settings panel'" },
        scale: { type: "number", description: "1.2-1.8 (default 1.4)" },
        duration: { type: "number", description: "Hold seconds (default 1.6)" },
      },
    },
  },
  {
    type: "function",
    name: "mark_click",
    description:
      "Mark a click moment with zoom emphasis at the cursor position. Use for 'click this', 'this click'.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Seconds from start. Omit for 'now'." },
        label: { type: "string" },
        scale: { type: "number" },
        duration: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "mark_caption",
    description:
      "Add an on-screen caption. Use for 'caption this as <text>' or 'caption second N as <text>'.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        time: { type: "number", description: "Seconds from start. Omit for 'now'." },
        duration: { type: "number", description: "default 2.0" },
        position: { type: "string", enum: ["top", "bottom"] },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "mark_speed",
    description:
      "Speed up a span. Use for 'speed up from N to M' or 'speed this up' (recent N seconds).",
    parameters: {
      type: "object",
      properties: {
        start: { type: "number", description: "Start time in seconds (omit if user said 'this')" },
        end: { type: "number", description: "End time in seconds" },
        seconds_back: { type: "number", description: "If start/end omitted, look back N seconds (default 6)" },
        factor: { type: "number", description: "Speed multiplier (default 2.5)" },
        label: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "mark_cut",
    description:
      "REMOVE a span of footage entirely. Use for 'cut from N to M', 'cut second N to second M', 'delete this part'.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "number", description: "Start time in seconds" },
        end: { type: "number", description: "End time in seconds" },
        label: { type: "string", description: "Optional reason, e.g. 'dead air'" },
      },
      required: ["start", "end"],
    },
  },
  {
    type: "function",
    name: "mark_marker",
    description: "Drop a generic timeline marker. Use for 'mark this', 'remember this point'.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        time: { type: "number", description: "Seconds from start. Omit for 'now'." },
      },
      required: ["label"],
    },
  },
];

export interface ListenOptions {
  model?: string;
  micDevice?: string;
}

export type ListenLogLine = { kind: "info" | "heard" | "mark" | "error"; text: string };

export class VoiceAgent extends EventEmitter {
  private ws: OpenAIRealtimeWS | null = null;
  private ffmpeg: ReturnType<typeof spawn> | null = null;
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
    const session = await loadActiveSession();
    if (!session) throw new Error("No active recording. Click Start first.");
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
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "avfoundation", "-i", mic,
        "-ac", "1", "-ar", String(SAMPLE_RATE),
        "-f", "s16le", "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    this.ffmpeg.stderr?.on("data", (d: Buffer) => this.log("error", d.toString().trim()));

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const ws = new OpenAIRealtimeWS({ model }, client);
    this.ws = ws;

    ws.socket.on("open", () => {
      ws.send({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["text"],
          instructions: SYSTEM_INSTRUCTIONS,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "whisper-1" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
          },
          tools: TOOLS,
          tool_choice: "auto",
        },
      } as never);
      this.startAudioPump();
    });

    ws.on("response.function_call_arguments.done", (event) => {
      const name = (event as { name?: string }).name || "";
      const argsRaw = (event as { arguments?: string }).arguments || "{}";
      this.handleToolCall(name, argsRaw).catch((err: Error) =>
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
    // Surface text responses (model emitting prose instead of tools) so we
    // can see why a tool didn't fire.
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
    this.log("info", "stopped");
  }

  private startAudioPump(): void {
    if (!this.ffmpeg || !this.ws) return;
    const stream = this.ffmpeg.stdout;
    if (!stream) return;
    let pending: Buffer = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= CHUNK_BYTES && this.ws && this.active) {
        const out = pending.subarray(0, CHUNK_BYTES);
        pending = pending.subarray(CHUNK_BYTES);
        try {
          this.ws.send({
            type: "input_audio_buffer.append",
            audio: out.toString("base64"),
          });
        } catch {
          return;
        }
      }
    });
    stream.on("end", () => this.log("info", "ffmpeg stream ended"));
  }

  private async handleToolCall(name: string, argsRaw: string): Promise<void> {
    if (!this.session) return;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = {};
    }

    const nowFromStart =
      Math.round((Date.now() / 1000 - this.session.start_epoch) * 1000) / 1000;
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
    try {
      switch (name) {
        case "mark_zoom": {
          const cursor = readCursor();
          if (!cursor) {
            this.log("error", "mark_zoom: no cursor reading");
            callRecord("skipped", null, "no cursor");
            return;
          }
          event = {
            type: "zoom",
            time: eventTime,
            x: cursor.x,
            y: cursor.y,
            scale: numOr(args.scale, 1.4),
            duration: numOr(args.duration, 1.6),
            lead: 0.25,
            label: strOrUndef(args.label),
          };
          if (event.label) db.bumpSuggestion("zoom_label", event.label as string);
          break;
        }
        case "mark_click": {
          const cursor = readCursor();
          if (!cursor) {
            this.log("error", "mark_click: no cursor reading");
            callRecord("skipped", null, "no cursor");
            return;
          }
          event = {
            type: "click",
            time: eventTime,
            x: cursor.x,
            y: cursor.y,
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
