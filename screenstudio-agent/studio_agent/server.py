from __future__ import annotations

import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .render import RenderOptions, render_video
from .session import list_runs, load_active_session, start_session, stop_session
from .util import StudioError, read_json, write_json


WEB_DIR = Path(__file__).with_name("web")
MEDIA_FILES = {"raw.mov", "final.mp4"}


def safe_run_dir(root: Path, name: str) -> Path:
    decoded = unquote(name)
    if "/" in decoded or "\\" in decoded or decoded in {"", ".", ".."}:
        raise StudioError("Invalid run name")
    run_dir = (root / "runs" / decoded).resolve()
    runs_root = (root / "runs").resolve()
    if not str(run_dir).startswith(str(runs_root)):
        raise StudioError("Run path escaped runs directory")
    return run_dir


def safe_media_file(root: Path, run_name: str, file_name: str) -> Path:
    if file_name not in MEDIA_FILES:
        raise StudioError("Invalid media file")
    path = safe_run_dir(root, run_name) / file_name
    if not path.exists():
        raise FileNotFoundError(path)
    return path


class EditorHandler(BaseHTTPRequestHandler):
    root: Path

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def add_cors_headers(self) -> None:
        # Editor is dev-only and bound to 127.0.0.1, so wide-open CORS is safe.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")

    def send_json(self, data: object, status: int = 200) -> None:
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.add_cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, message: str, status: int = 400) -> None:
        self.send_json({"error": message}, status=status)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.add_cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/status":
                self.send_json({"active": load_active_session(self.root, required=False)})
                return
            if path == "/api/runs":
                self.send_json({"runs": list_runs(self.root)})
                return
            if path.startswith("/api/runs/") and path.endswith("/events"):
                name = path.removeprefix("/api/runs/").removesuffix("/events").strip("/")
                run_dir = safe_run_dir(self.root, name)
                self.send_json(read_json(run_dir / "events.json"))
                return
            if path.startswith("/media/runs/"):
                parts = path.removeprefix("/media/runs/").split("/", 1)
                if len(parts) != 2:
                    raise StudioError("Invalid media path")
                self.serve_file(safe_media_file(self.root, parts[0], parts[1]))
                return
            self.serve_static(path)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)

    def do_PUT(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/runs/") and parsed.path.endswith("/events"):
                name = parsed.path.removeprefix("/api/runs/").removesuffix("/events").strip("/")
                run_dir = safe_run_dir(self.root, name)
                payload = self.read_json_body()
                if not isinstance(payload.get("events"), list):
                    raise StudioError("events payload must contain an events array")
                write_json(run_dir / "events.json", payload)
                self.send_json({"ok": True})
                return
            self.send_error_json("Not found", status=404)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/record/start":
                payload = self.read_json_body()
                session = start_session(
                    self.root,
                    name=payload.get("name") or None,
                    display=int(payload["display"]) if payload.get("display") not in {None, ""} else None,
                    audio=bool(payload.get("audio", False)),
                    cursor=bool(payload.get("cursor", True)),
                    show_clicks=bool(payload.get("show_clicks", True)),
                    duration=float(payload["duration"]) if payload.get("duration") not in {None, ""} else None,
                )
                self.send_json({"ok": True, "session": session})
                return
            if parsed.path == "/api/record/stop":
                payload = self.read_json_body()
                session = stop_session(self.root, timeout=float(payload.get("timeout", 20)))
                result: dict[str, object] = {"ok": True, "session": session}
                if payload.get("render", False):
                    output = Path(session["run_dir"]) / str(payload.get("output", "final.mp4"))
                    options = RenderOptions(
                        crf=int(payload.get("crf", 18)),
                        preset=str(payload.get("preset", "medium")),
                        canvas=payload.get("canvas") or None,
                        background=str(payload.get("background", "#f3f0ea")),
                    )
                    render_video(Path(session["raw_video"]), Path(session["events_file"]), output, options=options)
                    result["output"] = str(output)
                self.send_json(result)
                return
            if parsed.path.startswith("/api/runs/") and parsed.path.endswith("/render"):
                name = parsed.path.removeprefix("/api/runs/").removesuffix("/render").strip("/")
                run_dir = safe_run_dir(self.root, name)
                payload = self.read_json_body()
                session_file = run_dir / "session.json"
                if session_file.exists():
                    session = read_json(session_file)
                    raw_video = Path(session["raw_video"])
                    events_file = Path(session["events_file"])
                else:
                    raw_video = run_dir / "raw.mov"
                    events_file = run_dir / "events.json"
                output = run_dir / str(payload.get("output", "final.mp4"))
                options = RenderOptions(
                    crf=int(payload.get("crf", 18)),
                    preset=str(payload.get("preset", "medium")),
                    canvas=payload.get("canvas") or None,
                    background=str(payload.get("background", "#f3f0ea")),
                )
                render_video(raw_video, events_file, output, options=options)
                self.send_json({"ok": True, "output": str(output)})
                return
            self.send_error_json("Not found", status=404)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)

    def serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            requested = "index.html"
        elif path == "/debug":
            requested = "debug.html"
        else:
            requested = path.lstrip("/")
        file_path = (WEB_DIR / requested).resolve()
        if not str(file_path).startswith(str(WEB_DIR.resolve())) or not file_path.exists():
            self.send_error(404)
            return
        content = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        # Editor is dev-only; never let the browser cache app.js/styles.css/index.html
        # so iteration is instant on reload.
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.add_cors_headers()
        self.end_headers()
        self.wfile.write(content)

    def serve_file(self, file_path: Path) -> None:
        size = file_path.stat().st_size
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        range_header = self.headers.get("Range")

        if range_header and range_header.startswith("bytes="):
            start_s, _, end_s = range_header.removeprefix("bytes=").partition("-")
            start = int(start_s or "0")
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.add_cors_headers()
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.add_cors_headers()
            self.end_headers()
            with file_path.open("rb") as f:
                f.seek(start)
                self.wfile.write(f.read(length))
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.add_cors_headers()
        self.end_headers()
        with file_path.open("rb") as f:
            self.wfile.write(f.read())


def run_editor(root: Path, *, host: str = "127.0.0.1", port: int = 8765) -> None:
    class BoundHandler(EditorHandler):
        pass

    BoundHandler.root = root.resolve()
    server = ThreadingHTTPServer((host, port), BoundHandler)
    print(f"Timeline editor: http://{host}:{port}")
    print(f"Project root: {root.resolve()}")
    server.serve_forever()
