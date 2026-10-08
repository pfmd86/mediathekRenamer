#!/usr/bin/env python3
"""Mediathek Renamer - local web app to rename file bundles.

A bundle is a set of files in one folder that share the same name and differ
only in their extension, e.g. "Episode 1.mp4", "Episode 1.srt", "Episode 1.txt".

Run:  python3 server.py [--port 8765] [--no-browser]
"""

import argparse
import json
import os
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATIC_DIR = Path(__file__).resolve().parent / "static"

VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".ts", ".flv", ".wmv", ".mpg", ".mpeg"}
INVALID_NAME_CHARS = set('/\\\0')


class ApiError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def split_name(filename):
    """Split a file name into (bundle name, extension). Hidden files have no extension."""
    stem, ext = os.path.splitext(filename)
    return stem, ext


def resolve_dir(raw_path):
    if not raw_path:
        raise ApiError("No folder given.")
    path = Path(os.path.expanduser(raw_path)).resolve()
    if not path.is_dir():
        raise ApiError(f"Not a folder: {path}", HTTPStatus.NOT_FOUND)
    return path


def browse(raw_path):
    path = resolve_dir(raw_path or str(Path.home()))
    dirs = []
    try:
        for entry in os.scandir(path):
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    dirs.append(entry.name)
            except OSError:
                pass
    except PermissionError:
        raise ApiError(f"Permission denied: {path}", HTTPStatus.FORBIDDEN)
    dirs.sort(key=str.casefold)
    parent = str(path.parent) if path.parent != path else None
    return {"path": str(path), "parent": parent, "dirs": dirs}


def scan(raw_path):
    path = resolve_dir(raw_path)
    bundles = {}
    try:
        entries = list(os.scandir(path))
    except PermissionError:
        raise ApiError(f"Permission denied: {path}", HTTPStatus.FORBIDDEN)
    for entry in entries:
        if entry.name.startswith(".") or not entry.is_file():
            continue
        stem, ext = split_name(entry.name)
        bundle = bundles.setdefault(stem, {"name": stem, "files": [], "hasVideo": False})
        bundle["files"].append({"name": entry.name, "ext": ext, "size": entry.stat().st_size})
        if ext.lower() in VIDEO_EXTS:
            bundle["hasVideo"] = True
    result = sorted(bundles.values(), key=lambda b: b["name"].casefold())
    for bundle in result:
        bundle["files"].sort(key=lambda f: f["ext"].casefold())
    return {"path": str(path), "bundles": result}


def validate_new_name(name):
    if not name or not name.strip():
        raise ApiError("The new name must not be empty.")
    if name != name.strip():
        raise ApiError("The new name must not start or end with whitespace.")
    if name in (".", "..") or name.startswith("."):
        raise ApiError("The new name must not start with a dot.")
    bad = INVALID_NAME_CHARS.intersection(name)
    if bad:
        raise ApiError("The new name contains invalid characters: " + " ".join(repr(c) for c in sorted(bad)))
    if len(name.encode("utf-8")) > 240:
        raise ApiError("The new name is too long.")


def rename_bundle(raw_path, old_name, new_name):
    path = resolve_dir(raw_path)
    validate_new_name(new_name)
    if old_name == new_name:
        return {"renamed": []}

    files = [
        entry.name for entry in os.scandir(path)
        if entry.is_file() and not entry.name.startswith(".") and split_name(entry.name)[0] == old_name
    ]
    if not files:
        raise ApiError(f'No files found for bundle "{old_name}". Reload the folder.', HTTPStatus.NOT_FOUND)

    # Refuse to merge into another existing bundle (a case-only rename of itself is fine).
    for entry in os.scandir(path):
        if (entry.is_file() and split_name(entry.name)[0] == new_name
                and not any(os.path.samefile(entry.path, path / f) for f in files)):
            raise ApiError(f'A bundle named "{new_name}" already exists. Nothing was renamed.', HTTPStatus.CONFLICT)

    plan = []
    for filename in files:
        ext = split_name(filename)[1]
        src = path / filename
        dst = path / (new_name + ext)
        # A target that is the source itself (case-only rename on a case-insensitive FS) is fine.
        if dst.exists() and not os.path.samefile(src, dst):
            raise ApiError(f'"{dst.name}" already exists. Nothing was renamed.', HTTPStatus.CONFLICT)
        plan.append((src, dst))

    done = []
    try:
        for src, dst in plan:
            os.rename(src, dst)
            done.append((src, dst))
    except OSError as exc:
        for src, dst in reversed(done):
            try:
                os.rename(dst, src)
            except OSError:
                pass
        raise ApiError(f"Renaming failed ({exc}). Changes were rolled back.", HTTPStatus.INTERNAL_SERVER_ERROR)

    return {"renamed": [{"from": s.name, "to": d.name} for s, d in done]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        # Guard against DNS rebinding: only accept requests addressed to localhost.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost", "::1")

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_api(self, func):
        if not self._host_ok():
            return self._send_json({"error": "Forbidden host."}, HTTPStatus.FORBIDDEN)
        try:
            self._send_json(func())
        except ApiError as exc:
            self._send_json({"error": str(exc)}, exc.status)
        except Exception as exc:  # noqa: BLE001 - report unexpected errors to the UI
            self._send_json({"error": f"Unexpected error: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_GET(self):
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/browse":
            return self._handle_api(lambda: browse(query.get("path")))
        if url.path == "/api/scan":
            return self._handle_api(lambda: scan(query.get("path")))
        if url.path.startswith("/api/"):
            return self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
        if not self._host_ok():
            return self.send_error(HTTPStatus.FORBIDDEN)
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/rename":
            return self._send_json({"error": "Not found."}, HTTPStatus.NOT_FOUND)
        # Requiring a JSON content type forces a CORS preflight for cross-site requests,
        # which this server never approves.
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._send_json({"error": "Expected JSON."}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)

        def run():
            length = int(self.headers.get("Content-Length") or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                raise ApiError("Invalid JSON.")
            return rename_bundle(data.get("path"), data.get("oldName", ""), data.get("newName", ""))

        return self._handle_api(run)


def main():
    parser = argparse.ArgumentParser(description="Mediathek Renamer web UI")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Mediathek Renamer running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
