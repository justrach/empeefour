// Trial: hand a long interview to the Cursor agent and let it cut a 30s
// shortform clip end-to-end. Agent has cwd = the run dir, drives ffmpeg
// itself, writes cuts.json + final.mp4. We pre-bake the transcript because
// it's a deterministic API call, not an editorial decision.

import { Agent } from "@cursor/sdk";
import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const VIDEO =
  "/Users/blackfloofie/Downloads/YTDown_YouTube_Why-Private-Credit-Is-Facing-Its-Biggest_Media_iBBOLjt8haY_001_1080p.mp4";
const RUN_DIR =
  "/Users/blackfloofie/empeefour/screenstudio-agent/runs/private-credit-trial";
const GOAL = [
  "30-second tight hook from a 10:50 interview about private credit.",
  "Pick the single most surprising or punchy moment with one coherent",
  "argument. Be aggressive on dead air, throat-clearing, and filler.",
  "The kept material should feel like one shortform clip that earns",
  "the next watch — not a montage of disconnected lines.",
].join(" ");

async function ensureAudio(audioPath: string): Promise<void> {
  if (fs.existsSync(audioPath)) return;
  console.log("→ extracting audio");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", VIDEO, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audioPath],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`ffmpeg audio extract failed (${r.status})`);
}

async function ensureRaw(rawPath: string): Promise<void> {
  if (fs.existsSync(rawPath)) return;
  console.log("→ copying raw video into run dir");
  fs.copyFileSync(VIDEO, rawPath);
}

async function ensureTranscript(audioPath: string, transcriptPath: string): Promise<void> {
  if (fs.existsSync(transcriptPath)) return;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  console.log("→ transcribing with whisper-1 (word timestamps)");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  } as never);
  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
  const wordCount = (transcript as { words?: unknown[] }).words?.length ?? "?";
  console.log(`  wrote transcript (${wordCount} words)`);
}

function buildAgentPrompt(): string {
  return [
    "You are an editorial assistant for shortform interview content. Your cwd",
    "is a run directory containing:",
    "",
    "  raw.mp4         — source video, ~10:50 long, interview about private credit",
    "  audio.mp3       — 16 kHz mono extract of the same audio",
    "  transcript.json — whisper-1 verbose_json. The `words` array has",
    "                    {word, start, end} (seconds). The `segments` array",
    "                    groups them into phrases.",
    "",
    `Editorial goal: ${GOAL}`,
    "",
    "Do this:",
    "",
    "1. Read transcript.json. Skim the `segments` array first to map the",
    "   territory; use the `words` array to lock exact cut times.",
    "2. Plan a list of KEEP spans — array of {start, end, reason} —",
    "   in source order (no reordering). Total kept duration: 28-32 seconds.",
    "   Trim aggressively: dead air, throat-clearing, 'you know'/'like'",
    "   filler, and any throat noise between sentences. Keep the cut on",
    "   word boundaries (use the start of the first word and the end of",
    "   the last word in each span).",
    "3. Write the plan to cuts.json (pretty-printed) so the choice is",
    "   auditable.",
    "4. Render final.mp4 in cwd using ffmpeg with a -filter_complex graph",
    "   that trims/atrims each keep span and concats them. Encoder:",
    "   libx264 crf 20 preset medium, aac 128k, +faststart. The filter",
    "   graph should produce one [v] and one [a] output stream that you",
    "   -map into the output file.",
    "5. Run `ffprobe -v error -show_entries format=duration -of",
    "   default=noprint_wrappers=1:nokey=1 final.mp4` and confirm the",
    "   duration is 25-35 seconds. If it's wildly off, adjust the filter",
    "   graph and re-render.",
    "6. Print a 3-5 line editorial summary explaining what you kept,",
    "   what you cut, and the single argument the clip carries.",
    "",
    "Do NOT add captions, zooms, or music. The judge wants to hear",
    "whether the cut itself is good. Do NOT reorder material.",
  ].join("\n");
}

async function main(): Promise<void> {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const audio = path.join(RUN_DIR, "audio.mp3");
  const raw = path.join(RUN_DIR, "raw.mp4");
  const transcript = path.join(RUN_DIR, "transcript.json");

  await ensureAudio(audio);
  await ensureRaw(raw);
  await ensureTranscript(audio, transcript);

  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY not set");
  }

  console.log("→ handing off to Cursor agent");
  const t0 = Date.now();
  const result = await Agent.prompt(buildAgentPrompt(), {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: process.env.CURSOR_AGENT_MODEL || "composer-2" },
    local: { cwd: RUN_DIR },
  });
  console.log(`\n--- agent ${result.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  if (result.result) {
    console.log("\n" + result.result + "\n");
  }

  const finalPath = path.join(RUN_DIR, "final.mp4");
  if (fs.existsSync(finalPath)) {
    console.log(`→ opening ${finalPath}`);
    spawnSync("open", [finalPath]);
  } else {
    console.log("final.mp4 was not produced — inspect agent output above.");
    process.exit(2);
  }
}

main().catch((e: Error) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
