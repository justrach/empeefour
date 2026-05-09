// Multi-track timeline with draggable playhead, chip drag-to-retime,
// quick-add toolbar, click-to-edit per row. Tailwind-styled.

import { useRef, useState } from 'react'
import type { TimelineEvent } from '../lib/api'

type EventType = 'zoom' | 'click' | 'caption' | 'speed' | 'cut' | 'marker'

const TYPE_BG: Record<string, string> = {
  zoom: '#2864c7',
  click: '#155cb5',
  caption: '#087f5b',
  speed: '#a35d00',
  cut: '#b3261e',
  marker: '#6c757d'
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const totalSec = Math.floor(seconds)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function pickTickStep(duration: number): number {
  if (duration <= 6) return 1
  if (duration <= 15) return 2
  if (duration <= 40) return 5
  if (duration <= 90) return 10
  return 30
}

function eventEnd(e: TimelineEvent): number {
  const t = Number(e.time || 0)
  if (e.type === 'speed' || e.type === 'cut') return Number(e.end ?? e.start ?? t)
  if (e.type === 'caption' || e.type === 'zoom' || e.type === 'click')
    return t + Number(e.duration || 0)
  return t + 0.2
}

function laneFor(e: TimelineEvent): 'caption' | 'mark' | 'span' {
  if (e.type === 'caption') return 'caption'
  if (e.type === 'speed' || e.type === 'cut') return 'span'
  return 'mark'
}

function chipText(e: TimelineEvent): string {
  if (e.type === 'caption') return (e.text as string) || 'caption'
  if (e.type === 'speed') return `${Number(e.factor || 1).toFixed(1)}x`
  if (e.type === 'cut') return 'cut'
  if (e.label) return e.label as string
  return e.type || 'event'
}

interface TimelineProps {
  events: TimelineEvent[]
  duration: number
  currentTime: number
  onSeek: (t: number) => void
  onAdd: (type: EventType) => void
  onUpdate: (index: number, patch: Partial<TimelineEvent>) => void
  onDelete: (index: number) => void
}

export default function Timeline({
  events,
  duration,
  currentTime,
  onSeek,
  onAdd,
  onUpdate,
  onDelete
}: TimelineProps) {
  const tracksRef = useRef<HTMLDivElement | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [dragTime, setDragTime] = useState<{ index: number; time: number } | null>(null)

  const step = pickTickStep(duration)
  const ticks: number[] = []
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(t)

  // ----- scrub (click + drag empty area + handle) -----
  function ratioFromClient(clientX: number): number {
    const r = tracksRef.current?.getBoundingClientRect()
    if (!r) return 0
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  function handleStripPointerDown(e: React.PointerEvent): void {
    if ((e.target as HTMLElement).closest('.chip')) return
    setScrubbing(true)
    tracksRef.current?.setPointerCapture(e.pointerId)
    onSeek(ratioFromClient(e.clientX) * duration)
  }
  function handleStripPointerMove(e: React.PointerEvent): void {
    if (!scrubbing) return
    onSeek(ratioFromClient(e.clientX) * duration)
  }
  function handleStripPointerUp(e: React.PointerEvent): void {
    if (!scrubbing) return
    setScrubbing(false)
    try {
      tracksRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  // ----- chip drag (retime) -----
  function startChipDrag(e: React.PointerEvent, index: number): void {
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    const startX = e.clientX
    const event = events[index]
    const isSpan =
      event.type === 'speed' || event.type === 'cut' || (event.duration && event.type === 'caption')
    const span = isSpan
      ? Math.max(
          0.05,
          (Number(event.end) || Number(event.start || 0) + Number(event.duration || 0.5)) -
            Number(event.start ?? event.time ?? 0)
        )
      : 0
    const originalTime = Number(event.time ?? event.start ?? 0)
    let dragging = false
    let lastTime = originalTime

    function onMove(ev: PointerEvent): void {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) > 5) dragging = true
      if (!dragging) return
      let t = ratioFromClient(ev.clientX) * duration
      t = Math.round(t * 10) / 10
      const maxStart = isSpan ? Math.max(0, duration - span) : duration
      t = Math.max(0, Math.min(maxStart, t))
      lastTime = t
      setDragTime({ index, time: t })
    }
    function onUp(ev: PointerEvent): void {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      try {
        target.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      setDragTime(null)
      if (!dragging) {
        setEditingIndex(index)
        return
      }
      if (isSpan) {
        onUpdate(index, {
          start: lastTime,
          end: Math.round((lastTime + span) * 1000) / 1000,
          time: lastTime
        })
      } else {
        onUpdate(index, { time: lastTime })
      }
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }

  function chipPosition(e: TimelineEvent, index: number): { left: string; width?: string } {
    const start =
      dragTime?.index === index ? dragTime.time : Number(e.time ?? e.start ?? 0)
    const end =
      dragTime?.index === index
        ? dragTime.time +
          (e.type === 'speed' || e.type === 'cut'
            ? Number(e.end ?? 0) - Number(e.start ?? 0)
            : Number(e.duration || 0))
        : eventEnd(e)
    const isSpan = e.type === 'speed' || e.type === 'cut' || (e.duration && e.type === 'caption')
    const left = `${(start / duration) * 100}%`
    if (isSpan) {
      const w = Math.max(((end - start) / duration) * 100, 1.5)
      return { left, width: `${w}%` }
    }
    return { left }
  }

  const cursorLeft = `${Math.max(0, Math.min(1, currentTime / duration)) * 100}%`

  const lanes: Array<{ id: 'caption' | 'mark' | 'span'; label: string; icon: string }> = [
    { id: 'caption', label: 'Captions', icon: 'T' },
    { id: 'mark', label: 'Marks', icon: '●' },
    { id: 'span', label: 'Spans', icon: '»' }
  ]

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-gradient-to-b from-neutral-50 to-neutral-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-soft px-3 py-1.5">
        <span className="mr-1.5 text-[10px] font-bold uppercase tracking-wider text-muted">
          Add at playhead
        </span>
        {(
          [
            { type: 'zoom', label: 'Zoom', icon: '+' },
            { type: 'click', label: 'Click', icon: '●' },
            { type: 'caption', label: 'Caption', icon: 'T' },
            { type: 'speed', label: 'Speed', icon: '»' },
            { type: 'cut', label: 'Cut', icon: '✕' },
            { type: 'marker', label: 'Mark', icon: '▼' }
          ] as Array<{ type: EventType; label: string; icon: string }>
        ).map((b) => (
          <button
            key={b.type}
            onClick={() => onAdd(b.type)}
            className="flex h-[26px] items-center gap-1.5 rounded border border-line bg-white px-2 text-[11px] font-semibold transition hover:-translate-y-px hover:border-blue active:translate-y-0"
          >
            <span
              className="flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[9px] font-bold leading-none text-white"
              style={{ background: TYPE_BG[b.type] }}
            >
              {b.icon}
            </span>
            {b.label}
          </button>
        ))}
      </div>

      {/* Body: headers + tracks */}
      <div className="flex">
        <div className="w-[88px] shrink-0 border-r border-line bg-neutral-50/60">
          <div className="h-[22px] border-b border-line bg-soft" />
          {lanes.map((l) => (
            <div
              key={l.id}
              className="flex h-8 items-center gap-1.5 border-b border-neutral-100 px-2 text-[11px] font-bold last:border-0"
            >
              <span
                className="flex h-4 w-4 items-center justify-center rounded-sm text-[10px] font-bold"
                style={{
                  background:
                    l.id === 'caption'
                      ? 'rgba(8,127,91,0.15)'
                      : l.id === 'mark'
                        ? 'rgba(40,100,199,0.15)'
                        : 'rgba(163,93,0,0.15)',
                  color:
                    l.id === 'caption' ? '#087f5b' : l.id === 'mark' ? '#2864c7' : '#a35d00'
                }}
              >
                {l.icon}
              </span>
              {l.label}
            </div>
          ))}
        </div>

        <div
          ref={tracksRef}
          onPointerDown={handleStripPointerDown}
          onPointerMove={handleStripPointerMove}
          onPointerUp={handleStripPointerUp}
          onPointerCancel={handleStripPointerUp}
          className="relative min-w-0 flex-1 cursor-ew-resize select-none"
        >
          {/* Ruler */}
          <div className="relative h-[22px] border-b border-line bg-soft text-[10px] font-semibold text-muted">
            {ticks.map((t, i) => (
              <span key={i}>
                <span
                  className="absolute top-0 h-[22px] w-px bg-neutral-300"
                  style={{ left: `${(t / duration) * 100}%` }}
                />
                <span
                  className="absolute top-1 whitespace-nowrap pl-0.5 tabular-nums"
                  style={{ left: `${(t / duration) * 100}%` }}
                >
                  {formatTime(t)}
                </span>
              </span>
            ))}
          </div>

          {/* Lanes */}
          {lanes.map((lane) => (
            <div
              key={lane.id}
              className="relative h-8 border-b border-neutral-100 last:border-0"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(90deg, transparent 0, transparent 49px, #eef1f5 49px, #eef1f5 50px)'
              }}
            >
              {events.map((e, i) =>
                laneFor(e) === lane.id ? (
                  <div
                    key={i}
                    className="chip absolute top-1 flex h-6 cursor-grab items-center overflow-hidden rounded text-ellipsis whitespace-nowrap border border-black/15 px-1.5 text-[10.5px] font-bold leading-none text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_1px_2px_rgba(32,38,46,0.10)] transition-[left,width,transform,box-shadow] hover:-translate-y-px hover:shadow-md"
                    style={{
                      ...chipPosition(e, i),
                      background: TYPE_BG[e.type] || '#6c757d',
                      minWidth: '14px'
                    }}
                    onPointerDown={(ev) => startChipDrag(ev, i)}
                    title={`${e.type} @ ${formatTime(Number(e.time || 0))}${
                      e.label ? ' — ' + e.label : ''
                    }`}
                  >
                    {chipText(e)}
                  </div>
                ) : null
              )}
            </div>
          ))}

          {/* Cursor */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-[4] w-0.5 -translate-x-px bg-red-500"
            style={{
              left: cursorLeft,
              boxShadow: '0 0 0 1px rgba(255,59,48,0.18)',
              transition: scrubbing ? 'none' : 'left 60ms linear'
            }}
          >
            <div
              className="pointer-events-auto absolute top-0 left-1/2 h-[18px] w-3.5 -translate-x-1/2 cursor-grab rounded-sm rounded-b-[6px] bg-red-500 hover:bg-red-400"
              style={{ boxShadow: '0 2px 4px rgba(255,59,48,0.35)' }}
            />
            <div
              className="absolute left-1/2 -bottom-1.5 -translate-x-1/2"
              style={{
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderTop: '7px solid #ef4444'
              }}
            />
          </div>
        </div>
      </div>

      {/* Row list with edit + delete */}
      <div className="max-h-[320px] overflow-y-auto border-t border-line">
        {events.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted">
            No events yet. Click an Add button above or talk to Voice Mode.
          </div>
        ) : (
          events.map((e, i) =>
            editingIndex === i ? (
              <EventEditor
                key={i}
                event={e}
                onCancel={() => setEditingIndex(null)}
                onApply={(patch) => {
                  onUpdate(i, patch)
                  setEditingIndex(null)
                }}
              />
            ) : (
              <div
                key={i}
                className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-0"
              >
                <strong
                  className="w-[60px] shrink-0 text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: TYPE_BG[e.type] }}
                >
                  {e.type}
                </strong>
                <span className="flex-1 truncate text-[12px] text-muted">
                  {formatTime(Number(e.time || 0))} —{' '}
                  {(e.label as string) || (e.text as string) || ''}
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setEditingIndex(i)}
                    className="h-6 rounded border border-line px-2 text-[11px] font-semibold hover:border-blue"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(i)}
                    className="h-6 rounded border border-line px-2 text-[11px] font-semibold hover:border-red-400 hover:text-red-500"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          )
        )}
      </div>
    </div>
  )
}

interface EventEditorProps {
  event: TimelineEvent
  onApply: (patch: Partial<TimelineEvent>) => void
  onCancel: () => void
}

function EventEditor({ event, onApply, onCancel }: EventEditorProps) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const r: Record<string, string> = {}
    for (const [k, v] of Object.entries(event)) r[k] = String(v ?? '')
    return r
  })

  const fields = fieldsFor(event.type)

  function set(k: string, v: string): void {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  function apply(): void {
    const patch: Record<string, unknown> = {}
    for (const f of fields) {
      const v = draft[f.key] ?? ''
      if (f.text || f.select) {
        if (v === '' && (f.key === 'label' || f.key === 'text')) patch[f.key] = undefined
        else patch[f.key] = v
      } else {
        const n = Number(v)
        if (Number.isFinite(n)) patch[f.key] = n
      }
    }
    if (event.type === 'speed' || event.type === 'cut') {
      patch.time = Number(patch.start ?? patch.time ?? 0)
    }
    onApply(patch as Partial<TimelineEvent>)
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2 border-b border-neutral-100 bg-neutral-50/60 p-3 last:border-0">
      {fields.map((f) => (
        <label key={f.key} className="grid gap-1 text-[10px] font-bold uppercase tracking-wider text-muted">
          {f.label}
          {f.select ? (
            <select
              value={draft[f.key] || f.select[0]}
              onChange={(e) => set(f.key, e.target.value)}
              className="h-8 rounded border border-line bg-white px-2 text-[12px] font-medium normal-case text-ink"
            >
              {f.select.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.text ? 'text' : 'number'}
              step={f.step}
              value={draft[f.key] || ''}
              onChange={(e) => set(f.key, e.target.value)}
              className="h-8 rounded border border-line bg-white px-2 text-[12px] font-medium normal-case text-ink"
            />
          )}
        </label>
      ))}
      <div className="col-span-full flex justify-end gap-1.5">
        <button
          onClick={onCancel}
          className="h-7 rounded border border-line px-3 text-[11px] font-semibold hover:border-neutral-400"
        >
          Cancel
        </button>
        <button
          onClick={apply}
          className="h-7 rounded bg-blue px-3 text-[11px] font-semibold text-white hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

interface Field {
  key: string
  label: string
  step?: number
  text?: boolean
  select?: string[]
}

function fieldsFor(type: string): Field[] {
  const common: Field[] = [{ key: 'time', label: 'Time', step: 0.1 }]
  if (type === 'zoom' || type === 'click') {
    return [
      ...common,
      { key: 'x', label: 'X', step: 1 },
      { key: 'y', label: 'Y', step: 1 },
      { key: 'scale', label: 'Scale', step: 0.05 },
      { key: 'duration', label: 'Duration', step: 0.1 },
      { key: 'label', label: 'Label', text: true }
    ]
  }
  if (type === 'caption') {
    return [
      ...common,
      { key: 'text', label: 'Text', text: true },
      { key: 'duration', label: 'Duration', step: 0.1 },
      { key: 'position', label: 'Position', select: ['bottom', 'top'] }
    ]
  }
  if (type === 'speed') {
    return [
      { key: 'start', label: 'Start', step: 0.1 },
      { key: 'end', label: 'End', step: 0.1 },
      { key: 'factor', label: 'Factor', step: 0.1 },
      { key: 'label', label: 'Label', text: true }
    ]
  }
  if (type === 'cut') {
    return [
      { key: 'start', label: 'Start', step: 0.1 },
      { key: 'end', label: 'End', step: 0.1 },
      { key: 'label', label: 'Label', text: true }
    ]
  }
  return [...common, { key: 'label', label: 'Label', text: true }]
}
