// Post-recording polish via the Cursor agent.
//
// We hand the agent the run directory and a schema cheatsheet, and let it
// use its built-in Read/Edit tools to refine labels and add captions on the
// timeline. The agent's natural mode is file editing, so we lean on that
// instead of wrapping a custom MCP layer.
//
// By default we copy events.json -> events.polished.json first and point
// the agent at the polished file, so the original timeline is preserved.
// Pass apply=true to operate directly on events.json.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getAgent } from "./agent";
import { PROJECT_ROOT } from "./studio";

const SYSTEM = `\
You are an editor polishing a screen-recording timeline. The timeline lives \
at runs/<take>/events.json (an EventsDoc with shape { version, recording, \
events: TimelineEvent[] }).

Each TimelineEvent has at least { type, time }. Common types:
- zoom    : { type, time, x, y, scale, duration, lead, label? }
- click   : same as zoom plus zoom: true
- caption : { type, time, text, duration, position: "top"|"bottom" }
- speed   : { type, time, start, end, factor, label? }
- cut     : { type, time, start, end, label? }
- marker  : { type, time, label }

Polish rules:
- Keep every original event; do not delete or reorder existing entries.
- Refine the \`label\` field on zoom/click events to be 2-4 words, action-oriented.
- Where a zoom/click has no nearby caption (within 1.5s after), add a caption \
event 0.3-0.6s after it explaining what the user is looking at.
- Captions: max 6 words, no trailing punctuation, no quotes.
- Do not invent state you cannot verify from the events themselves.
- Output must remain valid JSON; events sorted ascending by time.`;

export interface PolishOptions {
  apply?: boolean;
}

export async function polish(runDir: string, opts: PolishOptions = {}): Promise<string> {
  const eventsFile = path.join(runDir, "events.json");
  const raw = await fs.readFile(eventsFile, "utf-8");
  // Validate it's parseable up front so we fail before spending tokens.
  JSON.parse(raw);

  const target = opts.apply
    ? eventsFile
    : path.join(runDir, "events.polished.json");

  if (!opts.apply) {
    await fs.writeFile(target, raw, "utf-8");
  }

  const relTarget = path.relative(PROJECT_ROOT, target);
  const agent = await getAgent();

  const prompt = [
    SYSTEM,
    "",
    `Edit the timeline at ${relTarget}. Use your Read tool to inspect it, then your Edit tool to apply changes. Do not write any other files.`,
    "When you are done, reply with a one-line summary of what you changed.",
  ].join("\n");

  const run = await agent.send(prompt);
  const result = await run.wait();
  if (result.status !== "finished") {
    throw new Error(`cursor agent ${result.status}: ${result.result || "no detail"}`);
  }
  return target;
}
