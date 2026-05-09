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
  "You are a screen-recording editing assistant. Fire a tool when the user clearly",
  "mentions zoom/cut/caption/speed/click/mark. After the tool, briefly confirm out",
  "loud (max 8 words).",
  "",
  "DO NOT fire tools on:",
  "- Filler words ('uh', 'oh', 'okay', 'yeah', 'one', 'r')",
  "- Background noise transcribed as random characters or non-English filler",
  "  (e.g. '谢谢观看', '请订阅' — those are Whisper hallucinations on silence)",
  "- Questions or chitchat without an editing verb",
  "",
  "If the transcript is unclear (under 3 meaningful words), say nothing and",
  "wait for a clearer utterance. Don't ask 'what?' — just stay silent.",
  "",
  "Examples that SHOULD fire:",
  "- 'zoom in here' -> mark_zoom + 'Zooming in.'",
  "- 'cut from 5 to 8' -> mark_cut(start=5, end=8) + 'Cut from 5 to 8.'",
  "- 'caption this as Open settings' -> mark_caption(text='Open settings') + 'Captioned.'",
  "- 'mark this' -> mark_marker(label='marker') + 'Marker added.'",
  "",
  "Never fire mark_cut without both start AND end. Never fire mark_caption with",
  "empty text.",
  "",
  "For ANYTHING ELSE the user asks (rendering, opening files, installing packages,",
  "answering project questions, multi-step edits) call delegate_to_cursor with a",
  "plain-English task. The user can keep talking while it runs.",
  "",
  "If the user asks something that needs FRESH WEB INFO (news, current events,",
  "looking up a person/product, finding docs/links), call web_search with a concise",
  "query. Briefly say 'searching the web…' so they know it's underway. The result",
  "comes back as a system note you can verbalize.",
].join("\n");

export const EDITOR_TOOLS = [
  {
    type: "function",
    name: "mark_zoom",
    description:
      "Zoom in on a moment in time. Defaults to canvas center; pass x/y in 1920x1080 space if the user names a region.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Seconds from recording start. Omit for 'now'." },
        label: { type: "string", description: "Brief label, e.g. 'settings panel'" },
        scale: { type: "number", description: "1.2-1.8 (default 1.4)" },
        duration: { type: "number", description: "Hold seconds (default 1.6)" },
        x: { type: "number", description: "Pixel x in 1920x1080 canvas. Omit to use cursor (record mode) or center (edit mode)." },
        y: { type: "number", description: "Pixel y in 1920x1080 canvas." },
      },
    },
  },
  {
    type: "function",
    name: "mark_click",
    description:
      "Mark a click moment with zoom emphasis. Use for 'click this', 'this click'.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Seconds from start. Omit for 'now'." },
        label: { type: "string" },
        scale: { type: "number" },
        duration: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
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
    name: "delegate_to_cursor",
    description:
      "Hand a complex multi-step task to the Cursor coding agent (composer-2) — which has Bash, Read, Edit, Grep tools over the project. Use for things that involve files, shell commands, multi-step edits, or anything beyond a single mark. The user can keep talking while the agent works; you'll be told the result async. Examples: 'render the smoke take and tell me how long it took', 'find all takes with no events and delete them', 'install ffmpeg-static and add it to package.json'.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Plain-English task description for the coding agent. Include any file paths or context the user mentioned.",
        },
      },
      required: ["task"],
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
  {
    type: "function",
    name: "web_search",
    description:
      "Search the live web via Exa for fresh facts, news, links, docs, or quick lookups. Returns the top result snippets and URLs as a system note. Use for anything that benefits from current info.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Concise search query, 3-12 words." },
        num_results: { type: "number", description: "How many results (default 4, max 8)." },
      },
      required: ["query"],
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
          silence_duration_ms: vad.silenceDurationMs ?? 600,
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
