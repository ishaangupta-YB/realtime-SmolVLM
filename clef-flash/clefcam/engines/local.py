"""clef-flash on this machine through transformers (CUDA, Apple Silicon MPS, or CPU)."""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import platform
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from ..config import Settings
from ..imaging import Picture
from .base import Decision, Engine, EngineError, EngineInfo

log = logging.getLogger("clefcam")
MAX_TOKENS = 16384  # the release code's default context bound


def _load_release_module(model_dir: Path):
    """Import the model's own ``joint_schema_model.py`` under a private name."""
    path = model_dir / "joint_schema_model.py"
    spec = importlib.util.spec_from_file_location("clef_release_model", path)
    if spec is None or spec.loader is None:
        raise EngineError(f"cannot import {path}", 500)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # its dataclasses look themselves up here
    spec.loader.exec_module(module)
    return module


def _pick_device(requested: str) -> str:
    import torch

    if requested != "auto":
        if requested == "cuda" and not torch.cuda.is_available():
            raise SystemExit("CLEFCAM_DEVICE=cuda but CUDA is not available")
        if requested == "mps" and not torch.backends.mps.is_available():
            raise SystemExit("CLEFCAM_DEVICE=mps but MPS is not available")
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _hardware(device: str) -> str:
    """A short label for the inspector: the GPU's name, or the machine class and its memory."""
    import torch

    if device == "cuda":
        props = torch.cuda.get_device_properties(torch.cuda.current_device())
        return f"{props.name} · {props.total_memory / 1024**3:.0f} GB"
    memory = _memory_gb()
    size = f" · {memory:.0f} GB" if memory else ""
    if device == "mps":
        return f"Apple Silicon{size}"
    return f"{platform.machine() or 'CPU'} CPU{size}"


def _memory_gb() -> float | None:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except (ValueError, OSError, AttributeError):
        return None


class LocalEngine(Engine):
    concurrent = False

    def __init__(self, settings: Settings):
        self.settings = settings
        if not settings.has_local_model:
            raise SystemExit(
                f"clef-flash weights not found in {settings.model_dir}\n"
                f"download them with: uv run hf download Cloudflare/clef-flash --local-dir {settings.model_dir}"
            )
        # One thread owns the model: GPU work is serialized and never hops between threads.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clef-model")
        self.info = EngineInfo(kind="local", model="clef-flash", where="this machine")
        self._release: Any = None
        self._model: Any = None
        self._processor: Any = None
        self._device: Any = None

    async def load(self) -> None:
        await asyncio.get_running_loop().run_in_executor(self._executor, self._load)

    def _load(self) -> None:
        import torch

        device = _pick_device(self.settings.device)
        dtype = getattr(torch, self.settings.dtype)
        memory = _memory_gb()
        if memory is not None and memory < 30:
            log.warning("this machine reports %.0f GB of memory; clef-flash needs about 19 GB for weights alone", memory)

        started = time.perf_counter()
        self._release = _load_release_module(self.settings.model_dir)
        self._model, self._processor = self._release.load_release_model(self.settings.model_dir, device=device, dtype=dtype)
        self._device = torch.device(device)

        notes = []
        if self.settings.fast_kernel:
            notes.append(self._choose_linear_attention(device, dtype))
        self.info = EngineInfo(
            kind="local",
            model="clef-flash",
            where=_hardware(device),
            device=device,
            dtype=self.settings.dtype,
            notes=notes,
        )
        log.info("clef-flash loaded on %s (%s) in %.0fs", self.info.where, device, time.perf_counter() - started)

        # The first passes compile kernels and size buffers; do them before anyone is waiting.
        from PIL import Image

        # A 16:9 frame at the page's default detail, then a text-only request.
        frame = Image.linear_gradient("L").resize((352, 192)).convert("RGB")
        probe = {"lit": {"type": "noul", "instructions": "Is the scene lit?"}}
        self._decide("Start-up check.", probe, [Picture(b"", "image/jpeg", 352, 192, frame)])
        self._decide("Start-up check.", probe, [])

    def _choose_linear_attention(self, device: str, dtype: Any) -> str:
        """Use clefcam's linear attention only where it is measurably faster than transformers' fallback."""
        import torch

        from ..gated_delta import compare, install
        from transformers.utils.import_utils import is_flash_linear_attention_available

        if is_flash_linear_attention_available():
            return "flash-linear-attention kernels in use"
        fallback_ms, ours_ms = compare(torch.device(device), dtype)
        log.info("linear attention per layer: transformers %.1f ms, clefcam %.1f ms", fallback_ms, ours_ms)
        if ours_ms < fallback_ms:
            layers = install(self._model)
            return f"clefcam linear attention on {layers} layers ({fallback_ms / ours_ms:.1f}x faster than the fallback here)"
        return f"transformers linear attention kept (clefcam's was {ours_ms / fallback_ms:.1f}x slower here)"

    def _decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        import torch

        release, processor = self._release, self._processor
        started = time.perf_counter()
        record: dict[str, Any] = {"state": state, "questions": questions}
        if pictures:
            record["images"] = [picture.pil() for picture in pictures]
        try:
            encoded = release.encode_record(processor.tokenizer, record, max_length=MAX_TOKENS, processor=processor)
        except ValueError as error:
            raise EngineError(str(error), 400) from error
        batch = release.collate_records([encoded], processor.tokenizer.pad_token_id, self._device)
        prepared = time.perf_counter()

        with torch.inference_mode():
            logits = self._model(batch)[0]
            # Softmax on the device, then a single transfer (one sync instead of one per question).
            flat = torch.cat([question_logits.float().softmax(-1) for question_logits in logits]).tolist()
        finished = time.perf_counter()

        answers, offset = {}, 0
        for question in encoded.questions:
            count = len(question.option_ids)
            probabilities = dict(zip(question.option_ids, flat[offset : offset + count]))
            offset += count
            answers[question.question_id] = release.systemone_answer(questions[question.question_id], probabilities)
        return Decision(
            model="clef-flash",
            answers=answers,
            usage={"input_tokens": len(encoded.input_ids), "output_tokens": 0},
            prep_ms=(prepared - started) * 1000,
            model_ms=(finished - prepared) * 1000,
        )

    async def decide(self, state: Any, questions: dict[str, Any], pictures: list[Picture]) -> Decision:
        if self._model is None:
            raise EngineError("the model is still loading", 503)
        return await asyncio.get_running_loop().run_in_executor(self._executor, self._decide, state, questions, pictures)

    async def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
