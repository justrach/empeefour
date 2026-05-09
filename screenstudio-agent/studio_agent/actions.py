from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

from .session import append_event
from .util import StudioError


KEY_CODES = {
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "escape": 53,
    "esc": 53,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
}

MODIFIERS = {
    "command": "command down",
    "cmd": "command down",
    "shift": "shift down",
    "option": "option down",
    "alt": "option down",
    "control": "control down",
    "ctrl": "control down",
}


def apple_string(value: str) -> str:
    return json.dumps(value)


def osascript(lines: list[str]) -> subprocess.CompletedProcess[str]:
    cmd: list[str] = ["osascript"]
    for line in lines:
        cmd.extend(["-e", line])
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def require_ok(result: subprocess.CompletedProcess[str], action: str) -> None:
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise StudioError(f"{action} failed: {detail}")


def focus_app(name: str) -> None:
    require_ok(osascript([f"tell application {apple_string(name)} to activate"]), f"focus_app {name}")


def open_url(url: str) -> None:
    subprocess.run(["open", url], check=True)


def type_text(text: str) -> None:
    result = osascript(
        [
            'tell application "System Events"',
            f"keystroke {apple_string(text)}",
            "end tell",
        ]
    )
    require_ok(result, "type_text")


def paste_text(text: str) -> None:
    subprocess.run(["pbcopy"], input=text, text=True, check=True)
    hotkey(["command", "v"])


def hotkey(keys: list[str]) -> None:
    if not keys:
        raise StudioError("hotkey action requires keys")
    modifiers = [MODIFIERS[key.lower()] for key in keys[:-1] if key.lower() in MODIFIERS]
    key = keys[-1].lower()
    using = ""
    if modifiers:
        using = " using {" + ", ".join(modifiers) + "}"

    if key in KEY_CODES:
        command = f"key code {KEY_CODES[key]}{using}"
    elif len(key) == 1:
        command = f"keystroke {apple_string(key)}{using}"
    else:
        raise StudioError(f"Unsupported hotkey key: {key}")

    result = osascript(['tell application "System Events"', command, "end tell"])
    require_ok(result, f"hotkey {'+'.join(keys)}")


def press(key: str) -> None:
    hotkey([key])


def click(x: float, y: float) -> None:
    result = osascript(
        [
            'tell application "System Events"',
            f"click at {{{int(round(x))}, {int(round(y))}}}",
            "end tell",
        ]
    )
    require_ok(result, f"click {x},{y}")


def run_shell(command: str, cwd: str | None = None) -> None:
    subprocess.run(command, shell=True, cwd=cwd, check=True)


def action_time(session: dict[str, Any]) -> float:
    return round(max(0.0, time.time() - float(session["start_epoch"])), 3)


def run_actions(root: Path, session: dict[str, Any], actions: list[dict[str, Any]]) -> None:
    for index, action in enumerate(actions, start=1):
        kind = action.get("type")
        if not kind:
            raise StudioError(f"Action #{index} is missing a type")

        before = action_time(session)
        if kind == "wait":
            time.sleep(float(action.get("seconds", action.get("duration", 1.0))))
        elif kind == "focus_app":
            focus_app(str(action["name"]))
        elif kind == "open_url":
            open_url(str(action["url"]))
        elif kind == "type":
            text = str(action.get("text", ""))
            if action.get("paste", False) or len(text) > 80:
                paste_text(text)
            else:
                type_text(text)
        elif kind == "paste":
            paste_text(str(action.get("text", "")))
        elif kind == "hotkey":
            hotkey([str(key) for key in action["keys"]])
        elif kind == "press":
            press(str(action["key"]))
        elif kind == "click":
            x = float(action["x"])
            y = float(action["y"])
            append_event(
                root,
                {
                    "type": "click",
                    "time": before,
                    "x": x,
                    "y": y,
                    "scale": float(action.get("scale", 1.35)),
                    "duration": float(action.get("duration", 1.4)),
                    "lead": float(action.get("lead", 0.25)),
                    "label": action.get("label"),
                    "zoom": bool(action.get("zoom", True)),
                },
            )
            click(x, y)
        elif kind == "zoom":
            append_event(
                root,
                {
                    "type": "zoom",
                    "time": before,
                    "x": float(action["x"]),
                    "y": float(action["y"]),
                    "scale": float(action.get("scale", 1.35)),
                    "duration": float(action.get("duration", 1.4)),
                    "lead": float(action.get("lead", 0.25)),
                    "label": action.get("label"),
                },
            )
        elif kind == "caption":
            append_event(
                root,
                {
                    "type": "caption",
                    "time": before,
                    "text": str(action["text"]),
                    "duration": float(action.get("duration", 2.0)),
                    "position": str(action.get("position", "bottom")),
                },
            )
        elif kind == "speed":
            start = float(action.get("start", before))
            end = float(action.get("end", start + float(action.get("duration", 2.0))))
            append_event(
                root,
                {
                    "type": "speed",
                    "time": start,
                    "start": start,
                    "end": end,
                    "factor": float(action.get("factor", 2.5)),
                    "label": action.get("label"),
                },
            )
        elif kind == "marker":
            event = {key: value for key, value in action.items() if key != "type"}
            event["type"] = "marker"
            event["time"] = before
            append_event(root, event)
        elif kind == "shell":
            run_shell(str(action["command"]), cwd=action.get("cwd"))
        else:
            known = "wait, focus_app, open_url, type, paste, hotkey, press, click, zoom, speed, caption, marker, shell"
            raise StudioError(f"Unsupported action #{index}: {kind}. Known actions: {known}")

        after_delay = float(action.get("after", 0))
        if after_delay > 0:
            time.sleep(after_delay)
