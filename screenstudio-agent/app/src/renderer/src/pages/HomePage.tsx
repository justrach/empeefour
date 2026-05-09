import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listRuns, mediaUrl, type RunSummary } from '../lib/api'
import { studio } from '../lib/studio'

type LogKind = 'info' | 'heard' | 'mark' | 'error'
interface LogLine {
  kind: LogKind
  text: string
  ts: number
}

function plural(n: number, s: string): string {
  return n === 1 ? `1 ${s}` : `${n} ${s}s`
}

function dotColor(k: LogKind): string {
  return {
    info: 'bg-neutral-400',
    heard: 'bg-blue-500',
    mark: 'bg-emerald-500',
    error: 'bg-red-500'
  }[k]
}

export default function HomePage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [log, setLog] = useState<LogLine[]>([])
  const wasMutedBeforeSpace = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const audioNextRef = useRef<number>(0)

  // Recent takes for the drawer.
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

  // Voice state + log + audio chunks.
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
      let kind: LogKind = 'info'
      if (text.startsWith('[heard]')) kind = 'heard'
      else if (text.startsWith('+')) kind = 'mark'
      else if (text.startsWith('[error]')) kind = 'error'
      const stripped = text.replace(/^(\[(?:heard|info|error)\]|\+)\s*/, '').trim()
      if (stripped) setLog((prev) => [...prev.slice(-100), { kind, text: stripped, ts: Date.now() }])
    })
    const offChunk = s.onAudioChunk?.((b64) => {
      if (!audioCtxRef.current) {
        const Ctor =
          (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
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
    return () => {
      offState()
      offLog?.()
      offChunk?.()
      try {
        audioCtxRef.current?.close()
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null
    }
  }, [])

  // Keyboard: M = toggle mute, Space (held) = push-to-talk flip.
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
    // Home doesn't bind a take — main will fall back to live recording mode.
    await s.setEditTarget?.(null)
    const r = await s.toggleVoice()
    setVoiceActive(!!r.active)
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-soft">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-line bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open takes"
            className="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-soft"
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
          className="rounded-md px-3 py-1.5 text-[13px] font-semibold text-muted transition hover:bg-soft hover:text-ink"
        >
          Advanced editor →
        </Link>
      </header>

      {/* Hero / voice area */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 pt-2 pb-10">
        <div className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
          <div>
            <h1 className="mx-auto max-w-xl text-[40px] font-bold leading-[1.1] tracking-tight">
              Talk and the agent edits your demo.
            </h1>
            <p className="mt-3 text-[15px] text-muted">
              Hit the button, say what you want.
              {' '}
              <span className="hidden sm:inline">
                Try “zoom in here”, “cut from five to eight”, “caption this as opening settings”.
              </span>
            </p>
          </div>

          <div className="flex flex-col items-center gap-4">
            <button
              onClick={handleVoice}
              disabled={!studio()}
              className={[
                'inline-flex h-20 w-20 items-center justify-center rounded-full text-white text-2xl shadow-2xl transition',
                voiceActive
                  ? 'animate-pulse bg-gradient-to-b from-red-500 to-red-700 shadow-red-500/40 ring-4 ring-red-500/20'
                  : 'bg-gradient-to-b from-blue to-blue-900 shadow-blue-500/30 hover:-translate-y-0.5 hover:shadow-blue-500/40',
                'disabled:cursor-not-allowed disabled:opacity-50'
              ].join(' ')}
              style={{
                background: voiceActive
                  ? 'linear-gradient(180deg,#ef4444,#991b1b)'
                  : 'linear-gradient(180deg,#2864c7,#1d51a8)'
              }}
              title={voiceActive ? 'Stop' : 'Start voice mode'}
            >
              ●
            </button>
            <div className="flex items-center gap-2 text-[12px] font-semibold text-muted">
              {voiceActive ? (
                <>
                  <button
                    onClick={() => setMicMuted(!voiceMuted)}
                    className={[
                      'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-bold text-white transition',
                      voiceMuted ? 'bg-amber-500 hover:bg-amber-400' : 'bg-green hover:opacity-90'
                    ].join(' ')}
                  >
                    <span className={voiceMuted ? '' : 'animate-pulse'}>{voiceMuted ? '🔇' : '🎙'}</span>
                    {voiceMuted ? 'Muted' : 'Listening'}
                  </button>
                  <span>·</span>
                  <span>
                    Press <kbd>M</kbd> to mute · hold <kbd>Space</kbd>
                  </span>
                </>
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

          {/* Live transcript stream */}
          {(voiceActive || log.length > 0) && (
            <div className="w-full max-w-xl rounded-xl border border-line bg-white p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                  Conversation
                </span>
                <button
                  onClick={() => setLog([])}
                  className="text-[11px] text-muted transition hover:text-ink"
                >
                  Clear
                </button>
              </div>
              {log.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-muted">
                  Listening…
                </p>
              ) : (
                <ul className="max-h-[260px] space-y-1.5 overflow-y-auto text-[12.5px]">
                  {log.map((l, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor(l.kind)}`} />
                      <span className="flex-1 break-words text-left text-ink">{l.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Slide-in drawer with Recent Takes */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-50 w-[320px] transform border-r border-line bg-white shadow-2xl transition-transform',
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        ].join(' ')}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-[13px] font-bold tracking-tight">Recent takes</span>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-soft"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-3" style={{ maxHeight: 'calc(100vh - 56px)' }}>
          <ul className="space-y-2">
            {runs.length === 0 ? (
              <li className="px-2 py-4 text-[12px] text-muted">No takes yet.</li>
            ) : (
              runs.map((r) => (
                <li key={r.name}>
                  <Link
                    to={`/debug/${encodeURIComponent(r.name)}`}
                    onClick={() => setDrawerOpen(false)}
                    className="block overflow-hidden rounded-lg border border-line bg-white transition hover:border-neutral-400"
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
