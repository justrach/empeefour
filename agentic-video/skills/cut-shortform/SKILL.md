---
name: cut-shortform
description: Shape a 30-90 second editorial cut from a longer interview/talk using a word-timestamped transcript.
when-to-use: When the user asks for a clip, hook, shortform, reel, or wants a long video tightened.
---

# Cut Shortform

The single editorial principle: **one coherent argument, source order
preserved**. Stitched-together montages of disconnected good lines feel
random; the goal is a clip that earns the next watch by escalating one
idea.

## Inputs

- `transcript.json` — required. Read `segments` first, then go to `words`
  for cut boundaries.
- An editorial brief from the user (target length, tone, subject,
  pacing). The brief is the goal; it is not a list of cuts to make.

## Procedure

1. **Skim the segments.** Identify 3-7 candidate moments where the
   speaker says something concrete. Mark the segment id and rough time.
2. **Pick the spine.** From the candidates, choose ONE through-line:
   *cold-open hook → catalyst → escalation → payoff*. Discard candidates
   that don't serve the spine — even if they're individually strong.
3. **Lock cut points** to word boundaries from the `words` array. The
   start of a span = the `start` of the first kept word; the end = the
   `end` of the last kept word.
4. **Write `cuts.json`** before rendering. Schema:

   ```json
   {
     "title": "Brief title for the clip",
     "target_duration_seconds": "~30 (28-32 window)",
     "keep_spans": [
       { "start": 35.04, "end": 39.26, "reason": "Cold open on …" }
     ],
     "cut_policy": [
       "Boundaries on whisper word timestamps, no reordering.",
       "Removed dead air, hedges, mid-sentence restarts."
     ]
   }
   ```

5. **Render** via the `render-final` skill.

## Tail (optional)

If the user asks for the original video to continue after the hook
("then add the main video back," "play the rest after," "append the
source"), record it in `cuts.json` as a `tail` block:

```json
{
  "title": "...",
  "keep_spans": [ ... ],
  "tail": {
    "from": 98.14,
    "to": null,
    "music": false
  },
  "cut_policy": [ ... ]
}
```

- `from` is a source-time in seconds. Most useful: the `end` of the
  LAST keep-span, so the body picks up exactly where the hook left
  off (no jump).
- `to` of `null` means run to the end of the source.
- `music: false` means the music ducks out before the body starts.

Render order: keep-spans first, then the tail, concatenated. See
`render-final/SKILL.md` for the filter pattern.

If `tail` is absent, render only the hook (default behavior).

## Pacing rules by target length

| Target | Bias |
|---|---|
| ≤30s | Aggressive. One argument. No subordinate clauses unless they pay off the punch. Cut filler ruthlessly. |
| 60s | Setup → tension → payoff. Some breathing room. Tolerate one clause that earns the next line. |
| 90s+ | Looser pacing, narrative arc, more context preserved. Still no reordering. |

## Things to cut without asking

- Throat-clearing, "you know," "like," "I mean," "umm"
- Mid-sentence restarts ("the — the thing is")
- Attribution wind-up before a quoted line
- Dead air > 0.3s unless it's doing tension/emphasis work
- Self-deprecating hedges ("probably shouldn't say this") — usually the
  next clause is the actual point

## Things to keep even when slow

- Pauses that land a punchline (rare, but real)
- The breath before a key word (1 word's-worth, not 2)
- The first beat of laughter when it earns the line

## Anti-patterns

- **Reordering** to make a tighter argument. Don't. The viewer will
  notice the seam, and source-order discipline is what keeps the cut
  honest.
- **Stitching the loudest moments** instead of building a spine. AI tools
  default to this. It's why they don't make good interview cuts.
- **Cutting mid-word.** Whisper gives you the boundaries. Use them.
