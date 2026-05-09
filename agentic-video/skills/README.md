# Skills

Each subdirectory documents a capability the agent has. Read the relevant
SKILL.md files **before** acting — they encode the lessons learned from
prior runs.

## Index

| Folder | When to use |
|---|---|
| [`transcribe/`](transcribe/SKILL.md) | Get word-level timestamps from a video before any cut. |
| [`cut-shortform/`](cut-shortform/SKILL.md) | Build a 30-90s clip from a longer interview using a transcript. Supports an optional `tail` to append source after the hook. |
| [`tiktok-captions/`](tiktok-captions/SKILL.md) | Burn word-grouped captions over a video using whisper word timestamps + ASS subtitles. TikTok/Reels style. |
| [`overlay-music/`](overlay-music/SKILL.md) | Score the cut: pick a track from `library/music/`, duck under dialogue, render the mix. |
| [`render-final/`](render-final/SKILL.md) | Encoder settings, filter graph patterns, validation. |
| [`music-creation/`](music-creation/) | Generate or remix custom music from stems. Four detailed recipes. Heavy — only when the user explicitly asks for original music, not for picking from the library. |

## Convention

Each skill has frontmatter:

```yaml
---
name: <slug>
description: <one line — when to invoke this skill>
when-to-use: <triggering conditions>
---
```

Followed by a body documenting inputs, procedure, and what to leave on
disk (so the choice is auditable).

## Output contract

Every run leaves files in `runs/<take>/`:

- `raw.mp4`         source video
- `audio.mp3`       extracted mono audio
- `transcript.json` whisper-1 verbose_json with word-level timing
- `cuts.json`       the keep-spans plan with reasoning
- `music.json`      the chosen track + ducking config (when scored)
- `final.mp4`       the rendered output
