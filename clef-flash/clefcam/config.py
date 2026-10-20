"""Settings, read once from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
BACKENDS = ("auto", "local", "workers-ai", "systemone", "demo")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _int(name: str, default: int, low: int, high: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer, got {raw!r}") from error
    if not low <= value <= high:
        raise SystemExit(f"{name} must be between {low} and {high}, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    backend: str = "auto"
    host: str = "127.0.0.1"
    port: int = 8765

    # local
    model_dir: Path = PROJECT_DIR / "weights" / "clef-flash"
    device: str = "auto"
    dtype: str = "bfloat16"
    fast_kernel: bool = True

    # Largest image side the server accepts; the page picks its own size up to this.
    max_side: int = 640

    # Workers AI
    cloudflare_account_id: str = ""
    cloudflare_api_token: str = field(default="", repr=False)
    workers_model: str = "@cf/cloudflare/clef-flash"

    # any server exposing POST /v1/systemone (SGLang, another clefcam, ...)
    systemone_url: str = ""
    systemone_model: str = "Cloudflare/clef-flash"
    systemone_token: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> "Settings":
        backend = _env("CLEFCAM_BACKEND", "auto").lower()
        if backend not in BACKENDS:
            raise SystemExit(f"CLEFCAM_BACKEND must be one of {', '.join(BACKENDS)}, got {backend!r}")
        device = _env("CLEFCAM_DEVICE", "auto").lower()
        if device not in ("auto", "cuda", "mps", "cpu"):
            raise SystemExit(f"CLEFCAM_DEVICE must be auto, cuda, mps or cpu, got {device!r}")
        dtype = _env("CLEFCAM_DTYPE", "bfloat16").lower()
        if dtype not in ("bfloat16", "float16", "float32"):
            raise SystemExit(f"CLEFCAM_DTYPE must be bfloat16, float16 or float32, got {dtype!r}")
        model_dir = Path(_env("CLEFCAM_MODEL_DIR") or cls.model_dir).expanduser()
        if not model_dir.is_absolute():
            model_dir = (Path.cwd() / model_dir).resolve()
        return cls(
            backend=backend,
            host=_env("CLEFCAM_HOST", "127.0.0.1"),
            port=_int("CLEFCAM_PORT", 8765, 1, 65535),
            model_dir=model_dir,
            device=device,
            dtype=dtype,
            fast_kernel=_env("CLEFCAM_FAST_KERNEL", "1") not in ("0", "false", "no", "off"),
            max_side=_int("CLEFCAM_MAX_SIDE", 640, 256, 2048),
            cloudflare_account_id=_env("CLOUDFLARE_ACCOUNT_ID"),
            cloudflare_api_token=_env("CLOUDFLARE_API_TOKEN"),
            workers_model=_env("CLEFCAM_WORKERS_MODEL", "@cf/cloudflare/clef-flash"),
            systemone_url=_env("CLEFCAM_SYSTEMONE_URL").rstrip("/"),
            systemone_model=_env("CLEFCAM_SYSTEMONE_MODEL", "Cloudflare/clef-flash"),
            systemone_token=_env("CLEFCAM_SYSTEMONE_TOKEN"),
        )

    @property
    def has_local_model(self) -> bool:
        return (self.model_dir / "joint_schema_model.py").is_file() and (self.model_dir / "config.json").is_file()

    @property
    def has_workers_credentials(self) -> bool:
        return bool(self.cloudflare_account_id and self.cloudflare_api_token)

    def resolved_backend(self) -> str:
        """Pick a backend for ``auto``: local weights, then Workers AI, then a SystemOne URL, then demo."""
        if self.backend != "auto":
            return self.backend
        if self.has_local_model:
            return "local"
        if self.has_workers_credentials:
            return "workers-ai"
        if self.systemone_url:
            return "systemone"
        return "demo"
