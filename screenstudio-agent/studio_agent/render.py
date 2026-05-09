from __future__ import annotations

import json
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import StudioError, ensure_tool

_FILTER_CACHE: dict[str, bool] = {}


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    duration: float | None
    fps: float


@dataclass(frozen=True)
class ZoomEvent:
    time: float
    x: float
    y: float
    scale: float
    duration: float
    lead: float
    out: float


@dataclass(frozen=True)
class CaptionEvent:
    time: float
    text: str
    duration: float
    position: str


@dataclass(frozen=True)
class SpeedEvent:
    start: float
    end: float
    factor: float
    label: str | None = None


@dataclass(frozen=True)
class CutEvent:
    start: float
    end: float
    label: str | None = None


@dataclass(frozen=True)
class TimelineSegment:
    start: float
    end: float
    factor: float = 1.0
    cut: bool = False

@dataclass(frozen=True)
class RenderOptions:
    crf: int = 18
    preset: str = "medium"
    max_zoom_events: int = 32
    canvas: str | None = None
    background: str = "#f3f0ea"


def ffprobe(path: Path) -> VideoInfo:
    ensure_tool("ffprobe")
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,duration,avg_frame_rate,r_frame_rate",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise StudioError(result.stderr.strip() or f"Unable to probe {path}")
    data = json.loads(result.stdout)
    streams = data.get("streams") or []
    if not streams:
        raise StudioError(f"No video stream found in {path}")
    stream = streams[0]
    duration = stream.get("duration") or (data.get("format") or {}).get("duration")
    fps = parse_frame_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "30/1")
    return VideoInfo(
        width=int(stream["width"]),
        height=int(stream["height"]),
        duration=float(duration) if duration is not None else None,
        fps=fps,
    )


def parse_frame_rate(value: str) -> float:
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        den = float(denominator)
        if den == 0:
            return 30.0
        return max(1.0, float(numerator) / den)
    return max(1.0, float(value))


def has_audio_stream(path: Path) -> bool:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def has_ffmpeg_filter(name: str) -> bool:
    if name in _FILTER_CACHE:
        return _FILTER_CACHE[name]
    ensure_tool("ffmpeg")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    available = any(line.split()[1:2] == [name] for line in result.stdout.splitlines() if line.split())
    _FILTER_CACHE[name] = available
    return available


def read_events(events_file: Path) -> list[dict[str, Any]]:
    with events_file.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return list(data.get("events", []))


def zooms_from_events(events: list[dict[str, Any]], *, max_events: int = 32) -> list[ZoomEvent]:
    zooms: list[ZoomEvent] = []
    for event in events:
        kind = event.get("type")
        if kind != "zoom" and not (kind == "click" and event.get("zoom", True)):
            continue
        if "x" not in event or "y" not in event:
            continue
        scale = float(event.get("scale", 1.35))
        if scale <= 1.0:
            continue
        duration = max(0.2, float(event.get("duration", 1.4)))
        lead = max(0.0, float(event.get("lead", 0.25)))
        out = max(0.05, float(event.get("out", min(0.35, duration / 3))))
        if lead + out >= duration:
            lead = min(lead, duration * 0.4)
            out = min(out, duration * 0.4)
        zooms.append(
            ZoomEvent(
                time=max(0.0, float(event.get("time", 0))),
                x=float(event["x"]),
                y=float(event["y"]),
                scale=scale,
                duration=duration,
                lead=lead,
                out=out,
            )
        )
    return sorted(zooms, key=lambda zoom: zoom.time)[:max_events]


def captions_from_events(events: list[dict[str, Any]]) -> list[CaptionEvent]:
    captions: list[CaptionEvent] = []
    for event in events:
        if event.get("type") != "caption" or not event.get("text"):
            continue
        captions.append(
            CaptionEvent(
                time=max(0.0, float(event.get("time", 0))),
                text=str(event["text"]),
                duration=max(0.2, float(event.get("duration", 2.0))),
                position=str(event.get("position", "bottom")),
            )
        )
    return sorted(captions, key=lambda caption: caption.time)


def speed_events_from_events(events: list[dict[str, Any]], duration: float | None) -> list[SpeedEvent]:
    speeds: list[SpeedEvent] = []
    for event in events:
        if event.get("type") != "speed":
            continue
        start = float(event.get("start", event.get("time", 0)))
        if "end" in event:
            end = float(event["end"])
        else:
            end = start + float(event.get("duration", 0))
        factor = float(event.get("factor", event.get("speed", 1.0)))
        if factor <= 0:
            raise StudioError("Speed factor must be greater than 0")
        if duration is not None:
            start = min(max(0.0, start), duration)
            end = min(max(0.0, end), duration)
        if end <= start:
            continue
        speeds.append(SpeedEvent(start=start, end=end, factor=factor, label=event.get("label")))
    speeds.sort(key=lambda speed: speed.start)

    normalized: list[SpeedEvent] = []
    last_end = 0.0
    for speed in speeds:
        start = max(speed.start, last_end)
        if speed.end <= start:
            continue
        normalized.append(SpeedEvent(start=start, end=speed.end, factor=speed.factor, label=speed.label))
        last_end = speed.end
    return normalized


def cut_events_from_events(events: list[dict[str, Any]], duration: float | None) -> list[CutEvent]:
    cuts: list[CutEvent] = []
    for event in events:
        if event.get("type") != "cut":
            continue
        start = float(event.get("start", event.get("time", 0)))
        end = float(event.get("end", start))
        if duration is not None:
            start = min(max(0.0, start), duration)
            end = min(max(0.0, end), duration)
        if end <= start:
            continue
        cuts.append(CutEvent(start=start, end=end, label=event.get("label")))
    cuts.sort(key=lambda c: c.start)
    return cuts


def timeline_segments(
    duration: float,
    speeds: list[SpeedEvent],
    cuts: list[CutEvent] | None = None,
) -> list[TimelineSegment]:
    cuts = cuts or []
    cut_ranges = [(c.start, c.end) for c in cuts]

    # Trim speed ranges so cuts override.
    trimmed_speeds: list[SpeedEvent] = []
    for s in speeds:
        cur = s.start
        overlaps = sorted(
            [(cs, ce) for cs, ce in cut_ranges if ce > s.start and cs < s.end]
        )
        for cs, ce in overlaps:
            if cur < cs:
                trimmed_speeds.append(SpeedEvent(start=cur, end=cs, factor=s.factor, label=s.label))
            cur = max(cur, ce)
        if cur < s.end:
            trimmed_speeds.append(SpeedEvent(start=cur, end=s.end, factor=s.factor, label=s.label))

    items: list[tuple[float, float, float, bool]] = []
    for s in trimmed_speeds:
        items.append((s.start, s.end, s.factor, False))
    for c in cuts:
        items.append((c.start, c.end, 1.0, True))
    items.sort(key=lambda x: x[0])

    segments: list[TimelineSegment] = []
    cursor = 0.0
    for start, end, factor, is_cut in items:
        if start > cursor:
            segments.append(TimelineSegment(cursor, start, 1.0, False))
        segments.append(TimelineSegment(start, end, factor, is_cut))
        cursor = end
    if cursor < duration:
        segments.append(TimelineSegment(cursor, duration, 1.0, False))
    return [segment for segment in segments if segment.end - segment.start > 0.001]


def mapped_time(time_value: float, segments: list[TimelineSegment]) -> float:
    elapsed = 0.0
    for segment in segments:
        if segment.cut:
            if segment.start <= time_value < segment.end:
                return elapsed
            if time_value >= segment.end:
                # cut contributes 0 to elapsed
                continue
            return elapsed
        if time_value >= segment.end:
            elapsed += (segment.end - segment.start) / segment.factor
            continue
        if time_value <= segment.start:
            return elapsed
        elapsed += (time_value - segment.start) / segment.factor
        return elapsed
    return elapsed


def speed_factor_at(time_value: float, segments: list[TimelineSegment]) -> float:
    for segment in segments:
        if segment.cut:
            continue
        if segment.start <= time_value < segment.end:
            return segment.factor
    return 1.0


def is_in_cut(time_value: float, segments: list[TimelineSegment]) -> bool:
    for segment in segments:
        if segment.cut and segment.start <= time_value < segment.end:
            return True
    return False


def retime_events(events: list[dict[str, Any]], segments: list[TimelineSegment]) -> list[dict[str, Any]]:
    retimed: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") in ("speed", "cut"):
            continue
        item = dict(event)
        if "time" in item:
            original_time = float(item["time"])
            if is_in_cut(original_time, segments):
                continue
            item["time"] = round(mapped_time(original_time, segments), 3)
            factor = speed_factor_at(original_time, segments)
            for key in ("duration", "lead", "out"):
                if key in item:
                    item[key] = round(float(item[key]) / factor, 3)
        retimed.append(item)
    return sorted(retimed, key=lambda item: float(item.get("time", 0)))


def num(value: float) -> str:
    if math.isclose(value, round(value)):
        return str(int(round(value)))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def pulse_expr(event: ZoomEvent, *, time_var: str = "t") -> str:
    start = max(0.0, event.time - event.lead)
    in_d = max(0.001, event.time - start)
    end = start + event.duration
    out_start = max(event.time, end - event.out)

    s = num(start)
    t_in_end = num(start + in_d)
    t_hold_end = num(out_start)
    t_end = num(end)
    in_d_s = num(in_d)
    out_d_s = num(event.out)
    out_start_s = num(out_start)

    ease_in = f"(0.5-0.5*cos(PI*(({time_var})-{s})/{in_d_s}))"
    ease_out = f"(0.5+0.5*cos(PI*(({time_var})-{out_start_s})/{out_d_s}))"
    return (
        f"if(lt(({time_var}),{s}),0,"
        f"if(lt(({time_var}),{t_in_end}),{ease_in},"
        f"if(lt(({time_var}),{t_hold_end}),1,"
        f"if(lt(({time_var}),{t_end}),{ease_out},0))))"
    )


def build_zoom_filter(info: VideoInfo, zooms: list[ZoomEvent]) -> str:
    width = info.width
    height = info.height
    if not zooms:
        return "setsar=1"

    fps = "60"
    time_var = f"(on/{fps})"
    pulses = [pulse_expr(event, time_var=time_var) for event in zooms]
    pulse_sum = "+".join(f"({pulse})" for pulse in pulses)
    zoom_expr = "1+" + "+".join(
        f"({num(event.scale - 1.0)})*({pulse})" for event, pulse in zip(zooms, pulses)
    )
    cx_weighted = "+".join(f"({num(event.x)})*({pulse})" for event, pulse in zip(zooms, pulses))
    cy_weighted = "+".join(f"({num(event.y)})*({pulse})" for event, pulse in zip(zooms, pulses))
    cx_expr = f"if(gt(({pulse_sum}),0.001),({cx_weighted})/({pulse_sum}),{num(width / 2)})"
    cy_expr = f"if(gt(({pulse_sum}),0.001),({cy_weighted})/({pulse_sum}),{num(height / 2)})"

    crop_x = f"min(max(({cx_expr})-iw/({zoom_expr})/2,0),iw-iw/({zoom_expr}))"
    crop_y = f"min(max(({cy_expr})-ih/({zoom_expr})/2,0),ih-ih/({zoom_expr}))"
    return (
        f"fps={fps},zoompan=z='{zoom_expr}':x='{crop_x}':y='{crop_y}':d=1:"
        f"s={width}x{height}:fps={fps},setsar=1"
    )


def parse_canvas(canvas: str | None) -> tuple[int, int] | None:
    if not canvas:
        return None
    if "x" not in canvas:
        raise StudioError("Canvas must be formatted like 1920x1080")
    width, height = canvas.lower().split("x", 1)
    parsed = (int(width), int(height))
    if parsed[0] <= 0 or parsed[1] <= 0:
        raise StudioError("Canvas dimensions must be positive")
    return parsed


def canvas_filter(canvas: str | None, background: str) -> str | None:
    parsed = parse_canvas(canvas)
    if parsed is None:
        return None
    width, height = parsed
    max_w = max(2, width - 192)
    max_h = max(2, height - 144)
    return (
        f"scale={max_w}:{max_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background}"
    )


def drawtext_escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace("\n", " ")
    )


def caption_filter(caption: CaptionEvent) -> str:
    start = num(caption.time)
    end = num(caption.time + caption.duration)
    y = "48" if caption.position == "top" else "h-text_h-56"
    text = drawtext_escape(caption.text)
    return (
        "drawtext="
        f"text='{text}':"
        "x=(w-text_w)/2:"
        f"y={y}:"
        "fontsize=42:"
        "fontcolor=white:"
        "box=1:"
        "boxcolor=black@0.58:"
        "boxborderw=18:"
        f"enable='between(t,{start},{end})'"
    )


def build_filter(
    info: VideoInfo,
    events: list[dict[str, Any]],
    options: RenderOptions,
    *,
    captions_enabled: bool,
) -> str:
    parts = [build_zoom_filter(info, zooms_from_events(events, max_events=options.max_zoom_events))]
    canvas = canvas_filter(options.canvas, options.background)
    if canvas:
        parts.append(canvas)
    if captions_enabled:
        parts.extend(caption_filter(caption) for caption in captions_from_events(events))
    parts.append("format=yuv420p")
    return ",".join(parts)


def atempo_chain(factor: float) -> str:
    parts: list[float] = []
    remaining = factor
    while remaining > 2.0:
        parts.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        parts.append(0.5)
        remaining /= 0.5
    parts.append(remaining)
    return ",".join(f"atempo={num(part)}" for part in parts)


def render_speed_adjusted_source(
    raw_video: Path,
    temp_video: Path,
    segments: list[TimelineSegment],
) -> Path:
    ensure_tool("ffmpeg")
    audio = has_audio_stream(raw_video)
    filters: list[str] = []
    concat_inputs: list[str] = []
    kept = 0
    for index, segment in enumerate(segments):
        if segment.cut:
            continue  # cut segments are removed from the output
        start = num(segment.start)
        end = num(segment.end)
        factor = num(segment.factor)
        filters.append(
            f"[0:v]trim=start={start}:end={end},setpts=(PTS-STARTPTS)/{factor}[v{index}]"
        )
        concat_inputs.append(f"[v{index}]")
        if audio:
            filters.append(
                f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS,"
                f"{atempo_chain(segment.factor)}[a{index}]"
            )
            concat_inputs.append(f"[a{index}]")
        kept += 1

    if kept == 0:
        raise StudioError("Cuts removed every frame; nothing to render")

    if audio:
        filters.append("".join(concat_inputs) + f"concat=n={kept}:v=1:a=1[v][a]")
        map_args = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k"]
    else:
        filters.append("".join(concat_inputs) + f"concat=n={kept}:v=1:a=0[v]")
        map_args = ["-map", "[v]", "-an"]

    temp_video.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(raw_video),
        "-filter_complex",
        ";".join(filters),
        *map_args,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "14",
        "-movflags",
        "+faststart",
        str(temp_video),
    ]
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise StudioError(result.stderr.strip())
    return temp_video


def render_video(
    raw_video: Path,
    events_file: Path,
    output: Path,
    *,
    options: RenderOptions | None = None,
) -> Path:
    ensure_tool("ffmpeg")
    if not raw_video.exists():
        raise StudioError(f"Raw recording does not exist: {raw_video}")
    if not events_file.exists():
        raise StudioError(f"Events file does not exist: {events_file}")

    opts = options or RenderOptions()
    info = ffprobe(raw_video)
    events = read_events(events_file)
    speed_events = speed_events_from_events(events, info.duration)
    cut_events = cut_events_from_events(events, info.duration)
    source_video = raw_video
    render_events = events
    temp_video: Path | None = None
    if speed_events or cut_events:
        if info.duration is None:
            raise StudioError("Cannot apply speed/cut events when input duration is unknown")
        segments = timeline_segments(info.duration, speed_events, cut_events)
        render_events = retime_events(events, segments)
        temp_video = output.parent / f".{output.stem}.{os.getpid()}.speed.mp4"
        source_video = render_speed_adjusted_source(raw_video, temp_video, segments)
        info = ffprobe(source_video)

    captions_enabled = has_ffmpeg_filter("drawtext")
    vf = build_filter(info, render_events, opts, captions_enabled=captions_enabled)

    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(source_video),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        opts.preset,
        "-crf",
        str(opts.crf),
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output),
    ]
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if temp_video is not None:
        temp_video.unlink(missing_ok=True)
    if result.returncode != 0:
        raise StudioError(result.stderr.strip())
    return output
