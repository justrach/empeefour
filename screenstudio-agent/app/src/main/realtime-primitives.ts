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
  "You are Studio, a friendly voice assistant for a screen-recording editor.",
  "You can hear the user through their mic and reply with audio. Be warm and",
  "conversational — short sentences (max ~25 words per reply unless asked for more).",
  "Confirm you're listening when greeted. Answer questions about the project,",
  "their takes, what you can do, etc. Don't deflect with 'I only respond to text'",
  "— you are a voice agent.",
  "",
  "When the user clearly asks for an EDIT, fire the matching tool and briefly",
  "confirm out loud (max 8 words). Examples:",
  "- 'zoom in here' -> mark_zoom + 'Zooming in.'",
  "- 'cut from 5 to 8' -> mark_cut(start=5, end=8) + 'Cut from 5 to 8.'",
  "- 'caption this as Open settings' -> mark_caption(text='Open settings') + 'Captioned.'",
  "- 'mark this' -> mark_marker(label='marker') + 'Marker added.'",
  "",
  "For complex multi-step work (rendering, opening files, installing packages,",
  "running shell commands, multi-edit changes), call delegate_to_cursor with a",
  "plain-English task. Say 'on it' briefly. The user can keep talking while it",
  "runs and you'll get the result later as a system note to verbalize.",
  "",
  "For fresh web info (news, current events, looking up a person/product, finding",
  "docs/links), call web_search with a concise query. Briefly say 'searching the",
  "web…'. Results land as a system note — verbalize them in 2-3 sentences.",
  "",
  "For questions about the user's Apple Health data (steps, distance, heart rate,",
  "weight, sleep, workouts — e.g. 'how many steps last week?', 'what's my heart",
  "rate trend?', 'summarize my workouts'), call health_data_analysis with a short",
  "query and the relevant metric. Briefly say 'checking your health data…'. Stats",
  "land as a system note — verbalize the key numbers naturally in 2-4 sentences.",
  "",
  "When the user asks to make/draw/render/visualize an image, picture, mock-up,",
  "thumbnail, or background, fire generate_image with a vivid prompt. Briefly",
  "say 'rendering an image…' first. The save path lands as a system note —",
  "mention the save location + a one-sentence description of what you made.",
  "",
  "Never fire mark_cut without both start AND end. Never fire mark_caption with",
  "empty text. Don't fire tools on filler ('uh', 'oh', 'one'), background noise,",
  "or non-English Whisper hallucinations like '谢谢观看' / '请订阅'.",
  "",
  "If a transcript is genuinely unintelligible (under 3 meaningful words and not",
  "a greeting), it's fine to stay quiet for one turn — but don't go silent on",
  "real questions just because they aren't editing verbs.",
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
    name: "generate_image",
    description:
      "Create an image from a text prompt using gpt-image-2-2026-04-21. Saves a PNG to ~/empeefour/screenstudio-agent/runs/images/ and opens it. Use whenever the user asks to make/draw/render/imagine/visualize an image, picture, illustration, mock-up, thumbnail, or background. Briefly say 'rendering an image…' first. The save path lands as a system note for you to mention.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Vivid description of the desired image. Include style, mood, composition. Up to 32k chars.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
          description: "Aspect: square / landscape / portrait. Default 'auto'.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description: "Render quality. Default 'auto'. Use 'high' only when the user asks for detail.",
        },
      },
      required: ["prompt"],
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
  {
    type: "function",
    name: "health_data_analysis",
    description:
      "Read the user's pre-exported Apple Health data (CSVs in ~/apple-health/analysis, or the dir set by HEALTH_ANALYSIS_DIR) and return summary stats. Covers steps, distance, heart rate, weight, sleep, and workouts. Use for any question about the user's own activity, fitness, sleep, or vitals (e.g. 'how many steps last week', 'heart rate trend', 'how much did I run this month', 'sleep quality lately'). Stats arrive as a system note for the model to verbalize.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's question, in their words. Used to focus the verbal answer." },
        metric: {
          type: "string",
          enum: ["steps", "distance", "heart_rate", "weight", "sleep", "workouts", "summary"],
          description: "Which metric to summarize. Use 'summary' for a multi-metric overview when the user asks broadly.",
        },
        days: { type: "number", description: "Recent window in days for the 'last N days' average (default 7). Use 30 for monthly questions." },
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
  // When true, disables server VAD — the client controls every turn via
  // input_audio_buffer.commit + response.create. Use with PTT.
  pushToTalk?: boolean;
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
        // Push-to-talk mode disables server VAD entirely. Without this, the
        // server auto-commits the input buffer ~600ms after silence and our
        // manual commit on PTT-release races, causing
        // INPUT_AUDIO_BUFFER_COMMIT_EMPTY errors. We control all turn
        // boundaries client-side via input_audio_buffer.commit + response.create.
        turn_detection: opts.pushToTalk
          ? null
          : {
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
