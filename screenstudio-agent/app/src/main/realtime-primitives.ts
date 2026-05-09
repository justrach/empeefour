import { spawn } from "node:child_process";

import type {
  ConversationItemCreateEvent,
  InputAudioBufferAppendEvent,
  RealtimeFunctionTool,
  ResponseCreateEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  SessionUpdateEvent,
} from "openai/resources/realtime/realtime";

export const REALTIME_AUDIO = {
  sampleRate: 24_000,
  channels: 1,
  bytesPerSample: 2,
  chunkMs: 100,
} as const;

export const EDITOR_SYSTEM_INSTRUCTIONS = [
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

export const EDITOR_TOOLS = [
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
] satisfies RealtimeFunctionTool[];

export interface EditingSessionOptions {
  instructions?: string;
  tools?: RealtimeFunctionTool[];
  sampleRate?: typeof REALTIME_AUDIO.sampleRate;
  transcriptionModel?: string;
  vad?: {
    threshold?: number;
    silenceDurationMs?: number;
    createResponse?: boolean;
    interruptResponse?: boolean;
  };
  parallelToolCalls?: boolean;
  // When true (default) the assistant speaks back via PCM audio output.
  speakBack?: boolean;
  voice?: string;
}

export interface RealtimeToolCall {
  callId: string;
  itemId: string;
  responseId: string;
  outputIndex: number;
  name: string;
  argsRaw: string;
  args: Record<string, unknown>;
}

export function pcmChunkBytes(audio = REALTIME_AUDIO): number {
  return (audio.sampleRate * audio.channels * audio.bytesPerSample * audio.chunkMs) / 1000;
}

export function buildEditingSessionUpdate(opts: EditingSessionOptions = {}): SessionUpdateEvent {
  const vad = opts.vad ?? {};
  const speakBack = opts.speakBack ?? true;
  const session = {
    type: "realtime",
    output_modalities: speakBack ? ["audio"] : ["text"],
    instructions: opts.instructions ?? EDITOR_SYSTEM_INSTRUCTIONS,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: opts.sampleRate ?? REALTIME_AUDIO.sampleRate },
        transcription: { model: opts.transcriptionModel ?? "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: vad.threshold ?? 0.5,
          silence_duration_ms: vad.silenceDurationMs ?? 500,
          create_response: vad.createResponse ?? true,
          interrupt_response: vad.interruptResponse ?? true,
        },
      },
      ...(speakBack
        ? {
            output: {
              voice: opts.voice ?? "alloy",
              format: { type: "audio/pcm", rate: opts.sampleRate ?? REALTIME_AUDIO.sampleRate },
            },
          }
        : {}),
    },
    tools: opts.tools ?? EDITOR_TOOLS,
    tool_choice: "auto",
    ...(opts.parallelToolCalls !== undefined ? { parallel_tool_calls: opts.parallelToolCalls } : {}),
  } satisfies Extract<SessionUpdateEvent["session"], { type: "realtime" }>;
  return { type: "session.update", session };
}

export function inputAudioAppendEvent(chunk: Buffer): InputAudioBufferAppendEvent {
  return {
    type: "input_audio_buffer.append",
    audio: chunk.toString("base64"),
  };
}

export function functionCallOutputEvent(callId: string, output: unknown): ConversationItemCreateEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: typeof output === "string" ? output : JSON.stringify(output),
    },
  };
}

export function responseCreateEvent(): ResponseCreateEvent {
  return { type: "response.create" };
}

export function parseRealtimeToolCall(event: ResponseFunctionCallArgumentsDoneEvent): RealtimeToolCall {
  const argsRaw = event.arguments || "{}";
  return {
    callId: event.call_id,
    itemId: event.item_id,
    responseId: event.response_id,
    outputIndex: event.output_index,
    name: event.name,
    argsRaw,
    args: parseJsonObject(argsRaw),
  };
}

export class PcmChunker {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly onChunk: (chunk: Buffer) => void,
    private readonly chunkBytes = pcmChunkBytes(),
  ) {}

  push(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= this.chunkBytes) {
      const out = this.pending.subarray(0, this.chunkBytes);
      this.pending = this.pending.subarray(this.chunkBytes);
      this.onChunk(out);
    }
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
  }
}

export interface MacMicPcmOptions {
  device?: string;
  sampleRate?: number;
  channels?: number;
}

export function spawnMacMicPcm(opts: MacMicPcmOptions = {}): ReturnType<typeof spawn> {
  return spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-i",
      opts.device ?? ":0",
      "-ac",
      String(opts.channels ?? REALTIME_AUDIO.channels),
      "-ar",
      String(opts.sampleRate ?? REALTIME_AUDIO.sampleRate),
      "-f",
      "s16le",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
