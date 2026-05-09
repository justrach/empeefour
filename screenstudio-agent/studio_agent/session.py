from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import StudioError, ensure_tool, now_iso, read_json, timestamp_name, write_json


STATE_DIR_NAME = ".agentic-studio"
CURRENT_FILE = "current.json"


@dataclass(frozen=True)
class SessionPaths:
    root: Path
    state_dir: Path
    current_file: Path
    run_dir: Path
    raw_video: Path
    events_file: Path
    session_file: Path
    recorder_log: Path


def project_paths(root: Path, run_dir: Path | None = None) -> SessionPaths:
    state_dir = root / STATE_DIR_NAME
    actual_run_dir = run_dir or root / "runs" / "manual"
    return SessionPaths(
        root=root,
        state_dir=state_dir,
        current_file=state_dir / CURRENT_FILE,
        run_dir=actual_run_dir,
        raw_video=actual_run_dir / "raw.mov",
        events_file=actual_run_dir / "events.json",
        session_file=actual_run_dir / "session.json",
        recorder_log=actual_run_dir / "recorder.log",
    )


def build_screencapture_command(
    raw_video: Path,
    *,
    display: int | None = None,
    audio: bool = False,
    cursor: bool = True,
    show_clicks: bool = True,
    duration: float | None = None,
) -> list[str]:
    cmd = ["screencapture", "-v", "-x"]
    if cursor:
        cmd.append("-C")
    if show_clicks:
        cmd.append("-k")
    if audio:
        cmd.append("-g")
    if display is not None:
        cmd.append(f"-D{display}")
    if duration is not None:
        cmd.append(f"-V{duration:g}")
    cmd.append(str(raw_video))
    return cmd


def is_process_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def load_active_session(root: Path, *, required: bool = True) -> dict[str, Any] | None:
    current = project_paths(root).current_file
    if not current.exists():
        if required:
            raise StudioError("No active recording session found.")
        return None
    pointer = read_json(current)
    session_file = Path(pointer["session_file"])
    if not session_file.exists():
        if required:
            raise StudioError(f"Active session metadata is missing: {session_file}")
        return None
    return read_json(session_file)


def resolve_session(root: Path, run_dir: Path | None = None) -> dict[str, Any]:
    if run_dir is None:
        session = load_active_session(root, required=True)
        assert session is not None
        return session
    session_file = run_dir / "session.json"
    if not session_file.exists():
        raise StudioError(f"No session.json found in {run_dir}")
    return read_json(session_file)


def start_session(
    root: Path,
    *,
    name: str | None = None,
    out_dir: Path | None = None,
    display: int | None = None,
    audio: bool = False,
    cursor: bool = True,
    show_clicks: bool = True,
    duration: float | None = None,
) -> dict[str, Any]:
    ensure_tool("screencapture")

    active = load_active_session(root, required=False)
    if active and is_process_running(int(active["pid"])):
        raise StudioError(
            f"A recording is already active in {active['run_dir']} with pid {active['pid']}."
        )

    run_name = name or timestamp_name()
    base_out = (out_dir or root / "runs").expanduser()
    run_dir = (base_out / run_name).resolve()
    paths = project_paths(root, run_dir)
    paths.run_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)

    if paths.raw_video.exists():
        raise StudioError(f"Refusing to overwrite existing video: {paths.raw_video}")

    cmd = build_screencapture_command(
        paths.raw_video,
        display=display,
        audio=audio,
        cursor=cursor,
        show_clicks=show_clicks,
        duration=duration,
    )

    started_at = now_iso()
    start_epoch = time.time()
    log = paths.recorder_log.open("ab")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
        close_fds=True,
    )
    time.sleep(0.7)
    if proc.poll() is not None:
        raise StudioError(
            f"screencapture exited immediately with code {proc.returncode}. "
            f"See {paths.recorder_log}"
        )

    session = {
        "version": 1,
        "pid": proc.pid,
        "root": str(root),
        "run_dir": str(paths.run_dir),
        "raw_video": str(paths.raw_video),
        "events_file": str(paths.events_file),
        "session_file": str(paths.session_file),
        "recorder_log": str(paths.recorder_log),
        "started_at": started_at,
        "start_epoch": start_epoch,
        "record": {
            "display": display,
            "audio": audio,
            "cursor": cursor,
            "show_clicks": show_clicks,
            "duration": duration,
        },
        "status": "recording",
    }
    events = {
        "version": 1,
        "recording": {
            "started_at": started_at,
            "start_epoch": start_epoch,
            "raw_video": str(paths.raw_video),
        },
        "events": [],
    }
    write_json(paths.session_file, session)
    write_json(paths.events_file, events)
    write_json(paths.current_file, {"session_file": str(paths.session_file)})
    return session


def append_event(root: Path, event: dict[str, Any], *, run_dir: Path | None = None) -> dict[str, Any]:
    session = resolve_session(root, run_dir)
    events_file = Path(session["events_file"])
    data = read_json(events_file)
    start_epoch = float(data["recording"]["start_epoch"])

    normalized = dict(event)
    if "time" not in normalized:
        normalized["time"] = round(max(0.0, time.time() - start_epoch), 3)
    normalized.setdefault("created_at", now_iso())

    data.setdefault("events", []).append(normalized)
    data["events"].sort(key=lambda item: float(item.get("time", 0)))
    write_json(events_file, data)
    return normalized


def stop_session(root: Path, *, run_dir: Path | None = None, timeout: float = 20.0) -> dict[str, Any]:
    session = resolve_session(root, run_dir)
    pid = int(session["pid"])

    if session.get("status") != "stopped" and is_process_running(pid):
        try:
            os.killpg(pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and is_process_running(pid):
            time.sleep(0.2)
        if is_process_running(pid):
            os.killpg(pid, signal.SIGTERM)
            time.sleep(0.5)

    stopped_at = now_iso()
    stop_epoch = time.time()
    session["status"] = "stopped"
    session["stopped_at"] = stopped_at
    session["stop_epoch"] = stop_epoch
    write_json(Path(session["session_file"]), session)

    events_file = Path(session["events_file"])
    if events_file.exists():
        events = read_json(events_file)
        events.setdefault("recording", {})["stopped_at"] = stopped_at
        events.setdefault("recording", {})["stop_epoch"] = stop_epoch
        events.setdefault("recording", {})["duration"] = round(
            stop_epoch - float(events["recording"]["start_epoch"]), 3
        )
        write_json(events_file, events)

    current = project_paths(root).current_file
    if current.exists():
        pointer = read_json(current)
        if Path(pointer.get("session_file", "")) == Path(session["session_file"]):
            current.unlink()

    return session


def list_runs(root: Path) -> list[dict[str, Any]]:
    runs_dir = root / "runs"
    if not runs_dir.exists():
        return []
    runs: list[dict[str, Any]] = []
    for run_dir in sorted(runs_dir.iterdir(), key=lambda path: path.stat().st_mtime, reverse=True):
        if not run_dir.is_dir():
            continue
        events_file = run_dir / "events.json"
        session_file = run_dir / "session.json"
        final_file = run_dir / "final.mp4"
        raw_file = run_dir / "raw.mov"
        events_count = 0
        if events_file.exists():
            try:
                events_count = len(read_json(events_file).get("events", []))
            except Exception:
                events_count = 0
        runs.append(
            {
                "name": run_dir.name,
                "run_dir": str(run_dir),
                "raw": raw_file.exists(),
                "final": final_file.exists(),
                "events": events_count,
                "session": session_file.exists(),
            }
        )
    return runs
