// Typed wrapper around window.studio (exposed by preload).

export interface AgentStats {
  runs: number
  utterances: number
  tool_calls: number
}

export interface VoiceState {
  active: boolean
}

export type EditOp = 'add' | 'update' | 'delete' | 'render' | 'polish'
export type EditSource = 'voice' | 'manual' | 'agent'

export interface EditEntry {
  run_name: string
  op: EditOp
  payload: unknown
  source: EditSource
  event_index?: number | null
}

export interface ToolFiredPayload {
  name: string
  args: Record<string, unknown>
}

export interface TranscriptDeltaPayload {
  role: 'model' | 'user'
  delta: string
}

export interface TranscriptDonePayload {
  role: 'model' | 'user'
}

export interface StudioBridge {
  toggleVoice(): Promise<VoiceState>
  getVoiceState(): Promise<VoiceState>
  setEditTarget(runName: string | null): Promise<{ ok: boolean; editTarget: string | null }>
  setPlayhead(time: number): Promise<void>
  setMuted(muted: boolean): Promise<{ ok: boolean; muted: boolean }>
  onAudioChunk(cb: (base64Pcm: string) => void): () => void
  onToolFired(cb: (payload: ToolFiredPayload) => void): () => void
  onTranscriptDelta(cb: (payload: TranscriptDeltaPayload) => void): () => void
  onTranscriptDone(cb: (payload: TranscriptDonePayload) => void): () => void
  onListenLog(cb: (line: string) => void): () => void
  onListenState(cb: (state: VoiceState) => void): () => void
  stats(): Promise<AgentStats>
  polishRun(payload: { runName: string; apply: boolean }): Promise<{ ok: boolean; target: string }>
  journalEdit(e: EditEntry): Promise<{ ok: boolean }>
  journalRecent(runName: string, limit?: number): Promise<unknown[]>
}

declare global {
  interface Window {
    studio?: StudioBridge
  }
}

export const studio = (): StudioBridge | undefined => window.studio
