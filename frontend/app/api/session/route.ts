// Mints an ephemeral Realtime API client secret on the server, so the
// browser never sees the long-lived OPENAI_API_KEY. The client uses the
// returned client_secret.value as a Bearer token for the WebRTC SDP exchange.
//
// Endpoint: /v1/realtime/client_secrets is the GA path; /v1/realtime/sessions
// is the deprecated beta which rejects gpt-realtime-2 with invalid_model.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY missing in env" }, { status: 500 });
  }
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
      },
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    return NextResponse.json(
      { error: `realtime client_secrets failed: ${r.status} ${text}` },
      { status: r.status }
    );
  }
  const data = await r.json();
  // Normalize shape so the page can read client_secret.value either way.
  const value = data.value || data.client_secret?.value;
  return NextResponse.json({
    client_secret: { value },
    model,
    raw: data,
  });
}
