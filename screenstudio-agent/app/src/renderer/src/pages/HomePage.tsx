import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listRuns, mediaUrl, type RunSummary } from '../lib/api'
import { studio } from '../lib/studio'

function plural(n: number, single: string): string {
  return n === 1 ? `1 ${single}` : `${n} ${single}s`
}

function RunCard({ run }: { run: RunSummary }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const handleEnter = (): void => {
    videoRef.current?.play().catch(() => {})
  }
  const handleLeave = (): void => {
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.currentTime = 0
    }
  }

  const hasVideo = run.final || run.raw
  const src = run.final
    ? mediaUrl(run.name, 'final.mp4')
    : run.raw
      ? mediaUrl(run.name, 'raw.mov')
      : null

  return (
    <Link
      to={`/debug/${encodeURIComponent(run.name)}`}
      className="group block overflow-hidden rounded-xl border border-line bg-white transition hover:-translate-y-0.5 hover:border-neutral-400 hover:shadow-md"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="aspect-video w-full bg-neutral-900">
        {hasVideo && src ? (
          <video
            ref={videoRef}
            src={src}
            muted
            playsInline
            preload="metadata"
            loop
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-neutral-300 to-neutral-500 text-xs font-bold uppercase tracking-wider text-white/85">
            No video yet
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="break-all text-sm font-bold leading-tight">{run.name}</div>
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          <span>{plural(run.events, 'mark')}</span>
          {run.final && (
            <span className="rounded-sm bg-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green">
              Rendered
            </span>
          )}
          {!run.final && run.raw && (
            <span className="rounded-sm bg-amber/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber">
              Raw
            </span>
          )}
        </div>
      </div>
    </Link>
  )
}

export default function HomePage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [voiceActive, setVoiceActive] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const r = await listRuns()
        if (!cancelled) setRuns(r.runs || [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
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
    s.getVoiceState().then((state) => setVoiceActive(!!state.active))
    const off = s.onListenState((state) => setVoiceActive(!!state.active))
    return off
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return
      const v =
        (document.querySelector('.run-card:hover video') as HTMLVideoElement | null) ||
        (document.querySelector('.run-card video') as HTMLVideoElement | null)
      if (!v) return
      e.preventDefault()
      v.paused ? v.play().catch(() => {}) : v.pause()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleVoice = async (): Promise<void> => {
    const s = studio()
    if (!s) return
    const state = await s.toggleVoice()
    setVoiceActive(!!state.active)
  }

  return (
    <div className="min-h-screen bg-soft">
      <header className="flex items-center justify-between border-b border-line bg-white px-7 py-3.5">
        <div className="flex items-center gap-2.5 text-[15px] font-bold tracking-tight">
          <span className="h-6 w-6 rounded-md bg-gradient-to-br from-blue to-green shadow-md" />
          Studio Agent
        </div>
        <Link
          to="/debug"
          className="rounded-md px-3 py-1.5 text-[13px] font-semibold text-muted transition hover:bg-soft hover:text-ink"
        >
          Advanced editor →
        </Link>
      </header>

      <main className="mx-auto max-w-[1100px] px-6 pb-20 pt-14">
        <section className="pb-18 pt-8 text-center">
          <h1 className="mx-auto max-w-3xl text-[38px] font-bold leading-tight tracking-tight">
            Talk and the agent edits your demo.
          </h1>
          <p className="mt-3.5 text-base text-muted">
            Record your screen, say what you want, watch the cuts happen.
          </p>
          <div className="mt-9 inline-flex flex-col items-center gap-4">
            <button
              onClick={handleVoice}
              disabled={!studio()}
              className={[
                'inline-flex h-16 items-center gap-3 rounded-xl px-9 text-[17px] font-bold tracking-wide text-white transition',
                voiceActive
                  ? 'bg-gradient-to-b from-red-600 to-red-800 shadow-[0_8px_24px_rgba(179,38,30,0.35)]'
                  : 'bg-gradient-to-b from-blue to-blue-900 shadow-[0_8px_24px_rgba(40,100,199,0.32)]',
                'hover:-translate-y-0.5 active:translate-y-0',
                'disabled:cursor-not-allowed disabled:opacity-50'
              ].join(' ')}
              style={{ background: voiceActive ? 'linear-gradient(180deg,#b3261e,#8a1a14)' : 'linear-gradient(180deg,#2864c7,#1d51a8)' }}
            >
              <span className={voiceActive ? 'animate-pulse text-xl' : 'text-xl'}>●</span>
              {voiceActive ? 'Stop Voice Mode' : 'Start Voice Mode'}
            </button>
            <p className="text-[13px] text-muted">
              Press <kbd>Space</kbd> to play a take, click one to keep editing.
            </p>
            {!studio() && (
              <p className="text-[12px] text-amber">
                Voice Mode runs in the desktop app — open Studio Agent to use it.
              </p>
            )}
          </div>
        </section>

        <section>
          <header className="mb-4 flex items-baseline justify-between">
            <h2 className="text-[19px] font-bold tracking-tight">Recent takes</h2>
            <span className="text-[13px] text-muted tabular-nums">
              {runs.length === 0 ? '—' : plural(runs.length, 'take')}
            </span>
          </header>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {error ? (
              <div className="col-span-full rounded-xl border border-dashed border-line bg-white p-11 text-center text-sm text-muted">
                Couldn't load runs: {error}
              </div>
            ) : runs.length === 0 ? (
              <div className="col-span-full rounded-xl border border-dashed border-line bg-white p-11 text-center text-sm text-muted">
                No takes yet. Hit <strong className="text-ink">Start Voice Mode</strong> above to record your first one.
              </div>
            ) : (
              runs.map((run) => <RunCard key={run.name} run={run} />)
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
