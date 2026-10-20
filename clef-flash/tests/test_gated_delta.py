"""The fast gated delta rule must match the exact token-by-token recurrence."""

import pytest

torch = pytest.importorskip("torch")
modeling = pytest.importorskip("transformers.models.qwen3_5.modeling_qwen3_5")

from clefcam.gated_delta import chunk_gated_delta_rule, invert_unit_triangular  # noqa: E402


def make_inputs(length, heads=8, dim=64, hard=False, dtype=torch.float32, seed=0):
    generator = torch.Generator().manual_seed(seed)
    randn = lambda *shape: torch.randn(*shape, generator=generator)  # noqa: E731
    q, k, v = randn(1, length, heads, dim), randn(1, length, heads, dim), randn(1, length, heads, dim)
    if hard:  # near-identical keys, almost no decay, beta near 1: the worst case for the WY form
        k = randn(1, 1, heads, dim) + 0.05 * k
        a, b = torch.full((1, length, heads), -6.0), torch.full((1, length, heads), 4.0)
    else:
        a, b = randn(1, length, heads), randn(1, length, heads)
    a_log = torch.log(torch.rand(heads, generator=generator) * 16 + 1e-3)
    g = -a_log.exp() * torch.nn.functional.softplus(a + randn(heads))
    return [x.to(dtype) for x in (q, k, v)] + [g, b.sigmoid()]


def test_invert_unit_triangular():
    strict = torch.randn(3, 64, 64).tril(-1) * 0.3
    eye = torch.eye(64)
    assert torch.allclose((eye + strict) @ invert_unit_triangular(strict), eye, atol=1e-4)
    with pytest.raises(ValueError):
        invert_unit_triangular(torch.zeros(48, 48))


@pytest.mark.parametrize("length,hard", [(1, False), (63, False), (64, False), (200, False), (333, True)])
def test_matches_recurrence(length, hard):
    q, k, v, g, b = make_inputs(length, hard=hard)
    truth, truth_state = modeling.torch_recurrent_gated_delta_rule(q, k, v, g, b, None, True, use_qk_l2norm_in_kernel=True)
    out, state = chunk_gated_delta_rule(q, k, v, g, b, output_final_state=True, use_qk_l2norm_in_kernel=True)
    assert out.shape == truth.shape
    assert (out - truth).abs().max() < 1e-5
    assert (state - truth_state).abs().max() < 1e-4


def test_initial_state_and_dtype():
    q, k, v, g, b = make_inputs(150, seed=1)
    start = torch.randn(1, 8, 64, 64) * 0.1
    truth, _ = modeling.torch_recurrent_gated_delta_rule(q, k, v, g, b, start, False, use_qk_l2norm_in_kernel=True)
    out, state = chunk_gated_delta_rule(q, k, v, g, b, initial_state=start, use_qk_l2norm_in_kernel=True)
    assert state is None
    assert (out - truth).abs().max() < 1e-5

    q, k, v, g, b = make_inputs(130, dtype=torch.bfloat16, seed=2)
    out, _ = chunk_gated_delta_rule(q, k, v, g, b, use_qk_l2norm_in_kernel=True)
    reference, _ = modeling.torch_chunk_gated_delta_rule(q, k, v, g, b, use_qk_l2norm_in_kernel=True)
    assert out.dtype == torch.bfloat16
    assert (out.float() - reference.float()).abs().max() < 2e-3


def test_install_routes_every_linear_layer():
    from clefcam.gated_delta import install, uninstall

    config = modeling.Qwen3_5TextConfig(
        hidden_size=64, intermediate_size=128, num_hidden_layers=4, num_attention_heads=4, num_key_value_heads=2,
        head_dim=16, linear_num_key_heads=2, linear_num_value_heads=4, linear_key_head_dim=16, linear_value_head_dim=16,
        vocab_size=256, layer_types=["linear_attention", "linear_attention", "linear_attention", "full_attention"],
    )
    model = modeling.Qwen3_5TextModel(config).eval()
    ids = torch.randint(0, 256, (1, 90))
    calls = []
    uninstall(model)
    with torch.inference_mode():
        before = model(input_ids=ids, use_cache=False).last_hidden_state
        assert install(model) == 3
        assert install(model) == 3  # idempotent
        import clefcam.gated_delta as fast

        real = fast.chunk_gated_delta_rule
        counting = lambda *a, **k: calls.append(1) or real(*a, **k)  # noqa: E731
        fast.chunk_gated_delta_rule = counting
        uninstall(model)
        install(model)
        after = model(input_ids=ids, use_cache=False).last_hidden_state
        fast.chunk_gated_delta_rule = real
        uninstall(model)
    assert len(calls) == 3  # the fast kernel really ran, once per linear-attention layer
    assert (before - after).abs().max() < 1e-4


def test_compare_times_both():
    from clefcam.gated_delta import compare

    fallback_ms, ours_ms = compare(torch.device("cpu"), torch.float32, length=96, heads=4, dim=32, runs=1)
    assert fallback_ms > 0 and ours_ms > 0
