---
name: tiktok-captions
description: Burn TikTok-style word-grouped captions over a video using whisper word timestamps and the ASS subtitle format.
when-to-use: When the user asks for TikTok captions, burned subtitles, on-screen words synced to speech, or "captions like Reels/Shorts."
---

# TikTok Captions

Style that works in feed: **2-3 word phrases, big bold sans-serif,
white with thick black outline, centered or upper-third, swap on a tight
beat synced to speech**. Source the timing from `transcript.json`'s
`words[]` array (already from whisper-1).

## Pick your render path FIRST

**On macOS in this project: ALWAYS try `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`
before plain `ffmpeg`.** The brew formula `ffmpeg-full` is keg-only (not
on PATH) but has libass + freetype, so the fast `subtitles=` filter
works there. The plain `ffmpeg` on PATH is the stripped Homebrew bottle
and lacks both — falling back to per-frame PNG rendering on a 19-min
video burns ~10 minutes of CPU for nothing.

```bash
# Check ffmpeg-full first (preferred):
FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
test -x "$FFMPEG" || FFMPEG=ffmpeg
$FFMPEG -hide_banner -filters 2>&1 | grep -E "^[ .]+(subtitles|drawtext)"
```

Use the same `$FFMPEG` for the actual render call. Examples below show
the literal path; substitute `$FFMPEG` if you've stored it.

- **Has `subtitles`** → use ASS file + `subtitles=` filter (fastest,
  ~12s for a 140s 1080p video, ~60s for a 19-min 1080p video). The
  default path. Skip to "ASS path" below.
- **Has `drawtext` only** → write per-phrase `drawtext` instances with
  `enable=between(t,start,end)` chained in the filter graph. Medium
  speed.
- **Has neither** (rare now that ffmpeg-full is the default) → render
  each phrase to a transparent PNG with PIL, overlay frame-by-frame.
  Slow but works. EXPECT 10-15 minutes on a 140s output with ~85
  caption events.


- `transcript.json` — whisper words array
- The video to burn captions onto (e.g. `cut-nomusic.mp4` if you're
  about to add music, or `final.mp4` if it's already scored)

## Procedure

1. **Group words into phrases.** TikTok readability rule: 2-3 words per
   phrase, max ~15 characters. If a single word is longer than 15
   chars, it stands alone. Phrases should respect natural breaks (don't
   split "Adaption Labs" if you can avoid it). The phrase `start` =
   first word's `start`; `end` = last word's `end`.

   Simple greedy grouping: walk the words array, accumulate until
   adding the next word would exceed 3 words OR ~15 chars OR the gap
   to the next word is >0.4s (sentence break) — then flush.

2. **Generate `captions.ass`** in the run dir:

   ```
   [Script Info]
   ScriptType: v4.00+
   PlayResX: 1080
   PlayResY: 1920

   [V4+ Styles]
   Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
   Style: TikTok,Arial Black,60,&H00FFFFFF,&H00000000,&H00000000,1,1,4,0,2,40,40,280

   [Events]
   Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
   Dialogue: 0,0:00:00.18,0:00:00.62,TikTok,,0,0,0,,HEY GUYS
   Dialogue: 0,0:00:00.62,0:00:01.04,TikTok,,0,0,0,,SO TODAY
   ```

   Style notes (defaults calibrated from real runs):
   - `Fontname=Arial Black` — heavy sans-serif always available on
     macOS. Use `Impact` if you want louder.
   - `Fontsize=60` — readable on phone playback at 1080x1920 without
     dominating the frame. Bump to 80-90 only for dramatic emphasis
     on a single word.
   - `PrimaryColour=&H00FFFFFF` (white), `OutlineColour=&H00000000`
     (black), `Outline=4` — TikTok signature. `Outline=6` for very
     large fonts only.
   - `Alignment=2` (bottom-center) is the TikTok default — caption
     sits above the playback bar. Use `8` (top-center) only if you
     have on-screen text or graphics at the bottom of the frame.
     `5` (middle-center) covers the speaker's face and reads as a
     mistake — avoid.
   - `MarginV=280` keeps the caption clear of the iOS playback UI
     when `Alignment=2`. Use `MarginV=80` when `Alignment=8`.
   - `BorderStyle=1` — outline + drop shadow. `3` is opaque box.
   - **UPPERCASE the text** — looks more TikTok. Lowercase reads
     softer; use that for confessional/emotional content.

   ASS time format: `H:MM:SS.cs` (centiseconds, two digits).

3. **Burn into video** with the `subtitles=` filter (use the
   ffmpeg-full path you resolved above — `subtitles=` won't exist on
   plain ffmpeg):

   ```bash
   /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -y -i input.mp4 \
     -vf "subtitles=captions.ass:fontsdir=/System/Library/Fonts/Supplemental" \
     -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
     -c:a copy \
     output.mp4
   ```

   `fontsdir` is where macOS keeps Arial Black. If text appears as a
   different font, the filter couldn't find it.

4. **Validate** with a quick frame export from a known caption time:

   ```bash
   ffmpeg -ss 1 -i output.mp4 -frames:v 1 -y /tmp/frame.png
   open /tmp/frame.png
   ```

## When to combine with music overlay

Order: **captions first, then music**. The music overlay only touches
audio, so burning captions earlier lets you re-mix audio without
re-rendering the captions.

```
cut-nomusic.mp4
  → (burn captions)        → cut-captioned-nomusic.mp4
  → (overlay music)        → final.mp4   (uses cut-captioned-nomusic as video source)
```

If you want to reuse the captioned video later (e.g. swap music), keep
`cut-captioned-nomusic.mp4` around.

## Tuning per content type

- **Talking head, fast pacing**: 2-word phrases, swap every ~0.4s.
  Maximum punch.
- **Slow narration**: 3-word phrases, swap on natural pauses.
- **Heavy emphasis line**: Use a per-phrase override
  `{\fs120\c&H0000FFFF&}MONEY` (yellow, larger) to spotlight a key word.

## Anti-patterns

- **One long sentence on screen.** TikTok captions are *rhythm*, not
  closed-captions. Break aggressively.
- **Skipping the outline.** White text without a black outline
  disappears on bright frames.
- **Lowercase + thin font.** Reads as a Western Union telegram, not
  shortform. Default to bold weight + uppercase.
- **Not normalizing punctuation.** Whisper sometimes tags `,` or `.`
  to a word. Strip trailing punctuation when emphasizing readability.
- **Mismatched timing.** If captions feel "behind" the audio,
  whisper's word boundaries are conservative — shift each phrase
  start back by ~0.05-0.1s.
