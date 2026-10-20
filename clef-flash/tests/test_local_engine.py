"""End-to-end check of the local engine on a tiny, randomly initialised copy of clef-flash.

The weights are random, so the answers mean nothing; what this checks is the whole path: the
release code, the real tokenizer and image processor, the patched linear attention, and the
SystemOne answer format. It needs the small files from the model repo (no weights):

    uv run hf download Cloudflare/clef-flash --local-dir weights/clef-flash --exclude "*.safetensors"

Point CLEFCAM_TEST_RELEASE_DIR at another folder that holds them to use that instead.
"""

import asyncio
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")

RELEASE = Path(os.environ.get("CLEFCAM_TEST_RELEASE_DIR", Path(__file__).resolve().parent.parent / "weights" / "clef-flash"))
NEEDED = ["joint_schema_model.py", "tokenizer.json", "tokenizer_config.json", "processor_config.json", "chat_template.jinja", "config.json"]
pytestmark = pytest.mark.skipif(
    not all((RELEASE / name).is_file() for name in NEEDED), reason=f"release files not found in {RELEASE}"
)


def load_release(directory, name):
    spec = importlib.util.spec_from_file_location(name, directory / "joint_schema_model.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def tiny_model_dir(tmp_path_factory):
    from safetensors.torch import save_file

    directory = tmp_path_factory.mktemp("tiny-clef")
    for name in NEEDED[:-1]:
        shutil.copy(RELEASE / name, directory / name)
    config = json.loads((RELEASE / "config.json").read_text())
    text = config["text_config"]
    text.update(
        hidden_size=64, intermediate_size=128, num_hidden_layers=4, num_attention_heads=4, num_key_value_heads=2,
        head_dim=16, linear_num_key_heads=2, linear_num_value_heads=4, linear_key_head_dim=16, linear_value_head_dim=16,
        layer_types=["linear_attention", "linear_attention", "linear_attention", "full_attention"],
    )
    text["rope_parameters"]["mrope_section"] = [2, 1, 1]
    vision = config["vision_config"]
    vision.update(depth=2, hidden_size=32, intermediate_size=64, num_heads=2, out_hidden_size=64)
    (directory / "config.json").write_text(json.dumps(config))

    model = transformers.Qwen3_5ForConditionalGeneration(transformers.AutoConfig.from_pretrained(directory))
    model.save_pretrained(directory)

    head_config = {"hidden_size": 64, "width": 32, "routing_layers": 1, "layers": 1, "heads": 2, "feedforward": 64}
    (directory / "joint_head_config.json").write_text(json.dumps(head_config))
    release = load_release(directory, "tiny_release")
    head = release.JointSchemaHead(**head_config)
    save_file({k: v.contiguous() for k, v in head.state_dict().items()}, directory / "joint_head.safetensors")
    return directory


def test_local_engine_end_to_end(tiny_model_dir):
    from PIL import Image

    from clefcam.config import Settings
    from clefcam.engines.local import LocalEngine
    from clefcam.imaging import Picture

    engine = LocalEngine(Settings(backend="local", model_dir=tiny_model_dir, device="cpu", dtype="float32"))
    questions = {
        "present": {"type": "noul", "instructions": "Is a person visible?"},
        "mood": {"type": "choice", "instructions": "Mood?", "criteria": {"happy": None, "tired": "eyes half closed", "neutral": None}},
        "energy": {"type": "score", "instructions": "Energy?", "criteria": ["low", "medium", "high"]},
    }

    async def run():
        await engine.load()
        # Which kernel wins is measured per device; either way the choice is reported.
        assert engine.info.notes[0].startswith(("clefcam linear attention on 3 layers", "transformers linear attention kept"))
        picture = Picture(b"", "image/jpeg", 352, 192, Image.new("RGB", (352, 192), (200, 100, 50)))
        with_image = await engine.decide("A webcam frame.", questions, [picture])
        text_only = await engine.decide("Just text.", questions, [])
        await engine.close()
        return with_image, text_only

    with_image, text_only = asyncio.run(run())
    for decision in (with_image, text_only):
        answers = decision.answers
        assert set(answers) == set(questions)
        assert 0 <= answers["present"]["noul"] <= 1
        assert list(answers["mood"]["probabilities"]) == ["happy", "tired", "neutral"]
        assert abs(sum(answers["mood"]["probabilities"].values()) - 1) < 1e-3
        assert answers["energy"]["legend"] == {"0": "low", "1": "medium", "2": "high"}
        assert decision.model_ms > 0
    # 352x192 on the 32 px grid is 11 * 6 = 66 image tokens, plus the vision start/end markers.
    assert with_image.usage["input_tokens"] - text_only.usage["input_tokens"] >= 66


def test_patched_and_reference_kernels_agree(tiny_model_dir):
    """Same tiny model, same request: the fast kernel and the transformers fallback give the same probabilities."""
    from clefcam.gated_delta import install, uninstall

    release = load_release(tiny_model_dir, "tiny_release_2")
    model, processor = release.load_release_model(tiny_model_dir, device="cpu", dtype=torch.float32)
    uninstall(model)
    request = {
        "model": "clef-flash",
        "state": "A long state " * 40,
        "questions": {"mood": {"type": "choice", "criteria": {"a": None, "b": None, "c": None}}, "yes": {"type": "noul"}},
    }
    reference = release.systemone(model, processor, request)
    assert install(model) == 3
    fast = release.systemone(model, processor, request)
    uninstall(model)
    assert reference["usage"]["input_tokens"] > 64  # spans several 64-token chunks
    for question, answer in reference["answers"].items():
        a = answer.get("probabilities") or {"true": answer["noul"]}
        b = fast["answers"][question].get("probabilities") or {"true": fast["answers"][question]["noul"]}
        assert max(abs(a[k] - b[k]) for k in a) < 1e-3
