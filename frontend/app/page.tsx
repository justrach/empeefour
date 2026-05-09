"use client";

// Pure voice-agent test harness. Mic → OpenAI Realtime over WebRTC,
// registers the same mark_* tools as the Electron app, logs everything.
// Does NOT write events.json or touch Electron — log-only.

import { useEffect, useRef, useState } from "react";

type LogKind = "info" | "heard" | "mark" | "model" | "error";
interface LogLine {
  kind: LogKind;
  text: string;
  ts: number;
}

const TOOLS = [
  {
    type: "function",
    name: "mark_zoom",
    description: "Zoom in on a moment in time. 'zoom in here' / 'zoom on second 12'.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number" },
        label: { type: "string" },
        scale: { type: "number" },
        duration: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "mark_click",
    description: "Mark a click moment with zoom emphasis. 'click this'.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number" },
        label: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "mark_caption",
    description: "Add an on-screen caption. 'caption this as Open settings'.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        time: { type: "number" },
        duration: { type: "number" },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "mark_speed",
    description: "Speed up a span. 'speed from 4 to 9' or 'speed this up'.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "number" },
        end: { type: "number" },
        factor: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "mark_cut",
    description: "Remove a span entirely. 'cut from 5 to 8'.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "number" },
        end: { type: "number" },
      },
      required: ["start", "end"],
    },
  },
  {
    type: "function",
    name: "mark_marker",
    description: "Drop a generic timeline marker. 'mark this'.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        time: { type: "number" },
      },
      required: ["label"],
    },
  },
];

const SYSTEM = [
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
].join("\n");

export default function VoiceTester() {
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const wasMutedBeforeSpaceRef = useRef(false);

  function setMicMuted(value: boolean) {
    micStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !value));
    setMuted(value);
  }
  function append(kind: LogKind, text: string) {
    setLog((prev) => [...prev.slice(-150), { kind, text, ts: Date.now() }]);
  }

  async function start() {
    if (active) return;
    setBusy("Connecting…");
    try {
      const sessionRes = await fetch("/api/session", { method: "POST" });
      const sessionText = await sessionRes.text();
      let session: { client_secret?: { value?: string }; model?: string; error?: string } = {};
      try {
        if (sessionText) session = JSON.parse(sessionText);
      } catch {
        /* not JSON */
      }
      if (!sessionRes.ok || !session.client_secret?.value) {
        throw new Error(
          session.error ||
            `session route failed (${sessionRes.status}): ${sessionText.slice(0, 200) || "empty body"}`
        );
      }
      const ephemeral = session.client_secret.value;
      const model = session.model || "gpt-realtime-2";

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audio = audioElRef.current!;
      pc.ontrack = (e) => {
        if (e.streams[0]) audio.srcObject = e.streams[0];
      };

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = mic;
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("open", () => {
        dc.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              output_modalities: ["audio"],
              instructions: SYSTEM,
              tools: TOOLS,
              tool_choice: "auto",
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: 24000 },
                  transcription: { model: "whisper-1" },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.7,
                    silence_duration_ms: 800,
                    create_response: true,
                    interrupt_response: true,
                  },
                },
                output: {
                  voice: "alloy",
                  format: { type: "audio/pcm", rate: 24000 },
                },
              },
            },
          })
        );
        append("info", "session.update sent — talk now");
      });
      dc.addEventListener("message", (e) => handleServerEvent(e.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // GA endpoint: /v1/realtime/calls (the beta /v1/realtime rejects GA secrets).
      const sdpRes = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ephemeral}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
        }
      );
      if (!sdpRes.ok) {
        const t = await sdpRes.text();
        throw new Error(`SDP exchange failed: ${sdpRes.status} ${t.slice(0, 250)}`);
      }
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setActive(true);
      setBusy(null);
      append("info", `connected to ${model}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append("error", msg);
      setBusy(null);
      stop();
    }
  }

  function stop() {
    setActive(false);
    setBusy(null);
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current = null;
    dcRef.current = null;
    micStreamRef.current = null;
    append("info", "stopped");
  }

  function handleServerEvent(raw: string) {
    let evt: { type?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const type = evt.type || "";
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String((evt as { transcript?: string }).transcript || "").trim();
      if (text) append("heard", text);
    } else if (
      type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done"
    ) {
      const text = String((evt as { transcript?: string }).transcript || "").trim();
      if (text) append("model", text);
    } else if (type === "response.function_call_arguments.done") {
      const name = (evt as { name?: string }).name || "?";
      const args = (evt as { arguments?: string }).arguments || "{}";
      append("mark", `${name}(${args})`);
    } else if (type === "error") {
      const message =
        ((evt as { error?: { message?: string } }).error?.message as string) ||
        JSON.stringify(evt);
      append("error", message);
    }
  }

  useEffect(() => () => stop(), []);

  // Keyboard: M toggles mute, hold Space = push-to-talk (momentary unmute
  // when starting from muted; momentary mute when starting from unmuted).
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.code === "KeyM" && !e.repeat) {
        e.preventDefault();
        setMicMuted(!muted);
      } else if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        wasMutedBeforeSpaceRef.current = muted;
        setMicMuted(!muted); // flip
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        e.preventDefault();
        // Restore pre-Space state on release.
        setMicMuted(wasMutedBeforeSpaceRef.current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [active, muted]);

  function dotColor(k: LogKind) {
    return {
      info: "bg-zinc-400",
      heard: "bg-blue-500",
      mark: "bg-emerald-500",
      model: "bg-amber-500",
      error: "bg-red-500",
    }[k];
  }

  return (
    <main className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
          <span className="h-6 w-6 rounded-md bg-gradient-to-br from-blue-600 to-emerald-600 shadow" />
          Voice Agent Tester
        </div>
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          browser-native · webrtc · log-only
        </span>
      </header>

      <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Talk to test the agent.</h1>
          <p className="max-w-md text-sm text-zinc-500">
            Click start, allow mic. Try saying <em>“zoom in here”</em>,{" "}
            <em>“cut from five to eight”</em>, or{" "}
            <em>“caption this as opening settings”</em>. Tool calls appear below.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={active ? stop : start}
              disabled={!!busy}
              className={[
                "inline-flex h-14 items-center gap-3 rounded-xl px-8 text-base font-bold text-white shadow-lg transition",
                active
                  ? "bg-gradient-to-b from-red-500 to-red-700 shadow-red-500/30"
                  : "bg-gradient-to-b from-blue-600 to-blue-800 shadow-blue-500/30",
                "hover:-translate-y-0.5 active:translate-y-0",
                "disabled:cursor-not-allowed disabled:opacity-60",
              ].join(" ")}
            >
              <span className={active ? "animate-pulse text-lg" : "text-lg"}>●</span>
              {busy ?? (active ? "Stop voice mode" : "Start voice mode")}
            </button>
            {active && (
              <button
                onClick={() => setMicMuted(!muted)}
                className={[
                  "inline-flex h-12 items-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition",
                  muted
                    ? "bg-amber-500 text-white shadow-amber-500/30 hover:bg-amber-400"
                    : "bg-emerald-600 text-white shadow-emerald-500/30 hover:bg-emerald-500",
                ].join(" ")}
                title="Click or press M"
              >
                <span className={muted ? "" : "animate-pulse"}>
                  {muted ? "🔇" : "🎙"}
                </span>
                {muted ? "Muted" : "Listening"}
              </button>
            )}
          </div>
          <p className="text-[11px] text-zinc-500">
            {active ? (
              <>
                Press <kbd className="rounded border border-zinc-300 bg-white px-1 text-[10px] font-mono">M</kbd> to mute,
                hold <kbd className="rounded border border-zinc-300 bg-white px-1 text-[10px] font-mono">Space</kbd> for
                push-to-talk. Wear headphones to avoid feedback.
              </>
            ) : (
              <>Wear headphones — speakers feed the agent's voice back into the mic.</>
            )}
          </p>
        </div>

        <div className="flex flex-1 flex-col rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-baseline justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            <h2 className="text-[13px] font-bold tracking-tight">Event log</h2>
            <span className="text-[11px] text-zinc-500">
              {log.length} entr{log.length === 1 ? "y" : "ies"}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed">
            {log.length === 0 ? (
              <p className="px-2 text-[12px] font-sans text-zinc-500">
                Nothing yet. Start voice mode and talk.
              </p>
            ) : (
              <ul className="space-y-1">
                {log.map((l, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${dotColor(l.kind)}`}
                    />
                    <span className="w-12 shrink-0 text-zinc-500">{l.kind}</span>
                    <span className="flex-1 break-words text-zinc-800 dark:text-zinc-200">
                      {l.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <audio ref={audioElRef} autoPlay className="hidden" />
    </main>
  );
}
