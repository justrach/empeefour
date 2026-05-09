import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("studio", {
  toggleVoice: () => ipcRenderer.invoke("voice:toggle"),
  getVoiceState: () => ipcRenderer.invoke("voice:state"),
  polish: (runName: string, apply: boolean) =>
    ipcRenderer.invoke("polish:run", { runName, apply }),
  stats: () => ipcRenderer.invoke("agent:stats"),
  suggestions: (kind: string, limit?: number) =>
    ipcRenderer.invoke("agent:suggestions", kind, limit),
  recentUtterances: (limit?: number) =>
    ipcRenderer.invoke("agent:recent-utterances", limit),
  getPref: (key: string) => ipcRenderer.invoke("agent:get-pref", key),
  setPref: (key: string, value: string) =>
    ipcRenderer.invoke("agent:set-pref", key, value),
  onListenLog: (cb: (line: string) => void) =>
    ipcRenderer.on("listen:log", (_e, line) => cb(line)),
  onListenState: (cb: (state: { active: boolean }) => void) =>
    ipcRenderer.on("listen:state", (_e, state) => cb(state)),
});
