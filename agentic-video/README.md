# agentic-video

Cursor-agent harness for editing video from a freeform editorial brief.
Hand it a video and a prompt; it reads `skills/`, plans cuts, optionally
scores with music from `library/music/`, and writes the rendered output.

## Layout

```
agentic-video/
├── src/run.ts            # entry: agent harness
├── skills/               # capabilities the agent reads before acting
│   ├── README.md         # skill index
│   ├── transcribe/SKILL.md
│   ├── cut-shortform/SKILL.md
│   ├── overlay-music/SKILL.md
│   ├── render-final/SKILL.md
│   └── music-creation/   # 4 detailed remix recipes (symlinked)
├── library/
│   └── music -> /…/wetransfer_songfrommaxstream-stems-wav…  (54 tracks)
├── runs/<take>/          # output: raw.mp4, audio.mp3, transcript.json,
│                         #         cuts.json, music.json, final.mp4
└── .env -> ../screenstudio-agent/.env
```

## Usage

```bash
npm install        # one-time
npm run run -- \
  --video /path/to/source.mp4 \
  --prompt "Your editorial brief — target length, tone, subject" \
  --name optional-run-label
```

Optional `--reuse runs/<other-take>` copies an existing `transcript.json`
to skip the ~$0.06/min transcription cost on re-runs of the same video.

## How it works

1. Script extracts audio (`ffmpeg`), transcribes it once
   (`whisper-1` with word timestamps), then hands cwd to the Cursor
   agent (`@cursor/sdk`, model `composer-2`).
2. Agent reads `skills/` to know what's possible, then drives ffmpeg
   itself to plan and render. It writes `cuts.json` (auditable plan)
   and `final.mp4` into the run dir.
3. If the brief asks for music, it picks a track from `library/music/`,
   writes `music.json`, and overlays with sidechain ducking per the
   `overlay-music` skill.
