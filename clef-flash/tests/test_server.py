"""HTTP and stream protocol, against the demo backend (no model needed)."""

import asyncio
import base64
import io
import json
import struct

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from clefcam.config import Settings
from clefcam.engines import Decision
from clefcam.server import create_app

QUESTIONS = {
    "present": {"type": "noul", "instructions": "Is someone there?"},
    "mood": {"type": "choice", "criteria": {"happy": None, "neutral": None, "tired": None}},
    "energy": {"type": "score", "criteria": ["low", "medium", "high"]},
}


def jpeg(width=640, height=480):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (90, 30, 160)).save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def client():
    with TestClient(create_app(Settings(backend="demo"))) as test_client:
        yield test_client


def check_answers(answers):
    assert set(answers) == set(QUESTIONS)
    assert 0 <= answers["present"]["noul"] <= 1
    assert answers["mood"]["choice"] in QUESTIONS["mood"]["criteria"]
    assert abs(sum(answers["mood"]["probabilities"].values()) - 1) < 1e-3
    assert 0 <= answers["energy"]["score"] <= 2
    assert answers["energy"]["legend"] == {"0": "low", "1": "medium", "2": "high"}


def test_info(client):
    info = client.get("/api/info").json()
    assert info["backend"] == "demo" and info["synthetic"] and info["status"] == "ready"
    assert client.get("/").status_code == 200


def test_systemone(client):
    image = "data:image/jpeg;base64," + base64.b64encode(jpeg()).decode()
    response = client.post("/v1/systemone", json={"model": "clef-flash", "state": "x", "questions": QUESTIONS, "images": [image]})
    assert response.status_code == 200, response.text
    assert "model;dur=" in response.headers["server-timing"]
    body = response.json()
    check_answers(body["answers"])
    assert body["usage"]["input_tokens"] > 0


def test_systemone_rejects_bad_input(client):
    response = client.post("/v1/systemone", json={"state": "x", "questions": {"q": {"type": "choice", "criteria": {"a": None}}}})
    assert response.status_code == 400
    assert response.json()["errors"][0]["path"] == "questions.q.criteria"
    assert client.post("/v1/systemone", json={"state": "x", "questions": QUESTIONS, "images": ["https://x/y.jpg"]}).status_code == 400
    assert client.post("/v1/systemone", content=b"nope", headers={"content-type": "application/json"}).status_code == 400


def frame(seq, data):
    return struct.pack(">I", seq) + data


def receive(socket, kind):
    while True:
        message = socket.receive_json()
        if message["type"] == kind:
            return message
        assert message["type"] != "error", message


def test_stream(client):
    with client.websocket_connect("/api/stream") as socket:
        hello = socket.receive_json()
        assert hello["type"] == "hello" and hello["engine"]["status"] == "ready"

        socket.send_text(json.dumps({"type": "config", "questions": {"q": {"type": "score", "criteria": ["one"]}}}))
        rejected = receive(socket, "config")
        assert not rejected["ok"] and rejected["errors"][0]["path"] == "questions.q.criteria"

        socket.send_text(json.dumps({"type": "config", "questions": QUESTIONS, "state": "A webcam."}))
        assert receive(socket, "config")["ok"]

        socket.send_bytes(frame(7, jpeg(1280, 720)))
        assert receive(socket, "started")["seq"] == 7
        result = receive(socket, "result")
        assert result["seq"] == 7
        check_answers(result["answers"])
        assert result["image"] == {"width": 640, "height": 352}  # capped at CLEFCAM_MAX_SIDE, on the 32 px grid
        assert set(result["timing"]) == {"wait_ms", "prep_ms", "model_ms", "server_ms"}

        socket.send_text(json.dumps({"type": "tick", "seq": 8}))
        text_only = receive(socket, "result")
        assert text_only["seq"] == 8 and text_only["image"] is None

        socket.send_bytes(frame(9, b"not an image"))
        message = socket.receive_json()
        while message["type"] != "error":
            message = socket.receive_json()
        assert message["seq"] == 9 and "image" in message["message"]


class SlowEngine:
    """Records which frames it was asked about."""

    def __init__(self, engine):
        self.engine, self.seen = engine, []

    async def decide(self, state, questions, pictures):
        self.seen.append(pictures[0].width if pictures else None)
        await asyncio.sleep(0.3)
        return Decision("test", {q: {"type": "noul", "noul": 0.5} for q in questions}, {"input_tokens": 1})


def test_newest_frame_wins(client):
    host = client.app.state.host
    host.engine.decide = SlowEngine(host.engine).decide
    with client.websocket_connect("/api/stream") as socket:
        socket.receive_json()
        socket.send_text(json.dumps({"type": "config", "questions": {"q": {"type": "noul"}}}))
        receive(socket, "config")
        socket.send_bytes(frame(1, jpeg(320, 256)))
        receive(socket, "started")
        # While frame 1 runs, three more arrive; only the newest may run next.
        for seq, width in ((2, 352), (3, 384), (4, 416)):
            socket.send_bytes(frame(seq, jpeg(width, 256)))
        assert receive(socket, "result")["seq"] == 1
        nxt = receive(socket, "started")
        assert nxt["seq"] == 4 and nxt["expected_ms"] > 0
        result = receive(socket, "result")
        assert result["seq"] == 4 and result["dropped"] == 2
