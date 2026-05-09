// Quick CLI to dump recent runs from the SQLite DB.
//   npm run list

import * as path from "node:path";
import * as db from "./db";

const ROOT = path.resolve(__dirname, "..");
const conn = db.open(path.join(ROOT, "runs", "agentic-video.db"));

const rows = db.listRuns(conn, 20);
if (rows.length === 0) {
  console.log("(no runs yet)");
  process.exit(0);
}

console.log(`${"id".padStart(3)}  ${"name".padEnd(38)}  ${"status".padEnd(10)}  ${"dur".padStart(6)}  ${"agent".padStart(6)}  prompt`);
console.log("-".repeat(120));
for (const r of rows) {
  const dur = r.final_duration_s != null ? `${r.final_duration_s.toFixed(1)}s` : "—";
  const agent = r.agent_duration_ms != null ? `${(r.agent_duration_ms / 1000).toFixed(0)}s` : "—";
  const promptShort = r.prompt.length > 60 ? r.prompt.slice(0, 57) + "…" : r.prompt;
  console.log(
    `${String(r.id).padStart(3)}  ${r.name.padEnd(38)}  ${(r.status ?? "?").padEnd(10)}  ${dur.padStart(6)}  ${agent.padStart(6)}  ${promptShort}`,
  );
}
