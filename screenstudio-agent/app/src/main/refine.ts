// Live refine pass. Fires asynchronously after the user marks events
// during a recording — uses the Cursor agent as a "second brain" that
// improves what the Realtime model emitted in the moment.
//
// Stateless on purpose: each refine spawns a fresh Agent.prompt() instead
// of reusing the polish singleton. The events.json file IS the memory of
// the take; we don't need conversational context across refines.
//
// Concurrency: debounced, single in-flight. Extra appendEvent calls
// during a refine queue a single follow-up — no fan-out.

import { Agent } from "@cursor/sdk";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { PROJECT_ROOT } from "./studio";
import * as db from "./db";

const DEBOUNCE_MS = 3000;
const MODEL_ID = process.env.CURSOR_AGENT_MODEL || "composer-2";

type LogFn = (kind: "info" | "error", text: string) => void;

interface State {
  runDir: string;
  log: LogFn;
  timer: NodeJS.Timeout | null;
  inflight: boolean;
  pending: boolean;
}

const state: Map<string, State> = new Map();

export function scheduleRefine(runDir: string, log: LogFn): void {
  if (!process.env.CURSOR_API_KEY) return; // silently no-op without a key
  let s = state.get(runDir);
  if (!s) {
    s = { runDir, log, timer: null, inflight: false, pending: false };
    state.set(runDir, s);
  }
  s.log = log;
  if (s.inflight) {
    s.pending = true;
    return;
  }
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s!.timer = null;
    void fire(s!);
  }, DEBOUNCE_MS);
}

async function fire(s: State): Promise<void> {
  s.inflight = true;
  try {
    await refineOnce(s.runDir, s.log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.log("error", `refine failed: ${message}`);
  } finally {
    s.inflight = false;
    if (s.pending) {
      s.pending = false;
      scheduleRefine(s.runDir, s.log);
    }
  }
}

const REFINE_RULES = [
  "You are refining a live screen-recording timeline as the user records.",
  "",
  "Constraints (NEVER violate):",
  "- Do NOT change the `time`, `start`, or `end` field on any existing event.",
  "- Do NOT delete or reorder existing events.",
  "- Do NOT touch events whose label is already 2-4 words and action-oriented.",
  "",
  "What to do:",
  "1. Read the timeline file with your Read tool.",
  "2. For zoom/click events whose label is missing/empty/vague, give them a 2-4 word",
  "   action-oriented label (use recent utterances as hints if helpful).",
  "3. For zoom/click events with NO caption event within 1.5s after them, add a",
  "   short caption event (max 6 words, no punctuation/quotes) ~0.4s after the",
  "   zoom/click. Insert it preserving ascending time order.",
  "4. Use your Edit tool to write the changes.",
  "",
  "Reply on a single line: 'refined N events' (count of events you changed or",
  "added) or 'no changes' if the timeline already looked good.",
].join("\n");

async function refineOnce(runDir: string, log: LogFn): Promise<void> {
  const eventsFile = path.join(runDir, "events.json");
  try {
    const raw = await fs.readFile(eventsFile, "utf-8");
    JSON.parse(raw);
  } catch {
    return; // no events.json yet, or unreadable — skip silently
  }

  const relPath = path.relative(PROJECT_ROOT, eventsFile);
  let utterancesBlock = "";
  try {
    const recent = db.recentUtterances(15);
    if (recent.length) {
      utterancesBlock =
        "\n\nRecent user utterances (most recent first):\n" +
        recent.map((u, i) => `  ${i + 1}. [t=${u.rec_time?.toFixed(1) ?? "?"}s] ${u.transcript}`).join("\n");
    }
  } catch {
    /* ignore — utterances are optional context */
  }

  const prompt = [
    REFINE_RULES,
    "",
    `Timeline file: ${relPath}`,
    utterancesBlock,
  ].join("\n");

  log("info", "refine: cursor pass starting");
  const result = await Agent.prompt(prompt, {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: MODEL_ID },
    name: "screenstudio-refine",
    local: { cwd: PROJECT_ROOT },
  });

  if (result.status === "finished") {
    const summary = (result.result || "").split("\n").pop()?.trim() || "done";
    log("info", `refine: ${summary}`);
  } else {
    log("error", `refine: ${result.status} ${result.result || ""}`.trim());
  }
}
