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
  web_search: { emoji: '🌐', label: 'Search', tint: 'from-sky-500 to-blue-600' }
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
  return ''
}

function plural(n: number, s: string): string {
  return n === 1 ? `1 ${s}` : `${n} ${s}s`
}

let msgSeq = 0
let balloonSeq = 0

export default function HomePage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [balloons, setBalloons] = useState<Balloon[]>([])
  const wasMutedBeforeSpace = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioNextRef = useRef<number>(0)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingModelIdRef = useRef<number | null>(null)

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

      // [heard] = user via Whisper -> right-side blue bubble
      if (text.startsWith('[heard]')) {
        const stripped = text.replace(/^\[heard\]\s*/, '').trim()
        if (!stripped) return
        setChat((prev) => [
          ...prev.slice(-40),
          { id: ++msgSeq, speaker: 'user', text: stripped, ts: Date.now() }
        ])
        return
      }

      // [error] -> centered system chip
      if (text.startsWith('[error]')) {
        const stripped = text.replace(/^\[error\]\s*/, '').trim()
        if (stripped)
          setChat((prev) => [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'system', text: `error: ${stripped}`, ts: Date.now() }
          ])
        return
      }

      // marks (+) -> centered system chip
      if (text.startsWith('+')) {
        const stripped = text.slice(1).trim()
        if (stripped)
          setChat((prev) => [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'system', text: stripped, ts: Date.now() }
          ])
        return
      }

      // FALLBACK for `model: …` info lines: streaming transcript-delta events
      // fill the model bubble in real time. If those didn't fire on this turn
      // the .done log line still arrives — promote it to a final model bubble
      // so the model side never goes silent.
      const mModel = text.match(/^\[info\]\s+model:\s+(.+)$/)
      if (mModel && pendingModelIdRef.current === null) {
        const stripped = mModel[1].trim()
        if (stripped)
          setChat((prev) => [
            ...prev.slice(-40),
            { id: ++msgSeq, speaker: 'model', text: stripped, ts: Date.now() }
          ])
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
      if (e.code === 'KeyM' && !e.repeat) {
        e.preventDefault()
        toggleMute()
      } else if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        wasMutedBeforeSpace.current = voiceMuted
        toggleMute()
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (e.code === 'Space') {
        e.preventDefault()
        setMicMuted(wasMutedBeforeSpace.current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [voiceActive, voiceMuted])

  async function setMicMuted(value: boolean): Promise<void> {
    const s = studio()
    if (!s || !voiceActive) return
    setVoiceMuted(value)
    await s.setMuted?.(value)
  }
  function toggleMute(): void {
    void setMicMuted(!voiceMuted)
  }

  async function handleVoice(): Promise<void> {
    const s = studio()
    if (!s) return
    await s.setEditTarget?.(null)
    const r = await s.toggleVoice()
    setVoiceActive(!!r.active)
  }

  const lastMsg = chat[chat.length - 1]
  const showTyping =
    voiceActive &&
    !!lastMsg &&
    lastMsg.speaker === 'user' &&
    pendingModelIdRef.current === null

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-soft">
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
        @keyframes orbBreath {
          0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239,68,68,0.55), 0 14px 40px -12px rgba(239,68,68,0.55); }
          50% { transform: scale(1.05); box-shadow: 0 0 0 14px rgba(239,68,68,0), 0 14px 40px -8px rgba(239,68,68,0.7); }
        }
        @keyframes ringSpin { to { transform: rotate(360deg); } }
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
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .balloon { animation: balloonRise 2.4s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .msg-user { animation: msgInUser 380ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .msg-model { animation: msgInModel 380ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .orb-active { animation: orbBreath 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        .ring-spin { animation: ringSpin 6s linear infinite; }
        .drawer-in { animation: drawerSlide 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        .scrim-in { animation: scrim 240ms ease-out both; }
        .typing-dot { animation: typingDot 1.2s ease-in-out infinite; }
        .caret-blink { animation: caretBlink 1s step-start infinite; }
        .pending-glow {
          background-image: linear-gradient(110deg, rgba(255,255,255,0) 30%, rgba(99,102,241,0.08) 50%, rgba(255,255,255,0) 70%);
          background-size: 200% 100%;
          animation: shimmer 3s ease-in-out infinite;
        }
        .ease-spring { transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1); }
      `}</style>

      <header className="z-10 flex items-center justify-between border-b border-line bg-white/80 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open takes"
            className="flex h-9 w-9 items-center justify-center rounded-md transition-all duration-200 ease-spring hover:bg-soft hover:scale-105 active:scale-95"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>
          <div className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
            <span className="h-6 w-6 rounded-md bg-gradient-to-br from-blue to-green shadow" />
            Studio Agent
          </div>
        </div>
        <Link
          to="/debug"
          className="rounded-md px-3 py-1.5 text-[13px] font-semibold text-muted transition-all duration-200 ease-spring hover:bg-soft hover:text-ink hover:translate-x-0.5"
        >
          Advanced editor →
        </Link>
      </header>

      <main className="relative flex flex-1 flex-col items-center justify-start px-6 pt-10 pb-10">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
          <div>
            <h1 className="mx-auto max-w-xl text-[36px] font-bold leading-[1.1] tracking-tight">
              {voiceActive ? 'Listening.' : 'Talk and the agent edits your demo.'}
            </h1>
            <p className="mt-3 text-[14px] text-muted">
              {voiceActive
                ? 'Press M to mute · hold Space to push-to-talk · headphones recommended'
                : 'Try “zoom in here”, “cut from five to eight”, or “search the web for Anthropic news”.'}
            </p>
          </div>

          <div className="relative flex flex-col items-center gap-4">
            <div className="pointer-events-none absolute -top-4 left-1/2 z-20 h-1 w-1">
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

            <button
              onClick={handleVoice}
              disabled={!studio()}
              className={[
                'relative inline-flex h-24 w-24 items-center justify-center rounded-full text-white text-2xl shadow-2xl',
                'transition-all duration-300 ease-spring',
                voiceActive ? 'orb-active' : 'hover:-translate-y-1 hover:scale-105 active:scale-95',
                'disabled:cursor-not-allowed disabled:opacity-50'
              ].join(' ')}
              style={{
                background: voiceActive
                  ? 'linear-gradient(180deg,#ef4444,#991b1b)'
                  : 'linear-gradient(180deg,#2864c7,#1d51a8)'
              }}
              title={voiceActive ? 'Stop' : 'Start voice mode'}
            >
              {voiceActive && (
                <span
                  className="ring-spin absolute inset-[-6px] rounded-full opacity-70"
                  style={{
                    background:
                      'conic-gradient(from 0deg, rgba(255,255,255,0) 0deg, rgba(255,255,255,0.6) 80deg, rgba(255,255,255,0) 160deg)',
                    WebkitMask: 'radial-gradient(circle, transparent 56%, black 57%)',
                    mask: 'radial-gradient(circle, transparent 56%, black 57%)'
                  }}
                />
              )}
              <span className="relative z-10">●</span>
            </button>

            <div className="flex items-center gap-2 text-[12px] font-semibold text-muted transition-all duration-300 ease-spring">
              {voiceActive ? (
                <button
                  onClick={() => setMicMuted(!voiceMuted)}
                  className={[
                    'inline-flex h-7 items-center gap-1 rounded-full px-3 text-[11px] font-bold text-white',
                    'transition-all duration-200 ease-spring active:scale-95',
                    voiceMuted ? 'bg-amber-500 hover:bg-amber-400' : 'bg-green hover:opacity-90'
                  ].join(' ')}
                >
                  <span className={voiceMuted ? '' : 'animate-pulse'}>
                    {voiceMuted ? '🔇' : '🎙'}
                  </span>
                  {voiceMuted ? 'Muted' : 'Listening'}
                </button>
              ) : (
                <span>Click the orb to start</span>
              )}
            </div>
            {!studio() && (
              <p className="text-[12px] text-amber">
                Voice mode runs in the desktop app — open Studio Agent to use it.
              </p>
            )}
          </div>

          <div
            className={[
              'w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-white/70 backdrop-blur shadow-sm',
              'transition-all duration-500 ease-spring',
              voiceActive || chat.length > 0
                ? 'opacity-100 translate-y-0 max-h-[440px]'
                : 'opacity-0 translate-y-4 max-h-0 border-transparent'
            ].join(' ')}
          >
            <div className="flex items-baseline justify-between border-b border-line/60 px-4 pt-3 pb-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                Conversation
              </span>
              {chat.length > 0 && (
                <button
                  onClick={() => setChat([])}
                  className="text-[11px] text-muted transition hover:text-ink"
                >
                  Clear
                </button>
              )}
            </div>
            <div
              ref={chatScrollRef}
              className="flex max-h-[360px] flex-col gap-2 overflow-y-auto px-4 py-4 text-left"
            >
              {chat.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-muted">Listening…</p>
              ) : (
                chat.map((m) => {
                  if (m.speaker === 'user') {
                    return (
                      <div key={m.id} className="msg-user flex justify-end">
                        <div
                          className="max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2 text-[13.5px] leading-relaxed text-white shadow-sm"
                          style={{ background: 'linear-gradient(180deg,#3b82f6,#1d4ed8)' }}
                        >
                          {m.text}
                        </div>
                      </div>
                    )
                  }
                  if (m.speaker === 'model') {
                    return (
                      <div key={m.id} className="msg-model flex items-start gap-2 justify-start">
                        <div
                          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow"
                          style={{ background: 'linear-gradient(135deg,#a855f7,#ec4899)' }}
                        >
                          A
                        </div>
                        <div
                          className={[
                            'max-w-[85%] rounded-2xl rounded-tl-md border border-line/70 px-3.5 py-2 text-[13.5px] leading-relaxed text-ink shadow-sm',
                            m.pending ? 'bg-white pending-glow' : 'bg-white'
                          ].join(' ')}
                        >
                          {m.text}
                          {m.pending && (
                            <span className="caret-blink ml-0.5 inline-block w-[2px] align-text-bottom h-[14px] bg-indigo-500" />
                          )}
                        </div>
                      </div>
                    )
                  }
                  return (
                    <div key={m.id} className="msg-model flex justify-center">
                      <div className="rounded-full border border-line/60 bg-white/60 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                        {m.text}
                      </div>
                    </div>
                  )
                })
              )}
              {showTyping && (
                <div className="msg-model flex items-start gap-2">
                  <div
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow"
                    style={{ background: 'linear-gradient(135deg,#a855f7,#ec4899)' }}
                  >
                    A
                  </div>
                  <div className="rounded-2xl rounded-tl-md border border-line/70 bg-white px-4 py-2.5 shadow-sm">
                    <div className="flex items-center gap-1.5">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-neutral-400"
                          style={{ animationDelay: `${i * 160}ms` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {drawerOpen && (
        <div
          className="scrim-in fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 w-[320px] border-r border-line bg-white shadow-2xl',
          'transition-transform duration-300 ease-spring',
          drawerOpen ? 'translate-x-0 drawer-in' : '-translate-x-full'
        ].join(' ')}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-[13px] font-bold tracking-tight">Recent takes</span>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md transition-all duration-200 ease-spring hover:bg-soft hover:rotate-90"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-3" style={{ maxHeight: 'calc(100vh - 56px)' }}>
          <ul className="space-y-2">
            {runs.length === 0 ? (
              <li className="px-2 py-4 text-[12px] text-muted">No takes yet.</li>
            ) : (
              runs.map((r, i) => (
                <li key={r.name} className="msg-model" style={{ animationDelay: `${i * 30}ms` }}>
                  <Link
                    to={`/debug/${encodeURIComponent(r.name)}`}
                    onClick={() => setDrawerOpen(false)}
                    className="block overflow-hidden rounded-lg border border-line bg-white transition-all duration-200 ease-spring hover:border-neutral-400 hover:-translate-y-0.5 hover:shadow-md"
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
                    <div className="p-2">
                      <div className="break-all text-[12.5px] font-bold leading-tight">{r.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                        <span>{plural(r.events, 'mark')}</span>
                        {r.final && (
                          <span className="rounded-sm bg-green/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-green">
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
