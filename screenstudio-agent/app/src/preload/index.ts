import { contextBridge, ipcRenderer } from 'electron'

interface VoiceState { active: boolean }
interface AgentStats { runs: number; utterances: number; tool_calls: number }

const studio = {
  toggleVoice: (): Promise<VoiceState> => ipcRenderer.invoke('voice:toggle'),
  getVoiceState: (): Promise<VoiceState> => ipcRenderer.invoke('voice:state'),
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
    ipcRenderer.invoke('polish:run', payload)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('studio', studio)
} else {
  // @ts-expect-error fallback when context isolation is disabled
  window.studio = studio
}
