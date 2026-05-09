// agentic-video/run.ts
//
// Hand a video + a freeform editorial brief to the Cursor agent. The agent
// reads skills/ to know how to act, has access to library/music/, and
// writes output (cuts.json, music.json, final.mp4) into runs/<name>/.
//
//   npm run run -- \
//     --video /path/to/source.mp4 \
//     --prompt "30s tight hook with a music bed under it"
//
// State (videos, transcripts, runs) is persisted in runs/agentic-video.db.
// Transcripts are cached by video sha1 — re-running the same source skips
// the API call.

import { Agent } from "@cursor/sdk";
import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";
import * as db from "./db";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "runs", "agentic-video.db");
dotenv.config({ path: path.join(ROOT, ".env") });

interface Args {
  video: string;
  prompt: string;
  name?: string;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      video: { type: "string", short: "v" },
      prompt: { type: "string", short: "p" },
      name: { type: "string", short: "n" },
    },
    strict: true,
  });
  if (!values.video) throw new Error("--video <path> required");
  if (!values.prompt) throw new Error("--prompt <text> required");
  return {
    video: path.resolve(values.video),
    prompt: values.prompt,
    name: values.name,
  };
}

function shortHash(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function shellOk(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
}

function shellOut(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

interface VideoMeta {
  duration_s: number;
  width: number;
  height: number;
  has_audio: boolean;
}

function probeVideo(filePath: string): VideoMeta {
  const out = shellOut("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=codec_type,width,height",
    "-of", "json",
    filePath,
  ]);
  const j = JSON.parse(out) as {
    format: { duration?: string };
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  return {
    duration_s: parseFloat(j.format.duration ?? "0"),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    has_audio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

function ensureRaw(srcVideo: string, rawPath: string): void {
  if (fs.existsSync(rawPath)) return;
  console.log("→ linking raw video into run dir");
  fs.symlinkSync(srcVideo, rawPath);
}

function ensureAudio(rawPath: string, audioPath: string): void {
  if (fs.existsSync(audioPath)) return;
  console.log("→ extracting audio");
  shellOk("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", rawPath, "-vn",
    "-ac", "1", "-ar", "16000", "-b:a", "32k",
    audioPath,
  ]);
}

async function ensureTranscript(
  conn: ReturnType<typeof db.open>,
  sha1: string,
  audioPath: string,
  transcriptPath: string,
  hasAudio: boolean,
): Promise<void> {
  if (fs.existsSync(transcriptPath)) return;

  // Cache hit?
  const cached = db.getTranscript(conn, sha1);
  if (cached) {
    console.log(`→ transcript cache hit (sha1 ${sha1.slice(0, 8)})`);
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        text: cached.text,
        words: JSON.parse(cached.words_json),
        segments: JSON.parse(cached.segments_json),
      }, null, 2),
    );
    return;
  }

  // No audio track at all — write an empty transcript and continue.
  if (!hasAudio) {
    console.log("→ no audio stream; writing empty transcript");
    const empty = { text: "", words: [], segments: [] };
    fs.writeFileSync(transcriptPath, JSON.stringify(empty, null, 2));
    db.putTranscript(conn, sha1, empty);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set in .env");
  }
  console.log("→ transcribing with whisper-1 (word + segment timestamps)");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  } as never);
  const t = transcript as { text?: string; words?: unknown[]; segments?: unknown[] };
  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
  db.putTranscript(conn, sha1, t);
  console.log(`  wrote transcript (${t.words?.length ?? 0} words) and cached`);
}

function buildAgentPrompt(runName: string, userBrief: string, hasAudio: boolean): string {
  return [
    "You are an agentic video editor. Your cwd is the agentic-video project root.",
    "",
    `The current run dir is runs/${runName}/. It already contains:`,
    "  raw.mp4         the source video",
    "  audio.mp3       16 kHz mono extract",
    "  transcript.json whisper-1 verbose_json with word-level timing",
    hasAudio
      ? ""
      : "  (transcript will be empty — the source has no usable dialogue. Make cut decisions on visual rhythm, scene changes, and motion.)",
    "",
    "Skills documenting how to act are in skills/. READ skills/README.md",
    "first to see the index. Then read the SKILL.md files relevant to the",
    "user brief below BEFORE acting. The skills encode lessons from prior",
    "runs — cut-shortform (editorial spine, source-order discipline, tail",
    "support), overlay-music (track choice, ducking, hook+body separation),",
    "render-final (encoder + filter graph patterns).",
    "",
    "The music library is at library/music/. Inspect filenames and use",
    "ffprobe to confirm format. Prefer instrumental tracks under dialogue.",
    "",
    "User editorial brief:",
    "----------------------------------------",
    userBrief,
    "----------------------------------------",
    "",
    "Output contract (leave a paper trail):",
    `  runs/${runName}/cuts.json    — keep-spans + optional tail block + reasoning`,
    `  runs/${runName}/music.json   — chosen track + ducking config (if scored)`,
    `  runs/${runName}/final.mp4    — the rendered output`,
    "",
    "When done, print a 3-5 line editorial summary explaining your choices.",
  ].filter((line) => line !== "").join("\n");
}

function readJsonOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parse();
  const runName = args.name ?? `take-${shortHash(args.video)}-${Date.now()}`;
  const runDir = path.join(ROOT, "runs", runName);
  fs.mkdirSync(runDir, { recursive: true });

  const conn = db.open(DB_PATH);

  const raw = path.join(runDir, "raw.mp4");
  const audio = path.join(runDir, "audio.mp3");
  const transcript = path.join(runDir, "transcript.json");

  ensureRaw(args.video, raw);

  console.log("→ hashing source");
  const sha1 = db.sha1FileSync(args.video);
  const meta = probeVideo(args.video);
  db.upsertVideo(conn, {
    sha1,
    source_path: args.video,
    duration_s: meta.duration_s,
    width: meta.width,
    height: meta.height,
    has_audio: meta.has_audio ? 1 : 0,
  });
  console.log(`  ${sha1.slice(0, 12)}…  ${meta.width}x${meta.height}  ${meta.duration_s.toFixed(1)}s  audio=${meta.has_audio}`);

  if (meta.has_audio) ensureAudio(raw, audio);
  await ensureTranscript(conn, sha1, audio, transcript, meta.has_audio);

  if (!process.env.CURSOR_API_KEY) throw new Error("CURSOR_API_KEY not set in .env");
  const model = process.env.CURSOR_AGENT_MODEL || "composer-2";
  const promptText = buildAgentPrompt(runName, args.prompt, meta.has_audio);

  const runId = db.startRun(conn, {
    name: runName,
    video_sha1: sha1,
    prompt: args.prompt,
    model,
  });

  console.log(`→ handing off to Cursor agent (run #${runId}: ${runName})`);
  const t0 = Date.now();
  let status = "error";
  let summary: string | null = null;
  try {
    const result = await Agent.prompt(promptText, {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: model },
      local: { cwd: ROOT },
    });
    status = result.status;
    summary = result.result ?? null;
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n--- agent ${status} in ${dt}s ---\n`);
    if (summary) console.log(summary + "\n");
  } catch (e: unknown) {
    summary = (e as Error).message;
    console.error(`agent threw: ${summary}`);
  }

  const finalPath = path.join(runDir, "final.mp4");
  let finalDuration: number | null = null;
  if (fs.existsSync(finalPath)) {
    try {
      finalDuration = parseFloat(shellOut("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        finalPath,
      ]));
    } catch { /* ignore */ }
  }

  db.finishRun(conn, runId, {
    status,
    agent_duration_ms: Date.now() - t0,
    cuts_json: readJsonOrNull(path.join(runDir, "cuts.json")),
    music_json: readJsonOrNull(path.join(runDir, "music.json")),
    summary,
    final_path: fs.existsSync(finalPath) ? finalPath : null,
    final_duration_s: finalDuration,
  });

  if (fs.existsSync(finalPath)) {
    console.log(`→ opening ${finalPath}`);
    spawnSync("open", [finalPath]);
  } else {
    console.log("final.mp4 was not produced — check agent output above.");
    process.exit(2);
  }
}

main().catch((e: Error) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
