# screenstudio-agent TypeScript Tool

This is the TypeScript-native local engine for `screenstudio-agent`.

It ports the Python recorder/tool surface into Node:

- `start` / `stop` use macOS `screencapture`.
- `mark` writes timeline events into `events.json`.
- `render` builds the same ffmpeg zoom, canvas, speed, cut, and caption filter graph.
- `editor` serves the existing local timeline UI from `studio_agent/web`.
- `run` executes simple agentic scenario JSON with app focus, typing, paste, hotkeys, clicks, zooms, speed events, captions, and shell steps.

Build from the project root:

```sh
./app/node_modules/.bin/tsc -p tool/tsconfig.json
```

Run:

```sh
node tool/dist/cli.js status
node tool/dist/cli.js editor --port 8765
node tool/dist/cli.js render runs/some-take --canvas 1920x1080
```
