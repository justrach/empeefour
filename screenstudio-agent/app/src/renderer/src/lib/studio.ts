// Typed wrapper around window.studio (exposed by preload).

export interface AgentStats {
  runs: number
  utterances: number
  tool_calls: number
}

export interface VoiceState {
  active: boolean
}

export interface StudioBridge {
  toggleVoice(): Promise<VoiceState>
  getVoiceState(): Promise<VoiceState>
  onListenLog(cb: (line: string) => void): () => void
  onListenState(cb: (state: VoiceState) => void): () => void
  stats(): Promise<AgentStats>
  polishRun(payload: { runName: string; apply: boolean }): Promise<{ ok: boolean; target: string }>
}

declare global {
  interface Window {
    studio?: StudioBridge
  }
}

export const studio = (): StudioBridge | undefined => window.studio
