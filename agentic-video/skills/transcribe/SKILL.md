---
name: transcribe
description: Produce a word-level timestamped transcript from a video using OpenAI whisper-1.
when-to-use: When you need to make cut decisions on dialogue and don't already have transcript.json in the run dir.
---

# Transcribe

Word-level timing is what makes clean cuts possible — every cut boundary
should land between words, never mid-word. `gpt-4o-transcribe` produces
better text but **does not support `timestamp_granularities`**, so for
editing we always use `whisper-1` with `verbose_json`.

## When to skip

If `runs/<take>/transcript.json` already exists, **do not re-transcribe**.
The harness pre-bakes it before handing off. Re-running costs ~$0.06/min.

## Procedure

1. Extract audio with ffmpeg (mono, 16 kHz, 32 kbps mp3 — keeps under the
   25 MB upload cap and is plenty for whisper):

   ```bash
   ffmpeg -y -i raw.mp4 -vn -ac 1 -ar 16000 -b:a 32k audio.mp3
   ```

2. Call the API (OpenAI key is in the env):

   ```bash
   curl --request POST \
     --url https://api.openai.com/v1/audio/transcriptions \
     --header "Authorization: Bearer $OPENAI_API_KEY" \
     --header 'Content-Type: multipart/form-data' \
     --form file=@audio.mp3 \
     --form model=whisper-1 \
     --form response_format=verbose_json \
     --form 'timestamp_granularities[]=word' \
     --form 'timestamp_granularities[]=segment' \
     > transcript.json
   ```

## Output shape

`transcript.json` contains:

- `text` — full transcript as a single string
- `segments[]` — phrase-level groupings: `{id, start, end, text, …}`. Skim
  these first to map the territory.
- `words[]` — every word with `{word, start, end}` in seconds. Use these
  to lock exact cut times.

## Rules

- Cut boundaries must align to word `start` / `end` from the `words`
  array. Do not interpolate — the next word's `start` is the right
  boundary if you want to preserve a trailing breath.
- For non-English audio, set `--form language=<iso639>` to bias the model.
- If the transcript misses a proper noun, re-run with `--form prompt="..."`
  containing the spelling. Whisper only reads the last 224 tokens of the
  prompt, so keep it short.
