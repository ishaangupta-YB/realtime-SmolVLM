"""HTTP and WebSocket API, plus the page.

* ``GET  /``             the live page (static files from ``web/``)
* ``GET  /api/info``     which backend is answering, and whether it is ready
* ``WS   /api/stream``   live decisions on a stream of frames (protocol below)
* ``POST /v1/systemone`` a SystemOne-compatible endpoint (same body as ``@cf/cloudflare/clef-flash``)

Stream protocol. The page sends JSON text messages and binary frames:

* ``{"type": "config", "questions": {...}, "state": ...}`` sets what to ask; answered with
  ``{"type": "config", "ok": true}`` or ``{"ok": false, "errors": [{"path", "message"}]}``.
* a binary message is one frame: a 4-byte big-endian sequence number, then JPEG/PNG/WebP bytes.
* ``{"type": "tick", "seq": n}`` asks once without an image (text-only state).

Each connection keeps only its newest unanswered frame. While the model is busy, newer frames
replace older ones, so the backlog never grows and every answer is about a recent frame. The server
replies ``started`` when it takes a frame (with how long it expects to take) and ``result`` or
``error`` when done; the page uses ``started`` to time its next capture so the model never idles.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .engines import Decision, EngineError, create_engine
from .imaging import MAX_IMAGES, ImageError, Picture
from .schema import SchemaError, validate_questions, validate_state

log = logging.getLogger("clefcam")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
DEFAULT_STATE = "A live frame from a webcam."


class Host:
    """Owns the engine and its readiness. Requests to a non-concurrent engine run in arrival order."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.engine = create_engine(settings)
        self.status = "loading"
        self.error: str | None = None
        self.ready = asyncio.Event()
        self._turn = None if self.engine.concurrent else asyncio.Lock()

    async def start(self) -> None:
        try:
            await self.engine.load()
            self.status = "ready"
        except Exception as error:  # surfaced in /api/info and on the page
            log.exception("backend failed to start")
            self.status, self.error = "failed", f"{type(error).__name__}: {error}"
        finally:
            self.ready.set()

    async def decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        if self.status != "ready":
            raise EngineError(self.error or "the model is still loading", 503)
        if self._turn is None:
            return await self.engine.decide(state, questions, pictures)
        async with self._turn:
            return await self.engine.decide(state, questions, pictures)

    def describe(self) -> dict[str, Any]:
        info = self.engine.info
        return {
            "status": self.status,
            "error": self.error,
            "backend": info.kind,
            "model": info.model,
            "where": info.where,
            "device": info.device,
            "dtype": info.dtype,
            "synthetic": info.synthetic,
            "notes": info.notes,
            "limits": {"max_side": self.settings.max_side, "max_questions": 64, "max_images": MAX_IMAGES},
        }


class StreamSession:
    def __init__(self, socket: WebSocket, host: Host):
        self.socket = socket
        self.host = host
        self.questions: dict[str, Any] | None = None
        self.state: Any = DEFAULT_STATE
        self.slot: tuple[int, bytes | None, float] | None = None
        self.dropped = 0
        self.wake = asyncio.Event()
        self.expected_ms: float | None = None
        self._send_lock = asyncio.Lock()

    async def send(self, message: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.socket.send_text(json.dumps(message, separators=(",", ":")))

    async def run(self) -> None:
        await self.send({"type": "hello", "engine": self.host.describe()})
        tasks = [asyncio.create_task(self._consume())]
        if not self.host.ready.is_set():
            tasks.append(asyncio.create_task(self._announce_ready()))
        try:
            await self._receive()
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    async def _announce_ready(self) -> None:
        await self.host.ready.wait()
        await self.send({"type": "engine", "engine": self.host.describe()})

    async def _receive(self) -> None:
        while True:
            message = await self.socket.receive()
            if message["type"] == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is not None:
                if len(data) < 5:
                    await self.send({"type": "error", "message": "a frame is a 4-byte sequence number followed by image bytes"})
                    continue
                self._offer(int.from_bytes(data[:4], "big"), data[4:])
                continue
            try:
                payload = json.loads(message.get("text") or "")
            except ValueError:
                await self.send({"type": "error", "message": "messages must be JSON"})
                continue
            await self._command(payload if isinstance(payload, dict) else {})

    def _offer(self, seq: int, image: bytes | None) -> None:
        if self.slot is not None:
            self.dropped += 1
        self.slot = (seq, image, time.perf_counter())
        self.wake.set()

    async def _command(self, payload: dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind == "config":
            try:
                if "questions" in payload:
                    questions = validate_questions(payload["questions"])
                else:
                    questions = self.questions
                state = validate_state(payload["state"]) if "state" in payload else self.state
            except SchemaError as error:
                await self.send({"type": "config", "ok": False, "errors": error.as_json()})
                return
            self.questions, self.state = questions, state
            await self.send({"type": "config", "ok": True, "questions": len(questions or {})})
        elif kind == "tick":
            seq = payload.get("seq")
            self._offer(seq if isinstance(seq, int) else 0, None)
        elif kind == "ping":
            await self.send({"type": "pong", "t": payload.get("t")})
        else:
            await self.send({"type": "error", "message": f"unknown message type {kind!r}"})

    async def _consume(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            await self.host.ready.wait()
            if self.slot is None:
                continue
            seq, image, received = self.slot
            self.slot, dropped, self.dropped = None, self.dropped, 0
            if self.questions is None:
                await self.send({"type": "error", "seq": seq, "message": "send a config with questions first"})
                continue
            begun = time.perf_counter()
            await self.send({"type": "started", "seq": seq, "expected_ms": self.expected_ms})
            try:
                pictures = [Picture.from_bytes(image).fitted(self.host.settings.max_side)] if image else []
                decision = await self.host.decide(self.state, self.questions, pictures)
            except (ImageError, EngineError) as error:
                await self.send({"type": "error", "seq": seq, "message": str(error)})
                continue
            done = time.perf_counter()
            took = (done - begun) * 1000
            self.expected_ms = took if self.expected_ms is None else 0.7 * self.expected_ms + 0.3 * took
            await self.send(
                {
                    "type": "result",
                    "seq": seq,
                    "model": decision.model,
                    "answers": decision.answers,
                    "usage": decision.usage,
                    "dropped": dropped,
                    "image": {"width": pictures[0].width, "height": pictures[0].height} if pictures else None,
                    "timing": {
                        "wait_ms": round((begun - received) * 1000, 1),
                        "prep_ms": round(decision.prep_ms, 1),
                        "model_ms": round(decision.model_ms, 1),
                        "server_ms": round((done - received) * 1000, 1),
                    },
                }
            )


def _bad_request(message: str, errors: list[dict[str, str]] | None = None, status: int = 400) -> JSONResponse:
    body: dict[str, Any] = {"detail": message}
    if errors:
        body["errors"] = errors
    return JSONResponse(body, status_code=status)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    host = Host(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        starting = asyncio.create_task(host.start())
        try:
            yield
        finally:
            starting.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await starting
            await host.engine.close()

    app = FastAPI(title="clef-flash live", lifespan=lifespan, docs_url="/api/docs", redoc_url=None)
    app.state.host = host

    @app.get("/api/info")
    async def info() -> dict[str, Any]:
        return host.describe()

    @app.post("/v1/systemone")
    async def systemone(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return _bad_request("body must be JSON")
        if not isinstance(body, dict):
            return _bad_request("body must be a JSON object")
        try:
            questions = validate_questions(body.get("questions"))
            state = validate_state(body.get("state"))
        except SchemaError as error:
            return _bad_request(str(error), error.as_json())
        images = body.get("images") or []
        if not isinstance(images, list) or len(images) > MAX_IMAGES:
            return _bad_request(f"images must be a list of at most {MAX_IMAGES} data URLs")
        try:
            pictures = [Picture.from_any(image).fitted(settings.max_side) for image in images]
            decision = await host.decide(state, questions, pictures)
        except ImageError as error:
            return _bad_request(str(error))
        except EngineError as error:
            return _bad_request(str(error), status=error.status)
        timing = f"prep;dur={decision.prep_ms:.1f}, model;dur={decision.model_ms:.1f}"
        return JSONResponse(decision.body(), headers={"Server-Timing": timing})

    @app.websocket("/api/stream")
    async def stream(socket: WebSocket) -> None:
        await socket.accept()
        with contextlib.suppress(WebSocketDisconnect):
            await StreamSession(socket, host).run()

    @app.middleware("http")
    async def revalidate_static(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith(("/api", "/v1")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
