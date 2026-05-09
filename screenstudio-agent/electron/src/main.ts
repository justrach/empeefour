// Electron main process. Spawns the Python editor server, opens a window
// pointed at it, and hosts the TS voice agent + polish flow in-process.

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from "electron";
import { ChildProcess } from "node:child_process";
import * as dotenv from "dotenv";
import * as http from "node:http";
import * as path from "node:path";

import { PROJECT_ROOT, spawnStudio, loadActiveSession } from "./studio";
import { VoiceAgent, ListenLogLine } from "./listen";
import { polish } from "./polish";
import { closeAgent, getAgent, isConfigured } from "./agent";
import * as db from "./db";
import { promises as fs } from "node:fs";

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

const EDITOR_HOST = "127.0.0.1";
const EDITOR_PORT = 8765;
const EDITOR_URL = `http://${EDITOR_HOST}:${EDITOR_PORT}`;

let mainWindow: BrowserWindow | null = null;
let editorProc: ChildProcess | null = null;
let voice: VoiceAgent | null = null;

function startEditorProcess(): void {
  const proc = spawnStudio([
    "editor",
    "--host",
    EDITOR_HOST,
    "--port",
    String(EDITOR_PORT),
  ]);
  editorProc = proc;
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[editor] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[editor] ${d}`));
  proc.on("exit", (code, signal) => {
    console.log(`[editor] exited code=${code} signal=${signal}`);
    editorProc = null;
  });
}

function waitForEditor(timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${EDITOR_URL}/api/status`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(500, () => req.destroy());
      function retry() {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`editor server didn't come up at ${EDITOR_URL}`));
        }
        setTimeout(tick, 250);
      }
    };
    tick();
  });
}

// Tracks whether Voice Mode auto-started the recording, so we know
// whether to also stop+render when Voice Mode turns off.
let voiceOwnsRecording = false;

async function postEditor(path: string, body: object): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: EDITOR_HOST,
        port: EDITOR_PORT,
        method: "POST",
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if ((res.statusCode || 0) >= 400) reject(new Error((parsed as { error?: string }).error || `${res.statusCode}`));
            else resolve(parsed);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitForActiveSession(timeoutMs = 5000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await loadActiveSession();
    if (s) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function setVoiceMode(enabled: boolean): Promise<{ active: boolean }> {
  if (enabled) {
    if (voice?.active) return { active: true };

    // Auto-start a recording if none is active. The voice agent needs an
    // active session to attach to.
    const active = await loadActiveSession();
    if (!active) {
      mainWindow?.webContents.send("listen:log", "[info] starting recording...");
      try {
        await postEditor("/api/record/start", {
          cursor: true,
          show_clicks: true,
          audio: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mainWindow?.webContents.send("listen:log", `[error] start failed: ${message}`);
        return { active: false };
      }
      const ok = await waitForActiveSession();
      if (!ok) {
        mainWindow?.webContents.send("listen:log", "[error] recording didn't come up");
        return { active: false };
      }
      voiceOwnsRecording = true;
    } else {
      voiceOwnsRecording = false;
    }

    voice = new VoiceAgent();
    voice.on("log", (line: ListenLogLine) => {
      const formatted = line.kind === "mark" ? `+ ${line.text}` : `[${line.kind}] ${line.text}`;
      mainWindow?.webContents.send("listen:log", formatted);
    });
    try {
      await voice.start();
      mainWindow?.webContents.send("listen:state", { active: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mainWindow?.webContents.send("listen:log", `[error] ${message}`);
      voice = null;
      mainWindow?.webContents.send("listen:state", { active: false });
      rebuildMenu();
      return { active: false };
    }
  } else {
    await voice?.stop();
    voice = null;
    mainWindow?.webContents.send("listen:state", { active: false });

    // If Voice Mode auto-started the recording, also stop and render now.
    if (voiceOwnsRecording) {
      voiceOwnsRecording = false;
      mainWindow?.webContents.send("listen:log", "[info] stopping recording + rendering...");
      try {
        const result = await postEditor("/api/record/stop", {
          render: true,
          output: "final.mp4",
          canvas: "1920x1080",
          crf: 18,
          preset: "medium",
        }) as { output?: string };
        if (result.output) {
          mainWindow?.webContents.send("listen:log", `[info] rendered: ${result.output}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mainWindow?.webContents.send("listen:log", `[error] stop/render failed: ${message}`);
      }
    }
  }
  rebuildMenu();
  return { active: !!voice?.active };
}

function rebuildMenu(): void {
  const voiceActive = !!voice?.active;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "ScreenStudio",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Recording",
      submenu: [
        {
          label: voiceActive ? "Stop voice mode" : "Start voice mode",
          accelerator: "CmdOrCtrl+Shift+V",
          click: () => {
            void setVoiceMode(!voiceActive);
          },
        },
        {
          label: "Open run folder",
          click: () => void shell.openPath(path.join(PROJECT_ROOT, "runs")),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "ScreenStudio Agent",
    backgroundColor: "#1d1d1f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(EDITOR_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("voice:toggle", async () => setVoiceMode(!voice?.active));
ipcMain.handle("voice:state", () => ({ active: !!voice?.active }));
ipcMain.handle("polish:run", async (_e, payload: { runName: string; apply: boolean }) => {
  const runDir = path.join(PROJECT_ROOT, "runs", payload.runName);
  const target = await polish(runDir, { apply: payload.apply });
  return { ok: true, target };
});
ipcMain.handle("agent:stats", () => db.stats());
ipcMain.handle("agent:suggestions", (_e, kind: string, limit?: number) =>
  db.topSuggestions(kind, limit ?? 10),
);
ipcMain.handle("agent:recent-utterances", (_e, limit?: number) =>
  db.recentUtterances(limit ?? 50),
);
ipcMain.handle("agent:get-pref", (_e, key: string) => db.getPreference(key));
ipcMain.handle("agent:set-pref", (_e, key: string, value: string) => {
  db.setPreference(key, value);
  return { ok: true };
});

async function syncRunsToDb(): Promise<void> {
  const runsDir = path.join(PROJECT_ROOT, "runs");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const sessionFile = path.join(runsDir, name, "session.json");
    try {
      const raw = await fs.readFile(sessionFile, "utf-8");
      const s = JSON.parse(raw) as {
        run_dir?: string;
        raw_video?: string;
        events_file?: string;
        started_at?: string;
        stopped_at?: string;
        start_epoch?: number;
        stop_epoch?: number;
        status?: string;
      };
      const duration =
        s.start_epoch && s.stop_epoch ? s.stop_epoch - s.start_epoch : null;
      db.upsertRun({
        name,
        run_dir: s.run_dir || path.join(runsDir, name),
        raw_video: s.raw_video || null,
        events_file: s.events_file || null,
        started_at: s.started_at || null,
        stopped_at: s.stopped_at || null,
        duration,
        status: s.status || null,
      });
    } catch {
      // Run dir without session.json (e.g. smoke test) — skip silently.
    }
  }
}

app.whenReady().then(async () => {
  db.open();
  startEditorProcess();
  try {
    await waitForEditor();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      "Editor server failed to start",
      `Could not reach ${EDITOR_URL}.\n\n${message}\n\nIs python3 on PATH and screenstudio-agent installed?`,
    );
    app.quit();
    return;
  }
  await syncRunsToDb().catch((e) => console.error("[db] sync failed:", e));
  if (isConfigured()) {
    getAgent().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent] init failed: ${message}`);
    });
  } else {
    console.warn("[agent] CURSOR_API_KEY not set — polish will fail until you add one to .env");
  }
  createWindow();
  rebuildMenu();
  // Periodic resync — cheap, idempotent.
  setInterval(() => {
    syncRunsToDb().catch(() => {});
  }, 5_000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", async () => {
  await voice?.stop();
  try {
    editorProc?.kill("SIGINT");
  } catch {
    /* ignore */
  }
  await closeAgent();
  db.close();
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandled]", reason);
});

void loadActiveSession;
