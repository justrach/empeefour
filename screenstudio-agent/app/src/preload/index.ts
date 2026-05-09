import { contextBridge, ipcRenderer } from 'electron'

interface VoiceState { active: boolean }
interface AgentStats { runs: number; utterances: number; tool_calls: number }

type EditOp = 'add' | 'update' | 'delete' | 'render' | 'polish'
type EditSource = 'voice' | 'manual' | 'agent'

const studio = {
  toggleVoice: (): Promise<VoiceState> => ipcRenderer.invoke('voice:toggle'),
  getVoiceState: (): Promise<VoiceState> => ipcRenderer.invoke('voice:state'),
  setEditTarget: (runName: string | null): Promise<{ ok: boolean; editTarget: string | null }> =>
    ipcRenderer.invoke('voice:setEditTarget', runName),
  setPlayhead: (time: number): Promise<void> =>
    ipcRenderer.invoke('voice:setPlayhead', time),
  setMuted: (muted: boolean): Promise<{ ok: boolean; muted: boolean }> =>
    ipcRenderer.invoke('voice:setMuted', muted),
  onAudioChunk(cb: (base64Pcm: string) => void) {
    const handler = (_e: unknown, b: string): void => cb(b)
    ipcRenderer.on('voice:audio-chunk', handler)
    return (): void => {
      ipcRenderer.removeListener('voice:audio-chunk', handler)
    }
  },
  onListenLog(cb: (line: string) => void) {
    const handler = (_e: unknown, line: string): void => cb(line)
    ipcRenderer.on('listen:log', handler)
    return (): void => {
      ipcRenderer.removeListener('listen:log', handler)
    }
  },
  onListenState(cb: (state: VoiceState) => void) {
    const handler = (_e: unknown, state: VoiceState): void => cb(state)
    ipcRenderer.on('listen:state', handler)
    return (): void => {
      ipcRenderer.removeListener('listen:state', handler)
    }
  },
  stats: (): Promise<AgentStats> => ipcRenderer.invoke('agent:stats'),
  polishRun: (payload: { runName: string; apply: boolean }) =>
    ipcRenderer.invoke('polish:run', payload),
  journalEdit: (e: {
    run_name: string
    op: EditOp
    payload: unknown
    source: EditSource
    event_index?: number | null
  }) => ipcRenderer.invoke('journal:edit', e),
  journalRecent: (runName: string, limit?: number) =>
    ipcRenderer.invoke('journal:recent', runName, limit)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('studio', studio)
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.studio = studio
}
