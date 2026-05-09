// Cursor Agent singleton. The agent is the brain for both the polish path
// (post-recording timeline cleanup) and, eventually, live mark refinement.
//
// We use the local runtime so the agent has filesystem access scoped to
// PROJECT_ROOT — it can Read/Edit events.json directly with its built-in
// tools instead of us wrapping every mark behind a custom MCP server.

import { Agent, type SDKAgent } from "@cursor/sdk";
import { PROJECT_ROOT } from "./studio";

let agent: SDKAgent | null = null;
let pending: Promise<SDKAgent> | null = null;

export function isConfigured(): boolean {
  return !!process.env.CURSOR_API_KEY;
}

export async function getAgent(): Promise<SDKAgent> {
  if (agent) return agent;
  if (pending) return pending;
  if (!process.env.CURSOR_API_KEY) {
    throw new Error("CURSOR_API_KEY not set; populate screenstudio-agent/.env");
  }
  const model = process.env.CURSOR_AGENT_MODEL || "composer-2";
  pending = Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: model },
    name: "screenstudio-agent",
    local: { cwd: PROJECT_ROOT },
  })
    .then((a) => {
      agent = a;
      pending = null;
      console.log(`[agent] cursor agent ready (model=${model}, agentId=${a.agentId})`);
      return a;
    })
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}

export async function closeAgent(): Promise<void> {
  if (!agent) return;
  try {
    agent.close();
  } catch {
    /* ignore */
  }
  agent = null;
}
