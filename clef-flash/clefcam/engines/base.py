from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..imaging import Picture


class EngineError(Exception):
    """A request the backend could not answer. ``status`` is the HTTP status to report."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


@dataclass
class Decision:
    model: str
    answers: dict[str, Any]
    usage: dict[str, Any]
    prep_ms: float = 0.0
    model_ms: float = 0.0

    def body(self) -> dict[str, Any]:
        """The SystemOne response body."""
        return {"model": self.model, "answers": self.answers, "usage": self.usage}


@dataclass
class EngineInfo:
    kind: str  # local | workers-ai | systemone | demo
    model: str
    where: str  # human-readable: hardware for local, host for remote
    device: str = ""
    dtype: str = ""
    synthetic: bool = False
    notes: list[str] = field(default_factory=list)


class Engine:
    """A backend that answers SystemOne requests. Subclasses implement ``load`` and ``decide``."""

    info: EngineInfo
    # Whether two requests may run at the same time. The local model runs one at a time.
    concurrent: bool = True

    async def load(self) -> None:
        """Prepare the backend (load weights, warm up, open connections)."""

    async def decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        raise NotImplementedError

    async def close(self) -> None:
        pass
