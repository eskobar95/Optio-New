#!/usr/bin/env python3
"""CPU placeholder for the optional Compose profile `laya`.

Upstream Laya (https://github.com/NandhaKishorM/laya) ships `laya-serve`, a
Jev-compatible `POST /v1/systemone` server. That project publishes no registry
image; the CPU quickstart is a local image build. This process is the stand-in
so `--profile laya` can start, pass its healthcheck, and be targeted by the
JevRouter `laya` plugin without torch, checkpoints, or the NVIDIA Container
Toolkit.

It always answers `choice: deny`. Hop 2 stays fail-closed until an operator
replaces this command with real `laya-serve`. No API key is invented. When
`LAYA_API_KEY` is set, `POST /v1/systemone` requires `Authorization: Bearer`.
`GET /health` and `GET /healthz` stay open, matching upstream.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_BODY = 64 * 1024


def api_key() -> str:
    return os.environ.get("LAYA_API_KEY", "").strip()


def health_payload() -> dict:
    requested = os.environ.get("LAYA_DEVICE", "cpu").strip() or "cpu"
    body = {
        "status": "ok",
        "service": "laya",
        "device": "cpu",
        "engine": "placeholder",
        "nvidia_required": False,
        "auth_required": bool(api_key()),
        "preload": os.environ.get("LAYA_PRELOAD", ""),
        "threads": os.environ.get("LAYA_THREADS", ""),
    }
    if requested != "cpu":
        body["device_requested"] = requested
        body["device_note"] = "profile laya is CPU-only; NVIDIA toolkit is not used"
    return body


def decision_payload(body: dict) -> dict:
    questions = body.get("questions")
    keys: list[str] = []
    if isinstance(questions, dict):
        keys = [key for key in questions if isinstance(key, str)]
    if "hop2" not in keys:
        keys.append("hop2")
    answers = {
        key: {
            "type": "choice",
            "choice": "deny",
            "confidence": 0.0,
            "probabilities": {"deny": 1.0},
        }
        for key in keys
    }
    return {
        "model": "laya-placeholder",
        "placeholder": True,
        "device": "cpu",
        "nvidia_required": False,
        "answers": answers,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            self._json(200, health_payload())
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/v1/systemone":
            self._json(404, {"error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"error": "unauthorized"})
            return
        length_raw = self.headers.get("Content-Length", "0")
        try:
            length = int(length_raw)
        except ValueError:
            self._json(400, {"error": "malformed_json"})
            return
        if length < 0 or length > MAX_BODY:
            self._json(413, {"error": "too_large"})
            return
        raw = self.rfile.read(length) if length else b""
        try:
            parsed = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "malformed_json"})
            return
        if not isinstance(parsed, dict):
            self._json(400, {"error": "malformed_json"})
            return
        self._json(200, decision_payload(parsed))

    def _authorized(self) -> bool:
        expected = api_key()
        if not expected:
            return True
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix) :].strip(), expected)

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(
            json.dumps(
                {
                    "service": "laya",
                    "event": "http",
                    "message": fmt % args,
                }
            )
            + "\n"
        )


def listen_port() -> int:
    raw = os.environ.get("LAYA_PORT", "8000").strip() or "8000"
    try:
        port = int(raw)
    except ValueError as error:
        raise SystemExit(f"LAYA_PORT must be an integer, got {raw!r}") from error
    if port < 0 or port > 65535:
        raise SystemExit(f"LAYA_PORT out of range: {port}")
    return port


def main() -> None:
    host = os.environ.get("LAYA_HOST", "0.0.0.0").strip() or "0.0.0.0"
    port = listen_port()
    server = ThreadingHTTPServer((host, port), Handler)
    bound_host, bound_port = server.server_address[:2]
    sys.stdout.write(
        json.dumps({"service": "laya", "event": "listen", "host": bound_host, "port": bound_port})
        + "\n"
    )
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
