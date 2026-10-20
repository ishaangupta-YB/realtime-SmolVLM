from __future__ import annotations

from ..config import Settings
from .base import Decision, Engine, EngineError, EngineInfo


def create_engine(settings: Settings) -> Engine:
    backend = settings.resolved_backend()
    if backend == "local":
        from .local import LocalEngine

        return LocalEngine(settings)
    if backend == "workers-ai":
        from .remote import WorkersAIEngine

        return WorkersAIEngine(settings)
    if backend == "systemone":
        from .remote import SystemOneEngine

        return SystemOneEngine(settings)
    from .demo import DemoEngine

    return DemoEngine()


__all__ = ["Decision", "Engine", "EngineError", "EngineInfo", "create_engine"]
