import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listRuns, mediaUrl, type RunSummary } from '../lib/api'
import { studio } from '../lib/studio'

type Speaker = 'user' | 'model' | 'system'

interface ChatMsg {
  id: number
  speaker: Speaker
  text: string
  pending?: boolean
  ts: number
  actions?: ChatAction[]
}

interface ChatAction {
  id: number
  tool: string
  emoji: string
  label: string
  detail: string
  meta: string
}

interface Balloon {
  id: number
  tool: string
  emoji: string
  label: string
  detail: string
  x: number
}

const TOOL_LOOKS: Record<string, { emoji: string; label: string; tint: string }> = {
  mark_zoom: { emoji: '🔍', label: 'Zoom', tint: 'from-fuchsia-500 to-purple-600' },
  mark_click: { emoji: '👆', label: 'Click', tint: 'from-cyan-500 to-blue-600' },
  mark_caption: { emoji: '💬', label: 'Caption', tint: 'from-emerald-500 to-teal-600' },
  mark_speed: { emoji: '⚡', label: 'Speed', tint: 'from-orange-500 to-red-600' },
  mark_cut: { emoji: '✂️', label: 'Cut', tint: 'from-rose-500 to-pink-600' },
  mark_marker: { emoji: '📍', label: 'Marker', tint: 'from-yellow-400 to-amber-600' },
  delegate_to_cursor: { emoji: '🤖', label: 'Cursor', tint: 'from-indigo-500 to-violet-600' },
  web_search: { emoji: '🌐', label: 'Search', tint: 'from-sky-500 to-blue-600' },
  health_data_analysis: { emoji: '❤️‍🔥', label: 'Health', tint: 'from-rose-500 to-orange-500' }
}

function lookForTool(name: string): { emoji: string; label: string; tint: string } {
  return TOOL_LOOKS[name] ?? { emoji: '✨', label: name, tint: 'from-neutral-500 to-neutral-700' }
}

function shortDetail(name: string, args: Record<string, unknown>): string {
  if (name === 'mark_caption') return String(args.text || '').slice(0, 40)
  if (name === 'mark_cut') return `${args.start ?? '?'}–${args.end ?? '?'}s`
  if (name === 'mark_speed') return `×${args.factor ?? 2.5}`
  if (name === 'web_search') return String(args.query || '').slice(0, 40)
  if (name === 'delegate_to_cursor') return String(args.task || '').slice(0, 60)
  if (name === 'mark_marker') return String(args.label || '').slice(0, 30)
  if (name === 'health_data_analysis') return String(args.query || '').slice(0, 50)
  return ''
}

function metaForTool(name: string, args: Record<string, unknown>): string {
  if (name === 'mark_zoom') return `${(args.scale as number) ?? 1.4}× · ${(args.duration as number) ?? 1.6}s hold`
  if (name === 'mark_click') return `click · ${(args.scale as number) ?? 1.4}× zoom`
  if (name === 'mark_caption') return `${String(args.position || 'bottom')} · ${(args.duration as number) ?? 2}s`
  if (name === 'mark_speed') {
    const start = args.start as number | undefined
    const end = args.end as number | undefined
    if (start !== undefined && end !== undefined) return `${start}s → ${end}s · ×${(args.factor as number) ?? 2.5}`
    return `last ${(args.seconds_back as number) ?? 6}s · ×${(args.factor as number) ?? 2.5}`
  }
  if (name === 'mark_cut') return 'span removed'
  if (name === 'mark_marker') return 'timeline marker'
  if (name === 'web_search') return 'live web · Exa'
  if (name === 'delegate_to_cursor') return 'composer-2 · async'
  if (name === 'health_data_analysis') {
    const metric = String(args.metric || 'summary')
    const days = (args.days as number) ?? 7
    return `${metric} · last ${days}d`
  }
  return ''
}

function fmtElapsed(ts: number, sessionStart: number): string {
  if (!sessionStart) return ''
  const sec = Math.max(0, Math.floor((ts - sessionStart) / 1000))
  const m = Math.floor(sec / 60).toString().padStart(2, '0')
  const s = (sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}


function plural(n: number, s: string): string {
  return n === 1 ? `1 ${s}` : `${n} ${s}s`
}

const SUGGESTIONS = [
  'Make a 45-second highlight clip with captions and upbeat music',
  'Zoom in here and add a caption that says "open settings"',
  'Cut from second 5 to second 8 and speed up the next 10 seconds',
  'Search the web for the latest ScreenStudio release notes',
  'Render the smoke take and tell me how long it took'
]

let msgSeq = 0
let balloonSeq = 0

function ChatRow({ msg, elapsed }: { msg: ChatMsg; elapsed: string }) {
  const isUser = msg.speaker === 'user'
  const isAgent = msg.speaker === 'model'
  const pillLabel = isUser ? 'You' : isAgent ? 'Agent' : 'System'
  const pillTone = isAgent || isUser
    ? 'bg-emerald-50 text-emerald-700'
    : 'bg-neutral-100 text-neutral-500'
  const animClass = isUser ? 'msg-user' : 'msg-model'
  return (
    <div className={`${animClass} grid grid-cols-[58px_64px_1fr] items-start gap-3 px-1 py-1.5`}>
      <span className="pt-1 text-right font-mono text-[11px] tabular-nums text-neutral-400">
        {elapsed}
      </span>
      <span className={`inline-flex items-center justify-center rounded-md ${pillTone} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider`}>
        {pillLabel}
      </span>
      <div className="flex flex-col gap-2">
        {msg.text && (
          <div className={`text-[14px] leading-relaxed text-neutral-800 ${msg.pending ? 'pending-glow rounded' : ''}`}>
            {msg.text}
            {msg.pending && (
              <span className="caret-blink ml-0.5 inline-block w-[2px] align-text-bottom h-[14px] bg-emerald-500" />
            )}
          </div>
        )}
        {msg.actions && msg.actions.length > 0 && (
          <div className="flex flex-col gap-2">
            {msg.actions.map((a) => (
              <ActionCard key={a.id} action={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ActionCard({ action }: { action: ChatAction }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200/80 bg-white px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-[18px]">
        {action.emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[13px] font-semibold text-neutral-900">
          <span className="text-neutral-500">{action.label}: </span>
          {action.detail || action.label}
        </div>
        {action.meta && (
          <div className="mt-0.5 truncate text-[11.5px] text-neutral-500">
            {action.meta}
          </div>
        )}
      </div>
    </div>
  )
}

export default function HomePage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [balloons, setBalloons] = useState<Balloon[]>([])
  const [audioLevel, setAudioLevel] = useState(0)
  const [tipIdx, setTipIdx] = useState(0)
  const sessionStartedAtRef = useRef<number>(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioNextRef = useRef<number>(0)
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingModelIdRef = useRef<number | null>(null)

  // Rotate suggestion every 6s while idle / listening with no chat yet.
  useEffect(() => {
    const t = setInterval(() => setTipIdx((i) => (i + 1) % SUGGESTIONS.length), 6000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const r = await listRuns()
        if (!cancelled) setRuns(r.runs || [])
      } catch {
        /* ignore */
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    const s = studio()
    if (!s) return
    s.getVoiceState().then((st) => setVoiceActive(!!st.active))
    const offState = s.onListenState((st) => {
      setVoiceActive(!!st.active)
      if (!st.active) setVoiceMuted(false)
    })

    const offLog = s.onListenLog?.((line) => {
      const text = String(line || '')
      if (text.startsWith('[heard]')) {
        const stripped = text.replace(/^\[heard\]\s*/, '').trim()
        if (!stripped) return
        setChat((prev) => [
          ...prev.slice(-40),
          { id: ++msgSeq, speaker: 'user', text: stripped, ts: Date.now() }
        ])
        return
      }
      if (text.startsWith('[error]')) {
        const stripped = text.replace(/^\[error\]\s*/, '').trim()
        if (stripped)
          setChat((prev) => [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'system', text: `error: ${stripped}`, ts: Date.now() }
          ])
        return
      }
      if (text.startsWith('+')) {
        const stripped = text.slice(1).trim()
        if (stripped)
          setChat((prev) => [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'system', text: stripped, ts: Date.now() }
          ])
        return
      }
      const mModel = text.match(/^\[info\]\s+model:\s+([\s\S]+)$/)
      if (mModel) {
        const fullText = mModel[1].trim()
        if (!fullText) return
        setChat((prev) => {
          if (pendingModelIdRef.current !== null) {
            const id = pendingModelIdRef.current
            return prev.map((m) =>
              m.id === id ? { ...m, text: fullText, pending: false } : m
            )
          }
          return [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'model', text: fullText, ts: Date.now() }
          ]
        })
        pendingModelIdRef.current = null
      }
    })

    const offChunk = s.onAudioChunk?.((b64) => {
      if (!audioCtxRef.current) {
        const Ctor =
          (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
            .AudioContext ||
          (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return
        audioCtxRef.current = new Ctor({ sampleRate: 24000 })
      }
      const ctx = audioCtxRef.current
      const bin = atob(b64)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      const i16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2)
      const f32 = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
      const buf = ctx.createBuffer(1, f32.length, 24000)
      buf.copyToChannel(f32, 0)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const startAt = Math.max(ctx.currentTime, audioNextRef.current)
      src.start(startAt)
      audioNextRef.current = startAt + buf.duration
      audioSourcesRef.current.add(src)
      src.onended = () => audioSourcesRef.current.delete(src)
    })

    const offFlush = s.onAudioFlush?.(() => {
      for (const node of audioSourcesRef.current) {
        try { node.stop() } catch { /* ignore */ }
        try { node.disconnect() } catch { /* ignore */ }
      }
      audioSourcesRef.current.clear()
      const ctx = audioCtxRef.current
      audioNextRef.current = ctx ? ctx.currentTime : 0
    })

    // Audio-reactive orb. Smooth raw RMS via exponential moving average
    // so the orb pulses with the voice instead of jittering.
    const offLevel = s.onAudioLevel?.((rms) => {
      // Normalize: typical speech RMS sits around 0.05-0.2; map to 0-1
      const norm = Math.min(1, rms * 6)
      setAudioLevel((prev) => prev * 0.55 + norm * 0.45)
    })

    const offTool = s.onToolFired?.((p) => {
      const look = lookForTool(p.name)
      const id = ++balloonSeq
      const b: Balloon = {
        id,
        tool: p.name,
        emoji: look.emoji,
        label: look.label,
        detail: shortDetail(p.name, p.args || {}),
        x: Math.round((Math.random() - 0.5) * 80)
      }
      setBalloons((prev) => [...prev.slice(-5), b])
      window.setTimeout(() => {
        setBalloons((prev) => prev.filter((x) => x.id !== id))
      }, 2400)

      const action: ChatAction = {
        id,
        tool: p.name,
        emoji: look.emoji,
        label: look.label,
        detail: shortDetail(p.name, p.args || {}),
        meta: metaForTool(p.name, p.args || {})
      }
      setChat((prev) => {
        if (pendingModelIdRef.current !== null) {
          return prev.map((m) =>
            m.id === pendingModelIdRef.current
              ? { ...m, actions: [...(m.actions || []), action] }
              : m
          )
        }
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].speaker === 'model') {
            const next = prev.slice()
            next[i] = { ...prev[i], actions: [...(prev[i].actions || []), action] }
            return next
          }
        }
        return [
          ...prev.slice(-40),
          { id: ++msgSeq, speaker: 'system', text: '', ts: Date.now(), actions: [action] }
        ]
      })
    })

    const offDelta = s.onTranscriptDelta?.(({ role, delta }) => {
      if (role !== 'model' || !delta) return
      setChat((prev) => {
        if (pendingModelIdRef.current !== null) {
          return prev.map((m) =>
            m.id === pendingModelIdRef.current ? { ...m, text: m.text + delta } : m
          )
        }
        const id = ++msgSeq
        pendingModelIdRef.current = id
        return [
          ...prev.slice(-40),
          { id, speaker: 'model', text: delta, pending: true, ts: Date.now() }
        ]
      })
    })

    const offDone = s.onTranscriptDone?.(({ role }) => {
      if (role !== 'model') return
      setChat((prev) =>
        prev.map((m) =>
          pendingModelIdRef.current !== null && m.id === pendingModelIdRef.current
            ? { ...m, pending: false }
            : m
        )
      )
      pendingModelIdRef.current = null
    })

    return () => {
      offState()
      offLog?.()
      offChunk?.()
      offFlush?.()
      offLevel?.()
      offTool?.()
      offDelta?.()
      offDone?.()
      try {
        audioCtxRef.current?.close()
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null
    }
  }, [])

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [chat])

  useEffect(() => {
    if (!voiceActive) return
    function onKeyDown(e: KeyboardEvent): void {
      const tag = ((e.target as HTMLElement | null)?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        startTalking()
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (e.code === 'Space') {
        e.preventDefault()
        stopTalking()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [voiceActive])

  // Begin a push-to-talk turn: cut the model off (audio-flush via direct
  // source kill — same shape as the speech_started flush) and unmute.
  function startTalking(): void {
    const s = studio()
    if (!s || !voiceActive) return
    // Kill any model audio that's currently playing locally so the user
    // doesn't have to wait for it to finish.
    for (const node of audioSourcesRef.current) {
      try { node.stop() } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
    }
    audioSourcesRef.current.clear()
    const ctx = audioCtxRef.current
    audioNextRef.current = ctx ? ctx.currentTime : 0
    setVoiceMuted(false)
    void s.setMuted?.(false)
  }
  // End the turn: re-mute and force the server to commit the input
  // buffer + create a response immediately (skips the silence_duration_ms
  // wait — that was the lag the user was seeing).
  function stopTalking(): void {
    const s = studio()
    if (!s || !voiceActive) return
    setVoiceMuted(true)
    void s.setMuted?.(true)
    void s.commitAudio?.()
  }

  async function handleVoice(): Promise<void> {
    const s = studio()
    if (!s) return
    await s.setEditTarget?.(null)
    const r = await s.toggleVoice()
    setVoiceActive(!!r.active)
    // PTT-first: when the session starts, default the mic to muted so we
    // only transmit while the user is holding Space (or pressing the orb).
    if (r.active) {
      sessionStartedAtRef.current = Date.now()
      setVoiceMuted(true)
      await s.setMuted?.(true)
    }
  }

  // Decay audio level back to 0 when nothing is coming in (PTT released, muted).
  useEffect(() => {
    if (audioLevel === 0) return
    if (!voiceActive || voiceMuted) {
      const t = setTimeout(() => setAudioLevel((v) => v * 0.6), 80)
      return () => clearTimeout(t)
    }
    return undefined
  }, [audioLevel, voiceActive, voiceMuted])

  const lastMsg = chat[chat.length - 1]
  const showTyping =
    voiceActive &&
    !!lastMsg &&
    lastMsg.speaker === 'user' &&
    pendingModelIdRef.current === null

  const talking = voiceActive && !voiceMuted
  const headline = !voiceActive ? 'Ready' : talking ? 'Listening' : 'Hold to talk'
  const subline = !voiceActive
    ? 'Tap the mic to start'
    : talking
      ? "I'm hearing you — release to send"
      : 'Hold the mic or Space · release to send'

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-[#f5f6f7]">
      <style>{`
        @keyframes balloonRise {
          0% { transform: translate(-50%, 30px) scale(0.6); opacity: 0; filter: blur(8px); }
          15% { transform: translate(-50%, 0) scale(1.06); opacity: 1; filter: blur(0); }
          60% { transform: translate(-50%, -120px) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -240px) scale(0.92); opacity: 0; filter: blur(2px); }
        }
        @keyframes msgInUser {
          0% { transform: translateY(10px) scale(0.96); opacity: 0; filter: blur(4px); }
          100% { transform: translateY(0) scale(1); opacity: 1; filter: blur(0); }
        }
        @keyframes msgInModel {
          0% { transform: translate(-6px, 10px) scale(0.96); opacity: 0; filter: blur(4px); }
          100% { transform: translate(0,0) scale(1); opacity: 1; filter: blur(0); }
        }
        @keyframes ripple {
          0% { transform: translate(-50%,-50%) scale(0.7); opacity: 0.55; }
          80% { opacity: 0; }
          100% { transform: translate(-50%,-50%) scale(1.7); opacity: 0; }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.3); }
        }
        @keyframes drawerSlide {
          0% { transform: translateX(-100%); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
        @keyframes scrim { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes typingDot {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
        @keyframes caretBlink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes wave1 { 0%,100% { height: 6px; } 50% { height: 14px; } }
        @keyframes wave2 { 0%,100% { height: 10px; } 50% { height: 4px; } }
        @keyframes wave3 { 0%,100% { height: 4px; } 50% { height: 12px; } }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes fadeUp {
          0% { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .balloon { animation: balloonRise 2.4s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .msg-user { animation: msgInUser 380ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .msg-model { animation: msgInModel 380ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .ripple-1 { animation: ripple 2.2s cubic-bezier(0.22, 1, 0.36, 1) infinite; animation-delay: 0s; }
        .ripple-2 { animation: ripple 2.2s cubic-bezier(0.22, 1, 0.36, 1) infinite; animation-delay: 0.55s; }
        .ripple-3 { animation: ripple 2.2s cubic-bezier(0.22, 1, 0.36, 1) infinite; animation-delay: 1.1s; }
        .pulse-dot { animation: pulseDot 1.6s ease-in-out infinite; }
        .drawer-in { animation: drawerSlide 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .scrim-in { animation: scrim 240ms ease-out both; }
        .typing-dot { animation: typingDot 1.2s ease-in-out infinite; }
        .caret-blink { animation: caretBlink 1s step-start infinite; }
        .wave-bar-1 { animation: wave1 0.9s ease-in-out infinite; }
        .wave-bar-2 { animation: wave2 0.9s ease-in-out infinite; animation-delay: 0.15s; }
        .wave-bar-3 { animation: wave3 0.9s ease-in-out infinite; animation-delay: 0.3s; }
        .pending-glow {
          background-image: linear-gradient(110deg, rgba(255,255,255,0) 30%, rgba(34,197,94,0.10) 50%, rgba(255,255,255,0) 70%);
          background-size: 200% 100%;
          animation: shimmer 3s ease-in-out infinite;
        }
        .fade-up { animation: fadeUp 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .ease-spring { transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }
      `}</style>

      {/* Top bar */}
      <header className="z-10 flex items-center justify-between px-6 py-5">
        <button
          onClick={() => setDrawerOpen(true)}
          className="group flex items-center gap-2.5 rounded-xl border border-neutral-200/80 bg-white/90 px-3 py-2 text-[13px] font-semibold text-neutral-800 shadow-sm transition-all duration-200 ease-spring hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-100">
            {/* Clapperboard icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h16v12H4z" />
              <path d="M4 8l2-4h3l-2 4" />
              <path d="M9 8l2-4h3l-2 4" />
              <path d="M14 8l2-4h3l-2 4" />
            </svg>
          </span>
          <span className="text-neutral-700">Project:</span>
          <span className="font-bold text-neutral-900">
            {runs[0]?.name?.replace(/^take-/, '') || 'New session'}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="text-neutral-500 transition-transform duration-200 group-hover:translate-y-0.5">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <Link
          to="/debug"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-200/80 bg-white/90 text-neutral-700 shadow-sm transition-all duration-200 ease-spring hover:-translate-y-0.5 hover:rotate-45 hover:text-neutral-900 hover:shadow-md"
          title="Advanced editor"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Link>
      </header>

      <main className="relative flex flex-1 flex-col items-center px-6 pt-8 pb-16">
        <div className="flex w-full max-w-[640px] flex-col items-center gap-12 text-center">
          {/* Hero */}
          <div className="fade-up">
            <h1 className="text-[68px] font-bold leading-[1.0] tracking-[-0.04em] text-neutral-900">
              {headline}
              <span className={`text-emerald-500 ${voiceActive ? 'pulse-dot inline-block' : ''}`}>.</span>
            </h1>
            <p className="mt-4 text-[15px] text-neutral-500">{subline}</p>
          </div>

          {/* Mic + ripples */}
          <div className="relative flex flex-col items-center gap-7">
            {/* Tool balloons float up from above the mic */}
            <div className="pointer-events-none absolute -top-6 left-1/2 z-30 h-1 w-1">
              {balloons.map((b) => (
                <div
                  key={b.id}
                  className="balloon absolute"
                  style={{ left: `${b.x}px`, top: 0 }}
                >
                  <div
                    className={[
                      'pointer-events-none flex items-center gap-2 rounded-full bg-gradient-to-br',
                      lookForTool(b.tool).tint,
                      'px-3.5 py-1.5 text-white whitespace-nowrap'
                    ].join(' ')}
                    style={{ boxShadow: '0 12px 30px -8px rgba(0,0,0,0.35)' }}
                  >
                    <span className="text-[16px] leading-none">{b.emoji}</span>
                    <span className="text-[12.5px] font-bold tracking-tight">{b.label}</span>
                    {b.detail && (
                      <span className="text-[11px] opacity-90 max-w-[180px] truncate">
                        {b.detail}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Ripple container */}
            <div className="relative flex items-center justify-center" style={{ width: 280, height: 280 }}>
              {voiceActive && !voiceMuted && (
                <>
                  <span
                    className="ripple-1 absolute left-1/2 top-1/2 rounded-full"
                    style={{
                      width: 180 + audioLevel * 80,
                      height: 180 + audioLevel * 80,
                      background: `radial-gradient(circle, rgba(34,197,94,${0.18 + audioLevel * 0.2}) 30%, rgba(34,197,94,0) 70%)`,
                      transition: 'width 80ms ease-out, height 80ms ease-out'
                    }}
                  />
                  <span
                    className="ripple-2 absolute left-1/2 top-1/2 rounded-full"
                    style={{
                      width: 180 + audioLevel * 60,
                      height: 180 + audioLevel * 60,
                      background: `radial-gradient(circle, rgba(34,197,94,${0.14 + audioLevel * 0.16}) 30%, rgba(34,197,94,0) 70%)`,
                      transition: 'width 80ms ease-out, height 80ms ease-out'
                    }}
                  />
                  <span
                    className="ripple-3 absolute left-1/2 top-1/2 h-[180px] w-[180px] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(34,197,94,0.10) 30%, rgba(34,197,94,0) 70%)' }}
                  />
                </>
              )}

              {/* The mic button */}
              <button
                onClick={voiceActive ? undefined : handleVoice}
                onMouseDown={voiceActive ? () => startTalking() : undefined}
                onMouseUp={voiceActive ? () => stopTalking() : undefined}
                onMouseLeave={voiceActive && !voiceMuted ? () => stopTalking() : undefined}
                onTouchStart={voiceActive ? (e) => { e.preventDefault(); startTalking() } : undefined}
                onTouchEnd={voiceActive ? (e) => { e.preventDefault(); stopTalking() } : undefined}
                onContextMenu={(e) => e.preventDefault()}
                disabled={!studio()}
                className={[
                  'relative inline-flex h-[136px] w-[136px] items-center justify-center rounded-full text-white shadow-2xl',
                  'transition-all duration-300 ease-spring select-none',
                  voiceActive && !voiceMuted ? '' : 'hover:-translate-y-1 hover:scale-[1.02] active:scale-[0.97]',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                ].join(' ')}
                style={{
                  background: voiceActive && !voiceMuted
                    ? 'radial-gradient(circle at 35% 25%, #34d399 0%, #16a34a 55%, #15803d 100%)'
                    : voiceActive
                      ? 'radial-gradient(circle at 35% 25%, #86efac 0%, #22c55e 55%, #16a34a 100%)'
                      : 'radial-gradient(circle at 35% 25%, #d4d4d8 0%, #71717a 55%, #52525b 100%)',
                  boxShadow: voiceActive && !voiceMuted
                    ? `0 ${18 + audioLevel * 30}px ${50 + audioLevel * 60}px -12px rgba(34,197,94,${0.45 + audioLevel * 0.4}), inset 0 -10px 20px rgba(0,0,0,0.15)`
                    : '0 12px 32px -10px rgba(0,0,0,0.35), inset 0 -10px 20px rgba(0,0,0,0.15)',
                  transform: voiceActive && !voiceMuted ? `scale(${1.05 + audioLevel * 0.18})` : undefined,
                  transition: 'transform 90ms ease-out, box-shadow 120ms ease-out'
                }}
                title={voiceActive ? 'Stop' : 'Start voice mode'}
                aria-label={voiceActive ? 'Stop voice mode' : 'Start voice mode'}
              >
                {/* Mic icon (or muted slash) */}
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="13" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                </svg>
              </button>
            </div>

            {/* Status pill (also acts as PTT trigger via mouse hold + as stop button on dblclick) */}
            <button
              onMouseDown={voiceActive ? () => startTalking() : undefined}
              onMouseUp={voiceActive ? () => stopTalking() : undefined}
              onMouseLeave={voiceActive && !voiceMuted ? () => stopTalking() : undefined}
              onClick={voiceActive ? undefined : handleVoice}
              onDoubleClick={voiceActive ? handleVoice : undefined}
              disabled={!studio()}
              title={voiceActive ? 'Hold to talk · double-click to end session' : 'Tap to start'}
              className={[
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-semibold',
                'transition-all duration-200 ease-spring active:scale-95',
                voiceActive && !voiceMuted
                  ? 'border-emerald-300 bg-white text-emerald-600 hover:border-emerald-400'
                  : voiceMuted
                    ? 'border-amber-300 bg-white text-amber-600 hover:border-amber-400'
                    : 'border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400',
                'disabled:cursor-not-allowed disabled:opacity-50'
              ].join(' ')}
            >
              {/* Wave-form icon */}
              {voiceActive && !voiceMuted ? (
                <span className="flex items-end gap-[2px] h-4">
                  <span className="wave-bar-1 inline-block w-[3px] rounded-sm bg-emerald-500" />
                  <span className="wave-bar-2 inline-block w-[3px] rounded-sm bg-emerald-500" />
                  <span className="wave-bar-3 inline-block w-[3px] rounded-sm bg-emerald-500" />
                  <span className="wave-bar-1 inline-block w-[3px] rounded-sm bg-emerald-500" />
                </span>
              ) : voiceActive ? (
                <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
              ) : (
                <span className="flex h-2 w-2 rounded-full bg-neutral-400" />
              )}
              {!voiceActive ? 'Tap to start' : voiceMuted ? 'Hold to talk' : 'Listening'}
            </button>
          </div>

          {/* Suggestion / conversation */}
          {chat.length === 0 && !showTyping ? (
            <button
              onClick={() => setTipIdx((i) => (i + 1) % SUGGESTIONS.length)}
              className="fade-up group flex w-full max-w-xl items-center justify-between gap-4 rounded-2xl border border-neutral-200/80 bg-white px-5 py-4 text-left shadow-sm transition-all duration-300 ease-spring hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-500">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l1.5 5L18 8l-4 3 1.4 5L12 13.5 8.6 16 10 11l-4-3 4.5-1z" />
                  </svg>
                </span>
                <div>
                  <div className="text-[12px] font-bold uppercase tracking-wider text-neutral-500">
                    Try saying something like:
                  </div>
                  <div key={tipIdx} className="fade-up mt-1 text-[14px] font-medium text-neutral-800">
                    “{SUGGESTIONS[tipIdx]}”
                  </div>
                </div>
              </div>
              <span className="text-neutral-400 transition-transform duration-200 group-hover:translate-x-0.5">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </button>
          ) : (
            <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm fade-up">
              <div className="flex items-baseline justify-between border-b border-neutral-100 px-5 pt-3 pb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">
                  Conversation
                </span>
                <button
                  onClick={() => setChat([])}
                  className="text-[11px] text-neutral-500 transition hover:text-neutral-800"
                >
                  Clear
                </button>
              </div>
              <div
                ref={chatScrollRef}
                className="flex max-h-[320px] flex-col gap-2 overflow-y-auto px-4 py-4 text-left"
              >
                {chat.map((m) => (
                  <ChatRow
                    key={m.id}
                    msg={m}
                    elapsed={fmtElapsed(m.ts, sessionStartedAtRef.current)}
                  />
                ))}
                {showTyping && (
                  <div className="msg-model grid grid-cols-[58px_64px_1fr] items-start gap-3 px-1 py-1">
                    <span className="pt-1 text-right font-mono text-[11px] text-neutral-400" />
                    <span className="inline-flex items-center justify-center rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                      Agent
                    </span>
                    <div className="flex items-center gap-1.5 pt-1">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-neutral-400"
                          style={{ animationDelay: `${i * 160}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {voiceActive && (
            <p className="text-[11.5px] text-neutral-400">
              Hold <kbd className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-neutral-600">Space</kbd> or the mic to talk · double-click pill to end session
            </p>
          )}
          {!studio() && (
            <p className="text-[12px] text-amber-600">
              Voice mode runs in the desktop app — open Studio Agent to use it.
            </p>
          )}
        </div>
      </main>

      {/* Drawer */}
      {drawerOpen && (
        <div
          className="scrim-in fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 w-[340px] border-r border-neutral-200 bg-white shadow-2xl',
          'transition-transform duration-300 ease-spring',
          drawerOpen ? 'translate-x-0 drawer-in' : '-translate-x-full'
        ].join(' ')}
      >
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-4">
          <span className="text-[14px] font-bold tracking-tight text-neutral-900">Recent takes</span>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-all duration-200 ease-spring hover:bg-neutral-100 hover:rotate-90"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-3" style={{ maxHeight: 'calc(100vh - 64px)' }}>
          <ul className="space-y-2">
            {runs.length === 0 ? (
              <li className="px-2 py-4 text-[12px] text-neutral-500">No takes yet.</li>
            ) : (
              runs.map((r, i) => (
                <li key={r.name} className="msg-model" style={{ animationDelay: `${i * 30}ms` }}>
                  <Link
                    to={`/debug/${encodeURIComponent(r.name)}`}
                    onClick={() => setDrawerOpen(false)}
                    className="block overflow-hidden rounded-xl border border-neutral-200 bg-white transition-all duration-200 ease-spring hover:border-neutral-300 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <div className="aspect-video w-full bg-neutral-900">
                      {r.final ? (
                        <video
                          src={mediaUrl(r.name, 'final.mp4')}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-neutral-300 to-neutral-500 text-[10px] font-bold uppercase tracking-wider text-white/85">
                          {r.raw ? 'Raw only' : 'Empty'}
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <div className="break-all text-[12.5px] font-bold leading-tight text-neutral-900">{r.name}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
                        <span>{plural(r.events, 'mark')}</span>
                        {r.final && (
                          <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                            Rendered
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </div>
      </aside>
    </div>
  )
}
