---
name: render-final
description: ffmpeg recipes for rendering the final cut from raw.mp4 + cuts.json, plus encoder settings and validation.
when-to-use: After cuts.json exists. Final step before overlay-music or before delivery if there's no music.
---

# Render Final

Build `final.mp4` by trimming each keep-span from `raw.mp4` and
concatenating them. Source-order only — never reorder.

## Encoder settings (shortform-safe)

| Setting | Value | Reason |
|---|---|---|
| video codec | `libx264` | Universal, good quality at low bitrates |
| crf | `20` | Visually lossless for talking-head; lower = bigger file |
| preset | `medium` | Fine balance; `slow` for archival, `fast` for iteration |
| audio codec | `aac` | Universal |
| audio bitrate | `128k` (160k if music) | Plenty for voice + music |
| pixel format | `yuv420p` | Required for broad compatibility (esp. Safari/Twitter) |
| flags | `+faststart` | Moves moov atom to start so the file streams |

## Filter graph pattern

For N keep-spans `[(s1,e1), (s2,e2), …]`:

```bash
ffmpeg -y -i raw.mp4 \
  -filter_complex "
    [0:v]trim=start=$s1:end=$e1,setpts=PTS-STARTPTS[v0];
    [0:a]atrim=start=$s1:end=$e1,asetpts=PTS-STARTPTS[a0];
    [0:v]trim=start=$s2:end=$e2,setpts=PTS-STARTPTS[v1];
    [0:a]atrim=start=$s2:end=$e2,asetpts=PTS-STARTPTS[a1];
    ...
    [v0][a0][v1][a1]...concat=n=N:v=1:a=1[v][a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  final.mp4
```

Build the graph string in code — don't hand-write it for >3 spans.

## Rendering with a tail

If `cuts.json` has a `tail` block, append the source from `tail.from`
to `tail.to` (or end of source) after the keep-spans:

```bash
# N hook spans + 1 tail = N+1 segments in the concat
ffmpeg -y -i raw.mp4 \
  -filter_complex "
    [0:v]trim=start=$s1:end=$e1,setpts=PTS-STARTPTS[v0];
    [0:a]atrim=start=$s1:end=$e1,asetpts=PTS-STARTPTS[a0];
    ...
    [0:v]trim=start=$tail_from,setpts=PTS-STARTPTS[vt];
    [0:a]atrim=start=$tail_from,asetpts=PTS-STARTPTS[at];
    [v0][a0]...[vt][at]concat=n=N+1:v=1:a=1[v][a]
  " \
  -map "[v]" -map "[a]" \
  -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart \
  final.mp4
```

If `tail.to` is set, use `:end=$tail_to` on both trims. If `tail.from`
is the same as the last keep-span's end, the cut is seamless — there's
no jump, the source just keeps playing.

When music is overlaid, music covers ONLY the hook portion (sum of
keep-span durations). See `overlay-music/SKILL.md` — the music track
needs an `afade=out` ending before `tail.from` so it doesn't bleed
into the body.

## Validation

```bash
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 final.mp4
```

Confirm:

- Duration is within the target window from `cuts.json`.
- Sum of `keep_span` durations matches output duration ± 0.05s. If it
  doesn't, the filter graph is wrong (usually a `setpts` missing on a
  trim output).

For audio sanity:

```bash
ffmpeg -hide_banner -i final.mp4 -af volumedetect -f null -
```

- `mean_volume` between -25 and -15 dB
- `max_volume` below -1 dB (no clipping)

## Common failure modes

- **Output is half-length.** `setpts=PTS-STARTPTS` is missing on a video
  trim, or `asetpts` is missing on an audio trim. Both are required to
  reset the timestamp on each segment.
- **Audio drifts.** Re-encoding with `-c:v copy` while still re-encoding
  audio. Use `-c:v libx264` unless you're certain the source codec is
  shippable.
- **Black flash between cuts.** Not actually a render bug — it's the cut
  happening on a frame the encoder can't reproduce cleanly. Either move
  the boundary to a nearby word or accept it.
- **No audio in output.** The `concat` filter needs `v=1:a=1` and you
  must `-map` both `[v]` and `[a]`.
