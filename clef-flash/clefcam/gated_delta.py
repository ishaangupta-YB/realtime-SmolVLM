"""Gated delta rule for Qwen3.5 linear attention without the CUDA-only kernels.

When flash-linear-attention is missing (always on Apple Silicon and CPU), transformers runs a
reference chunked implementation. Depending on the version, its per-chunk triangular solve is a
Python loop over the 63 rows of every 64-token chunk (thousands of tiny kernel launches per
forward pass, where launch overhead dominates on MPS) or ``torch.linalg.solve_triangular``, whose
speed depends on the backend.

This module computes the same quantity with a fixed, small number of batched matmuls:

* Within a chunk, the delta rule's WY form needs ``W = (I + A)^-1`` for a strictly lower
  triangular ``A``. We build it by doubling: start from the identity (the inverse of the 1x1
  diagonal blocks) and, at each level, merge neighbouring diagonal blocks with
  ``W <- W - W (A * M) W``, where ``M`` keeps only the lower-left sub-blocks being merged.
  That is log2(chunk) levels of two dense batched matmuls each, for every chunk and head at once.
* Between chunks, the recurrent state is carried by a loop over chunks (not tokens), with the
  per-chunk terms precomputed outside it.

Everything runs in float32, like the reference. ``compare`` times both on the actual device so the
engine only installs this where it wins.
"""

from __future__ import annotations

from functools import lru_cache

import torch
import torch.nn.functional as F


def _l2_normalize(x: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    # Matches transformers' l2norm (and FLA): x / sqrt(sum(x^2) + eps).
    return x * torch.rsqrt(x.square().sum(dim=-1, keepdim=True) + eps)


@lru_cache(maxsize=16)
def _merge_masks(size: int, device: torch.device) -> tuple[torch.Tensor, ...]:
    """One 0/1 mask per doubling level, selecting the lower-left blocks merged at that level."""
    rows = torch.arange(size, device=device).unsqueeze(1)
    cols = torch.arange(size, device=device).unsqueeze(0)
    masks = []
    width = 1
    while width < size:
        row_block, col_block = rows // width, cols // width
        selected = (row_block % 2 == 1) & (col_block == row_block - 1)
        masks.append(selected.to(torch.float32))
        width *= 2
    return tuple(masks)


def invert_unit_triangular(strict_lower: torch.Tensor) -> torch.Tensor:
    """Return ``(I + L)^-1`` for a batch of strictly lower triangular ``L`` (size a power of two)."""
    size = strict_lower.shape[-1]
    if size & (size - 1):
        raise ValueError(f"matrix size must be a power of two, got {size}")
    inverse = torch.eye(size, dtype=strict_lower.dtype, device=strict_lower.device).expand_as(strict_lower)
    for mask in _merge_masks(size, strict_lower.device):
        inverse = inverse - inverse @ (strict_lower * mask) @ inverse
    return inverse


def chunk_gated_delta_rule(
    query: torch.Tensor,
    key: torch.Tensor,
    value: torch.Tensor,
    g: torch.Tensor,
    beta: torch.Tensor,
    chunk_size: int = 64,
    initial_state: torch.Tensor | None = None,
    output_final_state: bool = False,
    use_qk_l2norm_in_kernel: bool = False,
    **_: object,
) -> tuple[torch.Tensor, torch.Tensor | None]:
    """Same signature and outputs as transformers' ``torch_chunk_gated_delta_rule``.

    Shapes: query/key ``[B, T, H, Dk]``, value ``[B, T, H, Dv]``, g/beta ``[B, T, H]``.
    Returns the output ``[B, T, H, Dv]`` and, if requested, the final state ``[B, H, Dk, Dv]``.
    """
    out_dtype = query.dtype
    batch, length, heads, k_dim = key.shape
    v_dim = value.shape[-1]

    q, k, v = (x.transpose(1, 2).float() for x in (query, key, value))
    log_decay, b = g.transpose(1, 2).float(), beta.transpose(1, 2).float()
    if use_qk_l2norm_in_kernel:
        q, k = _l2_normalize(q), _l2_normalize(k)
    q = q * k_dim**-0.5

    pad = (-length) % chunk_size
    if pad:
        q, k, v = (F.pad(x, (0, 0, 0, pad)) for x in (q, k, v))
        log_decay, b = F.pad(log_decay, (0, pad)), F.pad(b, (0, pad))
    chunks = (length + pad) // chunk_size

    # [B, H, N, C, D] and [B, H, N, C]
    q, k, v = (x.reshape(batch, heads, chunks, chunk_size, -1) for x in (q, k, v))
    b = b.reshape(batch, heads, chunks, chunk_size, 1)
    cumulative = log_decay.reshape(batch, heads, chunks, chunk_size).cumsum(-1)

    # decay[i, j] = exp(G_i - G_j) for j <= i, else 0. Masking before exp keeps it finite.
    causal = torch.ones(chunk_size, chunk_size, dtype=torch.bool, device=q.device).tril()
    gap = cumulative.unsqueeze(-1) - cumulative.unsqueeze(-2)
    decay = gap.masked_fill(~causal, float("-inf")).exp()

    k_beta = k * b
    strict = (k_beta @ k.transpose(-1, -2)) * decay
    weights = invert_unit_triangular(strict.tril(-1))

    chunk_values = weights @ (v * b)  # value targets after intra-chunk deltas
    chunk_keys = weights @ (k_beta * cumulative.exp().unsqueeze(-1))  # how the incoming state is read
    intra = (q @ k.transpose(-1, -2)) * decay
    q_decayed = q * cumulative.exp().unsqueeze(-1)
    tail = cumulative[..., -1:]
    k_to_end = k * (tail - cumulative).exp().unsqueeze(-1)
    carry = tail.exp().unsqueeze(-1)  # [B, H, N, 1, 1]: how much state survives a chunk

    state = (
        torch.zeros(batch, heads, k_dim, v_dim, dtype=torch.float32, device=q.device)
        if initial_state is None
        else initial_state.float()
    )
    outputs = []
    for index in range(chunks):
        if index == 0 and initial_state is None:
            fresh = chunk_values[:, :, 0]
            outputs.append(intra[:, :, 0] @ fresh)
        else:
            fresh = chunk_values[:, :, index] - chunk_keys[:, :, index] @ state
            outputs.append(q_decayed[:, :, index] @ state + intra[:, :, index] @ fresh)
        state = state * carry[:, :, index] + k_to_end[:, :, index].transpose(-1, -2) @ fresh

    out = torch.stack(outputs, dim=2).reshape(batch, heads, chunks * chunk_size, v_dim)[:, :, :length]
    out = out.transpose(1, 2).contiguous().to(out_dtype)
    return out, (state if output_final_state else None)



def compare(device: torch.device, dtype: torch.dtype, length: int = 448, heads: int = 32, dim: int = 128, runs: int = 3):
    """Time transformers' fallback and this implementation once, on this device, at clef-flash's shapes.

    The fallback differs between transformers versions (a per-row Python loop in some, a batched
    ``solve_triangular`` in others), and how fast each runs depends on the backend, so the engine
    measures instead of assuming. Returns ``(fallback_ms, ours_ms)``, medians over ``runs``.
    """
    import inspect
    import statistics
    import time

    from transformers.models.qwen3_5 import modeling_qwen3_5 as qwen

    fallback = inspect.unwrap(_replaced_global or qwen.torch_chunk_gated_delta_rule)
    q, k, v = (torch.randn(1, length, heads, dim, device=device, dtype=dtype) for _ in range(3))
    g = -torch.rand(1, length, heads, device=device, dtype=torch.float32) * 4
    beta = torch.rand(1, length, heads, device=device, dtype=dtype)

    def sync() -> None:
        if device.type == "mps":
            torch.mps.synchronize()
        elif device.type == "cuda":
            torch.cuda.synchronize()

    def timed(fn) -> float:
        fn(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
        times = []
        for _ in range(runs):
            sync()
            start = time.perf_counter()
            fn(q, k, v, g, beta, use_qk_l2norm_in_kernel=True)
            sync()
            times.append((time.perf_counter() - start) * 1000)
        return statistics.median(times)

    with torch.inference_mode():
        return timed(fallback), timed(chunk_gated_delta_rule)


_replaced_global = None


def install(model: torch.nn.Module) -> int:
    """Route the model's Qwen3.5 linear-attention layers through this module, unless FLA is installed.

    transformers has used two layouts. Up to about 5.15 each layer binds its kernel when it is built
    (``layer.chunk_gated_delta_rule``), so patching the module-level function after loading would do
    nothing; later versions look the module-level ``torch_chunk_gated_delta_rule`` up on every call.
    Both are handled. Returns the number of layers that now use this implementation.
    """
    global _replaced_global
    from transformers.models.qwen3_5 import modeling_qwen3_5 as qwen
    from transformers.utils.import_utils import is_flash_linear_attention_available

    if is_flash_linear_attention_available():
        return 0
    layers = [module for module in model.modules() if isinstance(module, qwen.Qwen3_5GatedDeltaNet)]
    if not layers:
        return 0
    if hasattr(layers[0], "chunk_gated_delta_rule"):
        for layer in layers:
            layer.chunk_gated_delta_rule = chunk_gated_delta_rule
    elif qwen.torch_chunk_gated_delta_rule is not chunk_gated_delta_rule:
        _replaced_global = qwen.torch_chunk_gated_delta_rule
        qwen.torch_chunk_gated_delta_rule = chunk_gated_delta_rule
    return len(layers)


def uninstall(model: torch.nn.Module) -> None:
    """Undo :func:`install` (used by the tests to compare against the reference)."""
    global _replaced_global
    from transformers.models.qwen3_5 import modeling_qwen3_5 as qwen

    if _replaced_global is not None:
        qwen.torch_chunk_gated_delta_rule = _replaced_global
        _replaced_global = None
    for module in model.modules():
        if isinstance(module, qwen.Qwen3_5GatedDeltaNet) and getattr(module, "chunk_gated_delta_rule", None) is chunk_gated_delta_rule:
            module.chunk_gated_delta_rule = qwen.torch_chunk_gated_delta_rule
