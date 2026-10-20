"""Workers AI and SystemOne backends against a mocked HTTP server."""

import asyncio
import io
import json

import httpx
import pytest
from PIL import Image

from clefcam.config import Settings
from clefcam.engines import EngineError
from clefcam.engines.remote import SystemOneEngine, WorkersAIEngine
from clefcam.imaging import Picture

QUESTIONS = {"urgent": {"type": "noul", "instructions": "Urgent?"}}
ANSWERS = {"urgent": {"type": "noul", "noul": 0.91}}


def picture():
    buffer = io.BytesIO()
    Image.new("RGB", (352, 256)).save(buffer, format="JPEG")
    return Picture.from_bytes(buffer.getvalue())


def run(engine, handler, pictures=()):
    seen = []

    def record(request):
        seen.append(request)
        return handler(request)

    engine._client = httpx.AsyncClient(transport=httpx.MockTransport(record))

    async def go():
        try:
            return await engine.decide("state", QUESTIONS, list(pictures))
        finally:
            await engine.close()

    return asyncio.run(go()), seen


def test_workers_ai_request_and_envelope():
    engine = WorkersAIEngine(Settings(cloudflare_account_id="acct", cloudflare_api_token="tok"))
    envelope = {"result": {"model": "clef-flash", "answers": ANSWERS, "usage": {"input_tokens": 99}}, "success": True, "errors": []}
    decision, seen = run(engine, lambda r: httpx.Response(200, json=envelope), [picture()])
    request = seen[0]
    assert str(request.url) == "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash"
    assert request.headers["authorization"] == "Bearer tok"
    body = json.loads(request.content)
    assert body["model"] == "clef-flash" and body["questions"] == QUESTIONS
    assert body["images"][0].startswith("data:image/jpeg;base64,")
    assert decision.answers == ANSWERS and decision.usage["input_tokens"] == 99


def test_workers_ai_errors():
    engine = WorkersAIEngine(Settings(cloudflare_account_id="a", cloudflare_api_token="t"))
    failure = {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}], "result": None}
    with pytest.raises(EngineError) as error:
        run(engine, lambda r: httpx.Response(401, json=failure))
    assert error.value.status == 401 and "Authentication error" in str(error.value)


def test_workers_ai_needs_credentials():
    with pytest.raises(SystemExit):
        WorkersAIEngine(Settings())


def test_systemone_url_and_plain_body():
    engine = SystemOneEngine(Settings(systemone_url="http://gpu:30000", systemone_token="s"))
    decision, seen = run(engine, lambda r: httpx.Response(200, json={"model": "Cloudflare/clef-flash", "answers": ANSWERS}))
    assert str(seen[0].url) == "http://gpu:30000/v1/systemone"
    assert json.loads(seen[0].content)["model"] == "Cloudflare/clef-flash"
    assert decision.answers == ANSWERS


def test_systemone_unreachable():
    engine = SystemOneEngine(Settings(systemone_url="http://gpu:30000/v1/systemone"))

    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(EngineError) as error:
        run(engine, refuse)
    assert error.value.status == 502 and "gpu:30000" in str(error.value)


def test_auto_backend_order(tmp_path):
    assert Settings(model_dir=tmp_path).resolved_backend() == "demo"
    assert Settings(model_dir=tmp_path, systemone_url="http://x").resolved_backend() == "systemone"
    assert Settings(model_dir=tmp_path, cloudflare_account_id="a", cloudflare_api_token="t").resolved_backend() == "workers-ai"
    (tmp_path / "joint_schema_model.py").write_text("")
    (tmp_path / "config.json").write_text("{}")
    assert Settings(model_dir=tmp_path, cloudflare_account_id="a", cloudflare_api_token="t").resolved_backend() == "local"
