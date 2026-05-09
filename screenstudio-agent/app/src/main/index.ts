// Electron main process. Spawns the Python `studio_agent editor` server,
// hosts the voice agent, polish agent, refine pass, and SQLite mirror.
// Renderer is the React app served by Vite (dev) or bundled (prod).

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import * as dotenv from 'dotenv'
import * as http from 'node:http'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'

import { PROJECT_ROOT, spawnStudio, loadActiveSession } from './studio'
import { VoiceAgent, type ListenLogLine } from './listen'
import { polish } from './polish'
import { closeAgent, getAgent, isConfigured } from './agent'
import * as db from './db'
import type { ChildProcess } from 'node:child_process'

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') })

const EDITOR_HOST = '127.0.0.1'
const EDITOR_PORT = 8765
const EDITOR_URL = `http://${EDITOR_HOST}:${EDITOR_PORT}`

let mainWindow: BrowserWindow | null = null
let editorProc: ChildProcess | null = null
let voice: VoiceAgent | null = null
let voiceOwnsRecording = false
let editTargetRun: string | null = null
let currentPlayhead = 0

function startEditorProcess(): void {
  const proc = spawnStudio(['editor', '--host', EDITOR_HOST, '--port', String(EDITOR_PORT)])
  editorProc = proc
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[editor] ${d}`))
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[editor] ${d}`))
  proc.on('exit', (code, signal) => {
    console.log(`[editor] exited code=${code} signal=${signal}`)
    editorProc = null
  })
}

function waitForEditor(timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(`${EDITOR_URL}/api/status`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry()
      })
      req.on('error', retry)
      req.setTimeout(500, () => req.destroy())
      function retry(): void {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`editor server didn't come up at ${EDITOR_URL}`))
        }
        setTimeout(tick, 250)
      }
    }
    tick()
  })
}

async function postEditor(routePath: string, body: object): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: EDITOR_HOST,
        port: EDITOR_PORT,
        method: 'POST',
        path: routePath,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          try {
            const parsed = raw ? JSON.parse(raw) : {}
            if ((res.statusCode || 0) >= 400) {
              reject(new Error((parsed as { error?: string }).error || `${res.statusCode}`))
            } else {
              resolve(parsed)
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function waitForActiveSession(timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const s = await loadActiveSession()
    if (s) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function loadEditTargetSession(): Promise<import('./studio').StudioSession | null> {
  if (!editTargetRun) return null
  const dir = path.join(PROJECT_ROOT, 'runs', editTargetRun)
  try {
    const raw = await fs.readFile(path.join(dir, 'session.json'), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function setVoiceMode(enabled: boolean): Promise<{ active: boolean }> {
  if (enabled) {
    if (voice?.active) return { active: true }

    // Edit-mode path: if a take has been selected as the edit target,
    // attach to its session WITHOUT auto-starting a new recording.
    if (editTargetRun) {
      mainWindow?.webContents.send('listen:log', `[info] editing ${editTargetRun}`)
      voiceOwnsRecording = false
      voice = new VoiceAgent({
        sessionProvider: () => loadEditTargetSession(),
        playheadProvider: () => currentPlayhead
      })
    } else {
      // Recording-mode path (legacy): if no live recording, start one.
      const active = await loadActiveSession()
      if (!active) {
        mainWindow?.webContents.send('listen:log', '[info] starting recording...')
        try {
          await postEditor('/api/record/start', { cursor: true, show_clicks: true, audio: false })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          mainWindow?.webContents.send('listen:log', `[error] start failed: ${message}`)
          return { active: false }
        }
        const ok = await waitForActiveSession()
        if (!ok) {
          mainWindow?.webContents.send('listen:log', "[error] recording didn't come up")
          return { active: false }
        }
        voiceOwnsRecording = true
      } else {
        voiceOwnsRecording = false
      }
      voice = new VoiceAgent()
    }

    voice.on('audio-chunk' as never, (bytes: Buffer) => {
      mainWindow?.webContents.send('voice:audio-chunk', bytes.toString('base64'))
    })
    voice.on('tool-fired' as never, (payload: { name: string; args: Record<string, unknown> }) => {
      mainWindow?.webContents.send('voice:tool-fired', payload)
    })
    voice.on('transcript-delta' as never, (payload: { role: 'model' | 'user'; delta: string }) => {
      mainWindow?.webContents.send('voice:transcript-delta', payload)
    })
    voice.on('audio-flush' as never, () => {
      mainWindow?.webContents.send('voice:audio-flush')
    })
    voice.on('transcript-done' as never, (payload: { role: 'model' | 'user' }) => {
      mainWindow?.webContents.send('voice:transcript-done', payload)
    })
    voice.on('log', (line: ListenLogLine) => {
      const formatted = line.kind === 'mark' ? `+ ${line.text}` : `[${line.kind}] ${line.text}`
      mainWindow?.webContents.send('listen:log', formatted)
    })
    try {
      await voice.start()
      mainWindow?.webContents.send('listen:state', { active: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      mainWindow?.webContents.send('listen:log', `[error] ${message}`)
      voice = null
      mainWindow?.webContents.send('listen:state', { active: false })
      return { active: false }
    }
  } else {
    await voice?.stop()
    voice = null
    mainWindow?.webContents.send('listen:state', { active: false })
    if (voiceOwnsRecording) {
      voiceOwnsRecording = false
      mainWindow?.webContents.send('listen:log', '[info] stopping recording + rendering...')
      try {
        const result = (await postEditor('/api/record/stop', {
          render: true,
          output: 'final.mp4',
          canvas: '1920x1080',
          crf: 18,
          preset: 'medium'
        })) as { output?: string }
        if (result.output) {
          mainWindow?.webContents.send('listen:log', `[info] rendered: ${result.output}`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        mainWindow?.webContents.send('listen:log', `[error] stop/render failed: ${message}`)
      }
    }
  }
  return { active: !!voice?.active }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    title: 'Studio Agent',
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

async function cleanupDeadSession(): Promise<void> {
  // If current.json points at a session whose PID is no longer running,
  // mark it stopped + clear the pointer so the UI starts idle.
  const pointer = path.join(PROJECT_ROOT, '.agentic-studio', 'current.json')
  let sessionFile: string | null = null
  try {
    const raw = await fs.readFile(pointer, 'utf-8')
    sessionFile = (JSON.parse(raw) as { session_file?: string }).session_file || null
  } catch {
    return
  }
  if (!sessionFile) return
  let session: { pid?: number; start_epoch?: number; status?: string }
  try {
    session = JSON.parse(await fs.readFile(sessionFile, 'utf-8'))
  } catch {
    await fs.unlink(pointer).catch(() => {})
    return
  }
  if (!session.pid) return
  let alive = false
  try {
    process.kill(session.pid, 0)
    alive = true
  } catch {
    alive = false
  }
  if (alive) return
  console.log(`[cleanup] zombie session pid=${session.pid} — marking stopped`)
  session.status = 'stopped'
  if (!('stop_epoch' in session)) {
    ;(session as { stop_epoch: number }).stop_epoch = (session.start_epoch || 0) + 5
  }
  await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf-8')
  await fs.unlink(pointer).catch(() => {})
}

async function syncRunsToDb(): Promise<void> {
  const runsDir = path.join(PROJECT_ROOT, 'runs')
  let entries: string[] = []
  try {
    entries = await fs.readdir(runsDir)
  } catch {
    return
  }
  for (const name of entries) {
    const sessionFile = path.join(runsDir, name, 'session.json')
    try {
      const raw = await fs.readFile(sessionFile, 'utf-8')
      const s = JSON.parse(raw) as {
        run_dir?: string
        raw_video?: string
        events_file?: string
        started_at?: string
        stopped_at?: string
        start_epoch?: number
        stop_epoch?: number
        status?: string
      }
      const duration = s.start_epoch && s.stop_epoch ? s.stop_epoch - s.start_epoch : null
      db.upsertRun({
        name,
        run_dir: s.run_dir || path.join(runsDir, name),
        raw_video: s.raw_video || null,
        events_file: s.events_file || null,
        started_at: s.started_at || null,
        stopped_at: s.stopped_at || null,
        duration,
        status: s.status || null
      })
    } catch {
      /* skip */
    }
  }
}

ipcMain.handle('voice:toggle', () => setVoiceMode(!voice?.active))
ipcMain.handle('voice:state', () => ({ active: !!voice?.active }))
ipcMain.handle('voice:setEditTarget', (_e, runName: string | null) => {
  editTargetRun = runName
  return { ok: true, editTarget: runName }
})
ipcMain.handle('voice:setPlayhead', (_e, time: number) => {
  currentPlayhead = Number(time) || 0
})
ipcMain.handle('voice:setMuted', (_e, muted: boolean) => {
  voice?.setMuted(!!muted)
  return { ok: true, muted: !!muted }
})
ipcMain.handle('polish:run', async (_e, payload: { runName: string; apply: boolean }) => {
  const runDir = path.join(PROJECT_ROOT, 'runs', payload.runName)
  const target = await polish(runDir, { apply: payload.apply })
  db.recordEdit({
    run_name: payload.runName,
    op: 'polish',
    payload: { apply: payload.apply, target },
    source: 'agent'
  })
  return { ok: true, target }
})
ipcMain.handle('agent:stats', () => db.stats())
ipcMain.handle(
  'journal:edit',
  (_e, e: { run_name: string; op: 'add' | 'update' | 'delete' | 'render' | 'polish'; payload: unknown; source: 'voice' | 'manual' | 'agent'; event_index?: number | null }) => {
    db.recordEdit(e)
    return { ok: true }
  }
)
ipcMain.handle('journal:recent', (_e, runName: string, limit?: number) =>
  db.recentEdits(runName, limit ?? 50)
)

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.empeefour.studio')
  db.open()

  startEditorProcess()
  try {
    await waitForEditor()
  } catch (err) {
    console.error('[editor]', err instanceof Error ? err.message : String(err))
  }

  await cleanupDeadSession().catch((e) => console.error('[cleanup] failed:', e))
  await syncRunsToDb().catch((e) => console.error('[db] sync failed:', e))

  if (isConfigured()) {
    getAgent().catch((err) => {
      console.error(`[agent] init failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  } else {
    console.warn('[agent] CURSOR_API_KEY not set — polish will fail until you add one to .env')
  }

  createWindow()

  setInterval(() => {
    syncRunsToDb().catch(() => {})
  }, 5000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await voice?.stop()
  try {
    editorProc?.kill('SIGINT')
  } catch {
    /* ignore */
  }
  await closeAgent()
  db.close()
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled]', reason)
})
