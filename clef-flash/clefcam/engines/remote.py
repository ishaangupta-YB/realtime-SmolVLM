"""Hosted clef-flash: Cloudflare Workers AI, or any server that speaks POST /v1/systemone (e.g. SGLang).

Both accept the same SystemOne body, with images as base64 data URLs placed before the state.
Frames arrive from the page already JPEG-encoded at the right size, so they are forwarded as-is.
"""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config import Settings
from ..imaging import Picture
from .base import Decision, Engine, EngineError, EngineInfo


def _error_message(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return response.text[:300] or response.reason_phrase
    errors = data.get("errors") if isinstance(data, dict) else None
    if errors:
        return "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)
    if isinstance(data, dict):
        detail = data.get("detail") or data.get("error") or data.get("message")
        if detail:
            return str(detail)
    return response.reason_phrase


class _HttpEngine(Engine):
    url: str
    headers: dict[str, str]
    request_model: str

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=8, keepalive_expiry=60),
        )

    def _unwrap(self, data: Any) -> dict[str, Any]:
        return data

    async def decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        body: dict[str, Any] = {"model": self.request_model, "state": state, "questions": questions}
        if pictures:
            body["images"] = [picture.data_url() for picture in pictures]
        started = time.perf_counter()
        try:
            response = await self._client.post(self.url, json=body, headers=self.headers)
        except httpx.HTTPError as error:
            raise EngineError(f"cannot reach {urlparse(self.url).netloc}: {error}", 502) from error
        elapsed = (time.perf_counter() - started) * 1000
        if response.status_code >= 400:
            status = response.status_code if response.status_code < 500 else 502
            raise EngineError(f"{self.info.kind} returned {response.status_code}: {_error_message(response)}", status)
        try:
            data = self._unwrap(response.json())
        except ValueError as error:
            raise EngineError(f"{self.info.kind} returned a body that is not JSON", 502) from error
        if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
            raise EngineError(f"{self.info.kind} returned no answers", 502)
        return Decision(
            model=str(data.get("model") or self.request_model),
            answers=data["answers"],
            usage=data.get("usage") or {},
            model_ms=elapsed,  # includes the network; the remote does not report its own timing
        )

    async def close(self) -> None:
        await self._client.aclose()


class WorkersAIEngine(_HttpEngine):
    def __init__(self, settings: Settings):
        if not settings.has_workers_credentials:
            raise SystemExit("the workers-ai backend needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
        super().__init__()
        model = settings.workers_model
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{settings.cloudflare_account_id}/ai/run/{model}"
        self.headers = {"Authorization": f"Bearer {settings.cloudflare_api_token}"}
        # The body's model field selects the variant: "clef" or "clef-flash".
        self.request_model = model.rsplit("/", 1)[-1]
        self.info = EngineInfo(
            kind="workers-ai",
            model=self.request_model,
            where="Cloudflare Workers AI",
            notes=[f"{model}", "latency includes the network round trip"],
        )

    def _unwrap(self, data: Any) -> dict[str, Any]:
        # The REST API wraps results: {"result": {...}, "success": true, "errors": [], ...}
        if isinstance(data, dict) and "result" in data:
            if data.get("success") is False:
                errors = data.get("errors") or ["request failed"]
                messages = [str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors]
                raise EngineError("Workers AI: " + "; ".join(messages))
            return data["result"]
        return data


class SystemOneEngine(_HttpEngine):
    def __init__(self, settings: Settings):
        if not settings.systemone_url:
            raise SystemExit("the systemone backend needs CLEFCAM_SYSTEMONE_URL (for example http://localhost:30000)")
        super().__init__()
        base = settings.systemone_url
        self.url = base if base.endswith("/v1/systemone") else f"{base}/v1/systemone"
        self.headers = {"Authorization": f"Bearer {settings.systemone_token}"} if settings.systemone_token else {}
        self.request_model = settings.systemone_model
        self.info = EngineInfo(
            kind="systemone",
            model=self.request_model,
            where=urlparse(self.url).netloc,
            notes=["latency includes the network round trip"],
        )
