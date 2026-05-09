import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  getEvents,
  listRuns,
  mediaUrl,
  putEvents,
  renderRun,
  type EventsDoc,
  type RunSummary,
  type TimelineEvent
} from '../lib/api'
import { studio } from '../lib/studio'
import Timeline from '../components/Timeline'

type EventType = 'zoom' | 'click' | 'caption' | 'speed' | 'cut' | 'marker'

function defaultsFor(type: EventType, time: number): TimelineEvent {
  const t = Math.round(time * 10) / 10
  switch (type) {
    case 'zoom':
      return { type, time: t, x: 900, y: 520, scale: 1.45, duration: 1.5, lead: 0.25 }
    case 'click':
      return { type, time: t, x: 900, y: 520, scale: 1.35, duration: 1.4, lead: 0.25, zoom: true }
    case 'caption':
      return { type, time: t, text: 'Caption', duration: 2, position: 'bottom' }
    case 'speed':
      return {
        type,
        time: t,
        start: t,
        end: Math.round((t + 2.5) * 10) / 10,
        factor: 2.5
      }
    case 'cut':
      return { type, time: t, start: t, end: Math.round((t + 1.5) * 10) / 10 }
    case 'marker':
      return { type, time: t, label: 'Marker' }
  }
}

export default function DebugPage() {
  const { runName } = useParams<{ runName?: string }>()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<string | null>(runName || null)
  const [doc, setDoc] = useState<EventsDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(5)
  const [rendering, setRendering] = useState(false)
  const [renderStatus, setRenderStatus] = useState('')
  const [voiceActive, setVoiceActive] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(false)
  const wasMutedBeforeSpace = useRef(false)
  const [voiceLog, setVoiceLog] = useState<string[]>([])
  const [mediaTick, setMediaTick] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    listRuns()
      .then((r) => {
        setRuns(r.runs || [])
        if (!selected && r.runs?.length) setSelected(r.runs[0].name)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    getEvents(selected)
      .then((d) => {
        if (!cancelled) setDoc(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  // M = toggle mute, Hold-Space = push-to-talk (flip mute while held).
  useEffect(() => {
    if (!voiceActive) return
    function onKeyDown(e: KeyboardEvent) {
      const tag = ((e.target as HTMLElement | null)?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.code === 'KeyM' && !e.repeat) {
        e.preventDefault()
        setMicMuted(!voiceMuted)
      } else if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        wasMutedBeforeSpace.current = voiceMuted
        setMicMuted(!voiceMuted)
      }
    }
    function onKeyUp(e: KeyboardEvent) {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      const v = videoRef.current
      if (!v) return
      e.preventDefault()
      v.paused ? v.play().catch(() => {}) : v.pause()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])


  // Tell main which take voice mode should target.
  useEffect(() => {
    studio()?.setEditTarget?.(selected ?? null)
  }, [selected])


  // Subscribe to voice state + log lines.
  useEffect(() => {
    const s = studio()
    if (!s) return
    s.getVoiceState().then((st) => setVoiceActive(!!st.active))
    const offState = s.onListenState((st) => setVoiceActive(!!st.active))
    const offLog = s.onListenLog((line) => {
      setVoiceLog((prev) => [...prev.slice(-50), line])
    })
    return () => {
      offState()
      offLog()
    }
  }, [])

  async function toggleVoice(): Promise<void> {
    const s = studio()
    if (!s) return
    const r = await s.toggleVoice()
    setVoiceActive(!!r.active)
    if (!r.active) setVoiceMuted(false)
  }

  async function setMicMuted(value: boolean): Promise<void> {
    const s = studio()
    if (!s || !voiceActive) return
    setVoiceMuted(value)
    await s.setMuted?.(value)
  }

  const run = runs.find((r) => r.name === selected)
  // mediaTick busts the browser cache after a render so the freshly-written
  // final.mp4 actually displays instead of the stale one at the same URL.
  const cacheBust = mediaTick ? `?t=${mediaTick}` : ''
  const videoSrc = run?.final
    ? mediaUrl(run.name, 'final.mp4') + cacheBust
    : run?.raw
      ? mediaUrl(run.name, 'raw.mov') + cacheBust
      : null

  async function persist(next: EventsDoc): Promise<void> {
    if (!selected) return
    setDoc(next)
    try {
      await putEvents(selected, next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function addEvent(type: EventType): void {
    const event = defaultsFor(type, currentTime)
    const next: EventsDoc = doc
      ? { ...doc, events: [...doc.events, event] }
      : { version: 1, recording: { start_epoch: 0 }, events: [event] }
    next.events.sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
    persist(next)
    if (selected) {
      studio()?.journalEdit?.({
        run_name: selected,
        op: 'add',
        payload: event,
        source: 'manual'
      })
    }
  }
  function updateEvent(index: number, patch: Partial<TimelineEvent>): void {
    if (!doc) return
    const events = [...doc.events]
    const cleanPatch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      cleanPatch[k] = v
    }
    events[index] = { ...events[index], ...cleanPatch }
    events.sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
    persist({ ...doc, events })
    if (selected) {
      studio()?.journalEdit?.({
        run_name: selected,
        op: 'update',
        payload: cleanPatch,
        source: 'manual',
        event_index: index
      })
    }
  }
  function deleteEvent(index: number): void {
    if (!doc) return
    const removed = doc.events[index]
    const events = doc.events.filter((_, i) => i !== index)
    persist({ ...doc, events })
    if (selected) {
      studio()?.journalEdit?.({
        run_name: selected,
        op: 'delete',
        payload: removed,
        source: 'manual',
        event_index: index
      })
    }
  }
  async function handleRender(): Promise<void> {
    if (!selected) return
    setRendering(true)
    setRenderStatus('Rendering…')
    try {
      const result = await renderRun(selected, {
        canvas: '1920x1080',
        crf: 18,
        preset: 'medium',
        background: '#f3f0ea'
      })
      setRenderStatus(`Done: ${result.output.split('/').pop()}`)
      // Refresh runs list so the "rendered" badge appears + bust media cache
      // so the <video> picks up the freshly-written final.mp4 instead of the
      // stale one cached at the same URL.
      const r = await listRuns()
      setRuns(r.runs || [])
      setMediaTick(Date.now())
    } catch (e) {
      setRenderStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRendering(false)
      setTimeout(() => setRenderStatus(''), 4000)
    }
  }

  function seekTo(t: number): void {
    const v = videoRef.current
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      v.currentTime = Math.min(t, v.duration)
    } else {
      setCurrentTime(t)
    }
  }

  return (
    <div className="flex h-screen flex-col bg-soft">
      <header className="flex items-center justify-between border-b border-line bg-white px-5 py-2.5">
        <Link
          to="/"
          className="flex items-center gap-2 text-[14px] font-semibold text-muted transition hover:text-ink"
        >
          ← Home
        </Link>
        <h1 className="text-[15px] font-bold tracking-tight">{selected || 'No take selected'}</h1>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted tabular-nums">{renderStatus}</span>
          <button
            onClick={toggleVoice}
            disabled={!selected || !studio()}
            className={[
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50',
              voiceActive ? 'bg-red-600 hover:bg-red-500' : 'bg-blue hover:opacity-90'
            ].join(' ')}
            title={selected ? 'Talk to edit this take' : 'Select a take first'}
          >
            <span className={voiceActive ? 'animate-pulse' : ''}>●</span>
            {voiceActive ? 'Stop Voice' : 'Voice Edit'}
          </button>
          {voiceActive && (
            <button
              onClick={() => setMicMuted(!voiceMuted)}
              title="Click or press M. Hold Space for push-to-talk."
              className={[
                'inline-flex h-8 items-center gap-1 rounded-md px-3 text-[12px] font-semibold text-white shadow-sm transition',
                voiceMuted
                  ? 'bg-amber-500 hover:bg-amber-400'
                  : 'bg-green hover:opacity-90'
              ].join(' ')}
            >
              <span className={voiceMuted ? '' : 'animate-pulse'}>{voiceMuted ? '🔇' : '🎙'}</span>
              {voiceMuted ? 'Muted' : 'Listening'}
            </button>
          )}
          <button
            onClick={handleRender}
            disabled={!selected || rendering}
            className="h-8 rounded-md bg-green px-4 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {rendering ? 'Rendering…' : 'Render Final'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-line bg-white p-2.5">
          <div className="mb-2 px-1 text-[11px] font-bold uppercase tracking-wider text-muted">
            Takes
          </div>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.name}>
                <button
                  onClick={() => setSelected(r.name)}
                  className={[
                    'w-full rounded-md px-2.5 py-2 text-left text-[12.5px] transition',
                    selected === r.name
                      ? 'bg-blue/10 text-blue ring-1 ring-blue/30'
                      : 'hover:bg-soft'
                  ].join(' ')}
                >
                  <div className="break-all font-semibold leading-tight">{r.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {r.events} marks · {r.final ? 'rendered' : r.raw ? 'raw' : 'empty'}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-[1100px] p-5">
            {error && (
              <div className="mb-4 rounded-lg border border-amber/40 bg-amber/5 p-3 text-sm text-amber">
                {error}
              </div>
            )}
            {voiceLog.length > 0 && (
              <div className="mb-4 rounded-lg border border-line bg-white p-3 text-[12px] text-muted">
                {voiceLog.slice(-4).map((line, index) => (
                  <div key={`${index}-${line}`} className="truncate">
                    {line}
                  </div>
                ))}
              </div>
            )}

            {selected && run ? (
              <>
                <section className="mb-4 overflow-hidden rounded-xl border border-line bg-white">
                  {videoSrc ? (
                    <video
                      ref={videoRef}
                      key={selected}
                      src={videoSrc}
                      controls
                      playsInline
                      className="aspect-video w-full bg-black"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget
                        if (Number.isFinite(v.duration)) setDuration(v.duration)
                      }}
                      onTimeUpdate={(e) => {
                        const t = e.currentTarget.currentTime
                        setCurrentTime(t)
                        studio()?.setPlayhead?.(t)
                      }}
                      onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    />
                  ) : (
                    <div className="flex aspect-video w-full items-center justify-center bg-neutral-900 text-sm text-neutral-400">
                      No video for this take yet
                    </div>
                  )}
                </section>

                <Timeline
                  events={doc?.events || []}
                  duration={duration}
                  currentTime={currentTime}
                  onSeek={seekTo}
                  onAdd={addEvent}
                  onUpdate={updateEvent}
                  onDelete={deleteEvent}
                />
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-line bg-white p-10 text-center text-sm text-muted">
                Select a take from the sidebar.
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
