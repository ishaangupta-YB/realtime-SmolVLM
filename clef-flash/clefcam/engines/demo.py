"""Synthetic answers for trying the interface without the model. Nothing here looks at meaning.

Probabilities drift smoothly over time and react to how bright the frame is and how much it changed
since the last one, so the page has something live to show. The page labels this backend clearly.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import math
import time
from typing import Any

from PIL import Image, ImageStat

from ..imaging import Picture
from .base import Decision, Engine, EngineInfo


def _seed(*parts: str) -> float:
    digest = hashlib.blake2s("\x1f".join(parts).encode(), digest_size=4).digest()
    return int.from_bytes(digest, "big") / 2**32


def _softmax(values: list[float]) -> list[float]:
    top = max(values)
    exps = [math.exp(v - top) for v in values]
    total = sum(exps)
    return [e / total for e in exps]


def build_answer(question: dict[str, Any], probabilities: dict[str, float]) -> dict[str, Any]:
    """SystemOne answer for one question, in the same shape the model returns."""
    kind = question["type"]
    if kind == "noul":
        return {"type": "noul", "noul": round(probabilities["true"], 4)}
    if kind == "choice":
        options = list(question["criteria"])
        choice = max(options, key=probabilities.__getitem__)
        return {
            "type": "choice",
            "choice": choice,
            "confidence": round(probabilities[choice], 4),
            "probabilities": {option: round(probabilities[option], 4) for option in options},
        }
    levels = [str(index) for index in range(len(question["criteria"]))]
    return {
        "type": "score",
        "score": round(sum(index * probabilities[level] for index, level in enumerate(levels)), 4),
        "confidence": round(max(probabilities.values()), 4),
        "legend": dict(zip(levels, question["criteria"])),
        "probabilities": {level: round(probabilities[level], 4) for level in levels},
    }


class DemoEngine(Engine):
    def __init__(self) -> None:
        self.info = EngineInfo(
            kind="demo",
            model="synthetic",
            where="no model loaded",
            synthetic=True,
            notes=["answers are synthetic: set up a real backend to get decisions"],
        )
        self._previous: list[float] | None = None

    def _frame_signal(self, picture: Picture | None) -> tuple[float, float]:
        if picture is None:
            return 0.5, 0.0
        with Image.open(io.BytesIO(picture.data)) as image:
            image.draft("L", (64, 48))  # JPEG decodes straight to a small grayscale image
            small = image.convert("L").resize((16, 12))
        pixels = list(small.tobytes())
        brightness = ImageStat.Stat(small).mean[0] / 255
        motion = 0.0
        if self._previous is not None and len(self._previous) == len(pixels):
            motion = sum(abs(a - b) for a, b in zip(pixels, self._previous)) / (len(pixels) * 255)
        self._previous = pixels
        return brightness, min(1.0, motion * 6)

    async def decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        started = time.perf_counter()
        brightness, motion = self._frame_signal(pictures[0] if pictures else None)
        now = time.time()
        answers = {}
        for question_id, question in questions.items():
            kind = question["type"]
            if kind == "noul":
                options = ["true", "false"]
            elif kind == "choice":
                options = list(question["criteria"])
            else:
                options = [str(i) for i in range(len(question["criteria"]))]
            logits = []
            for option in options:
                phase = _seed(question_id, option) * math.tau
                speed = 0.15 + 0.35 * _seed(option, question_id)
                logits.append(
                    1.6 * math.sin(now * speed + phase)
                    + 2.2 * (brightness - 0.5) * math.cos(phase)
                    + 2.5 * motion * math.sin(phase * 3)
                )
            answers[question_id] = build_answer(question, dict(zip(options, _softmax(logits))))
        await asyncio.sleep(0.045)  # paced like a fast backend, so the page behaves realistically
        tokens = 40 + sum(12 + 6 * len(q.get("criteria") or [0, 0]) for q in questions.values())
        if pictures:
            tokens += (pictures[0].width // 32) * (pictures[0].height // 32) + 3
        return Decision(
            model="synthetic",
            answers=answers,
            usage={"input_tokens": tokens, "output_tokens": 0},
            model_ms=(time.perf_counter() - started) * 1000,
        )
