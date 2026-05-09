# ScreenStudio Agent

ScreenStudio Agent is a local prototype for agentic product-demo recording. It records a macOS screen, lets Codex or a script drive the UI, logs important moments as timeline events, and renders the final take with `ffmpeg`.

The project lives in plain folders:

```text
runs/<take>/
  raw.mov
  events.json
  session.json
  final.mp4
```

## Requirements

- macOS
- Node.js for the TypeScript tool (`tool/dist/cli.js`)
- `ffmpeg` and `ffprobe` on `PATH`
- Screen Recording permission for the terminal or Codex app when macOS asks
- Accessibility permission for scripted UI actions
- `ffmpeg` with `drawtext` if you want caption overlays; zoom and canvas rendering work without it

## TypeScript Tool

The lowest-level recorder/editor/render tool now has a TypeScript port in `tool/`.

Build it:

```bash
./app/node_modules/.bin/tsc -p tool/tsconfig.json
```

Run it:

```bash
node tool/dist/cli.js status
node tool/dist/cli.js editor --port 8765
node tool/dist/cli.js render runs/demo --canvas 1920x1080
```

The Electron helpers prefer the TypeScript tool when `tool/dist/cli.js` exists. Set `STUDIO_ENGINE=python` to force the original Python implementation.

## Live Agent Workflow

Start a take:

```bash
node tool/dist/cli.js start --name demo
```

Control the screen with Codex `@Computer`, by hand, or with another automation. While recording, mark moments that should become render events:

```bash
node tool/dist/cli.js mark click --x 900 --y 520 --ago 0.2
node tool/dist/cli.js mark zoom --x 900 --y 520 --scale 1.45 --duration 1.6
node tool/dist/cli.js mark speed --start 8 --end 13 --factor 2.5 --label "Typing"
node tool/dist/cli.js mark caption "The important setting is here" --duration 2
```

Stop and render:

```bash
node tool/dist/cli.js stop --render --canvas 1920x1080
```

## Scripted Workflow

Run a scenario:

```bash
node tool/dist/cli.js run examples/browser-demo.json
```

Scenario actions:

- `open_url`
- `focus_app`
- `hotkey`
- `press`
- `type`
- `paste`
- `click`
- `zoom`
- `speed`
- `caption`
- `marker`
- `wait`
- `shell`

## Timeline Editor

Start the local editor:

```bash
node tool/dist/cli.js editor --port 8765
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The editor can list runs, edit `events.json`, add click/zoom/caption events, save, and trigger a render.

The editor now has three main work areas:

- **Recorder**: start/stop a macOS screen recording from the browser UI.
- **Add Event**: add zoom, click, speed, caption, or marker events without editing JSON by hand. Use **Use Video Time** to pull the current preview timestamp into the form.
- **Render**: choose canvas, CRF quality, preset, and background before producing `final.mp4`.

The JSON panel still stays available for precise edits and unusual timeline experiments.

## Timeline Events

Example event file:

```json
{
  "events": [
    {
      "type": "click",
      "time": 2.15,
      "x": 900,
      "y": 520,
      "scale": 1.35,
      "duration": 1.4,
      "lead": 0.25,
      "zoom": true
    },
    {
      "type": "caption",
      "time": 4.1,
      "text": "Rendered from a timeline",
      "duration": 2,
      "position": "bottom"
    },
    {
      "type": "speed",
      "start": 8.0,
      "end": 13.0,
      "factor": 2.5,
      "label": "Typing"
    }
  ]
}
```

## Current Shape

Built:

- macOS recorder wrapper around `screencapture`
- active session state
- click, zoom, caption, and marker timeline events
- speed events for compressing typing or dead-air stretches
- AppleScript-based scripted UI control
- ffmpeg zoom renderer with optional 1920x1080 canvas
- local timeline viewer/editor
- TypeScript-native CLI/server/renderer in `tool/`, with Python still available as a fallback

Good next layers:

- smarter event capture from actual mouse/key events
- automatic dead-air trimming
- cursor path reconstruction and custom cursor rendering
- app/window tracking so zooms can anchor to semantic UI regions
- small timeline preview player
