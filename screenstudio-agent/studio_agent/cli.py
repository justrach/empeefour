from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .actions import run_actions
from .render import RenderOptions, render_video
from .server import run_editor
from .session import append_event, list_runs, load_active_session, read_json, start_session, stop_session
from .util import StudioError


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return parsed


def add_recording_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--name", help="Run name. Defaults to a timestamped take name.")
    parser.add_argument("--out-dir", type=Path, default=Path("runs"), help="Directory that contains run folders.")
    parser.add_argument("--display", type=int, help="Display number for screencapture, where 1 is the main display.")
    parser.add_argument("--audio", action="store_true", help="Capture default input audio.")
    parser.add_argument("--no-cursor", action="store_true", help="Do not include the cursor.")
    parser.add_argument("--no-clicks", action="store_true", help="Do not show macOS click ripples.")
    parser.add_argument("--duration", type=positive_float, help="Auto-stop after this many seconds.")


def render_options_from_args(args: argparse.Namespace) -> RenderOptions:
    return RenderOptions(
        crf=args.crf,
        preset=args.preset,
        max_zoom_events=args.max_zoom_events,
        canvas=args.canvas,
        background=args.background,
    )


def cmd_start(args: argparse.Namespace) -> int:
    session = start_session(
        Path.cwd(),
        name=args.name,
        out_dir=args.out_dir,
        display=args.display,
        audio=args.audio,
        cursor=not args.no_cursor,
        show_clicks=not args.no_clicks,
        duration=args.duration,
    )
    print(f"Recording started: {session['run_dir']}")
    print(f"Raw video: {session['raw_video']}")
    print(f"PID: {session['pid']}")
    return 0


def event_time_args(args: argparse.Namespace) -> dict[str, Any]:
    event: dict[str, Any] = {}
    if args.at is not None:
        event["time"] = round(float(args.at), 3)
    elif args.ago is not None:
        active = load_active_session(Path.cwd(), required=True) or {}
        event["time"] = round(max(0.0, time.time() - float(active["start_epoch"]) - float(args.ago)), 3)
    return event


def cmd_mark(args: argparse.Namespace) -> int:
    event = event_time_args(args)
    if args.event_type == "zoom":
        event.update(
            {
                "type": "zoom",
                "x": args.x,
                "y": args.y,
                "scale": args.scale,
                "duration": args.duration,
                "lead": args.lead,
                "label": args.label,
            }
        )
    elif args.event_type == "click":
        event.update(
            {
                "type": "click",
                "x": args.x,
                "y": args.y,
                "scale": args.scale,
                "duration": args.duration,
                "lead": args.lead,
                "label": args.label,
                "zoom": not args.no_zoom,
            }
        )
    elif args.event_type == "caption":
        event.update(
            {
                "type": "caption",
                "text": args.text,
                "duration": args.duration,
                "position": args.position,
            }
        )
    elif args.event_type == "speed":
        start = args.start if args.start is not None else args.at
        if start is None:
            raise StudioError("speed events require --start or --at")
        end = args.end if args.end is not None else start + args.duration
        event.update(
            {
                "type": "speed",
                "start": start,
                "end": end,
                "factor": args.factor,
                "label": args.label,
            }
        )
    elif args.event_type == "marker":
        event.update({"type": "marker", "label": args.label})
    else:
        raise AssertionError(args.event_type)

    written = append_event(Path.cwd(), event)
    print(f"Marked {written['type']} at {written['time']:.3f}s")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    session = stop_session(Path.cwd(), timeout=args.timeout)
    print(f"Recording stopped: {session['run_dir']}")
    print(f"Raw video: {session['raw_video']}")
    if args.render:
        output = Path(session["run_dir"]) / args.output
        render_video(
            Path(session["raw_video"]),
            Path(session["events_file"]),
            output,
            options=render_options_from_args(args),
        )
        print(f"Rendered video: {output}")
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    run_dir = args.run_dir.resolve()
    session_file = run_dir / "session.json"
    if session_file.exists():
        session = read_json(session_file)
        raw_video = Path(session["raw_video"])
        events_file = Path(session["events_file"])
    else:
        raw_video = run_dir / "raw.mov"
        events_file = run_dir / "events.json"
    output = args.output or run_dir / "final.mp4"
    render_video(raw_video, events_file, output, options=render_options_from_args(args))
    print(f"Rendered video: {output}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    with args.scenario.resolve().open("r", encoding="utf-8") as f:
        scenario = json.load(f)

    record = scenario.get("record", {})
    render = scenario.get("render", {})
    session = start_session(
        Path.cwd(),
        name=args.name or scenario.get("name"),
        out_dir=args.out_dir,
        display=args.display if args.display is not None else record.get("display"),
        audio=args.audio or bool(record.get("audio", False)),
        cursor=not args.no_cursor and bool(record.get("cursor", True)),
        show_clicks=not args.no_clicks and bool(record.get("show_clicks", True)),
        duration=args.duration or record.get("duration"),
    )
    print(f"Recording started: {session['run_dir']}")
    try:
        run_actions(Path.cwd(), session, list(scenario.get("actions", [])))
    except Exception:
        stop_session(Path.cwd(), timeout=args.timeout)
        raise

    session = stop_session(Path.cwd(), timeout=args.timeout)
    print(f"Recording stopped: {session['raw_video']}")

    should_render = args.render or bool(render.get("enabled", True))
    if should_render:
        output_name = args.output or render.get("output", "final.mp4")
        options = RenderOptions(
            crf=int(render.get("crf", args.crf)),
            preset=str(render.get("preset", args.preset)),
            max_zoom_events=args.max_zoom_events,
            canvas=args.canvas or render.get("canvas"),
            background=args.background or render.get("background", "#f3f0ea"),
        )
        output = Path(session["run_dir"]) / output_name
        render_video(Path(session["raw_video"]), Path(session["events_file"]), output, options=options)
        print(f"Rendered video: {output}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    active = load_active_session(Path.cwd(), required=False)
    if active:
        print(f"Active: {active['run_dir']} pid={active['pid']} status={active.get('status')}")
    else:
        print("No active recording.")
    runs = list_runs(Path.cwd())
    if runs:
        print("Runs:")
        for run in runs[: args.limit]:
            print(
                f"  {run['name']} raw={run['raw']} final={run['final']} events={run['events']}"
            )
    return 0


def cmd_editor(args: argparse.Namespace) -> int:
    run_editor(Path.cwd(), host=args.host, port=args.port)
    return 0


def add_render_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--preset", default="medium")
    parser.add_argument("--max-zoom-events", type=int, default=32)
    parser.add_argument("--canvas", help="Optional output canvas, like 1920x1080.")
    parser.add_argument("--background", default="#f3f0ea", help="Canvas background color.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="studio-agent",
        description="Agentic macOS screen recorder with ffmpeg-rendered zooms.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="Start a live recording session.")
    add_recording_args(start)
    start.set_defaults(func=cmd_start)

    mark = sub.add_parser("mark", help="Add a click, zoom, speed, caption, or marker to the active recording.")
    mark_sub = mark.add_subparsers(dest="event_type", required=True)

    def add_mark_time(p: argparse.ArgumentParser) -> None:
        p.add_argument("--at", type=float, help="Set event time in seconds from recording start.")
        p.add_argument("--ago", type=float, help="Set event time to this many seconds before now.")

    zoom = mark_sub.add_parser("zoom")
    zoom.add_argument("--x", type=float, required=True)
    zoom.add_argument("--y", type=float, required=True)
    zoom.add_argument("--scale", type=float, default=1.35)
    zoom.add_argument("--duration", type=float, default=1.4)
    zoom.add_argument("--lead", type=float, default=0.25)
    zoom.add_argument("--label")
    add_mark_time(zoom)

    click = mark_sub.add_parser("click")
    click.add_argument("--x", type=float, required=True)
    click.add_argument("--y", type=float, required=True)
    click.add_argument("--scale", type=float, default=1.35)
    click.add_argument("--duration", type=float, default=1.4)
    click.add_argument("--lead", type=float, default=0.25)
    click.add_argument("--label")
    click.add_argument("--no-zoom", action="store_true")
    add_mark_time(click)

    caption = mark_sub.add_parser("caption")
    caption.add_argument("text")
    caption.add_argument("--duration", type=float, default=2.0)
    caption.add_argument("--position", choices=["top", "bottom"], default="bottom")
    add_mark_time(caption)

    speed = mark_sub.add_parser("speed")
    speed.add_argument("--start", type=float, help="Source start time in seconds.")
    speed.add_argument("--end", type=float, help="Source end time in seconds.")
    speed.add_argument("--duration", type=float, default=2.0, help="Duration to speed up when --end is omitted.")
    speed.add_argument("--factor", type=positive_float, default=2.5, help="Playback speed multiplier.")
    speed.add_argument("--label")
    add_mark_time(speed)

    marker = mark_sub.add_parser("marker")
    marker.add_argument("label")
    add_mark_time(marker)
    mark.set_defaults(func=cmd_mark)

    stop = sub.add_parser("stop", help="Stop the active recording session.")
    stop.add_argument("--timeout", type=float, default=20)
    stop.add_argument("--render", action="store_true", help="Render after stopping.")
    stop.add_argument("--output", default="final.mp4", help="Output filename inside the run directory.")
    add_render_args(stop)
    stop.set_defaults(func=cmd_stop)

    render = sub.add_parser("render", help="Render a stopped run directory.")
    render.add_argument("run_dir", type=Path)
    render.add_argument("--output", type=Path)
    add_render_args(render)
    render.set_defaults(func=cmd_render)

    run = sub.add_parser("run", help="Record and render a scripted scenario.")
    run.add_argument("scenario", type=Path)
    add_recording_args(run)
    run.add_argument("--render", action="store_true", help="Render after recording. Scenario render.enabled defaults to true.")
    run.add_argument("--output", help="Output filename inside the run directory.")
    run.add_argument("--timeout", type=float, default=20)
    add_render_args(run)
    run.set_defaults(func=cmd_run)

    status = sub.add_parser("status", help="Show active recording and recent runs.")
    status.add_argument("--limit", type=int, default=10)
    status.set_defaults(func=cmd_status)

    editor = sub.add_parser("editor", help="Start the local timeline viewer/editor.")
    editor.add_argument("--host", default="127.0.0.1")
    editor.add_argument("--port", type=int, default=8765)
    editor.set_defaults(func=cmd_editor)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (StudioError, subprocess.CalledProcessError, KeyboardInterrupt) as exc:
        print(f"studio-agent: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
