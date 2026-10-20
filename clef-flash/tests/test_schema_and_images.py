import base64
import io

import pytest
from PIL import Image

from clefcam.imaging import ImageError, Picture, fit_to_grid
from clefcam.schema import SchemaError, validate_questions, validate_state


def test_valid_questions_are_cleaned():
    cleaned = validate_questions(
        {
            "smiling": {"type": "noul"},
            "mood": {"type": "choice", "instructions": "Mood?", "criteria": {"happy": None, "tired": "eyes half closed"}},
            "energy": {"type": "score", "criteria": ["low", "high"]},
            "lit": {"type": "noul", "instructions": "Lit?", "criteria": {"true": "bright", "false": None}},
        }
    )
    assert cleaned["smiling"] == {"type": "noul", "instructions": "smiling"}  # defaults to the id
    assert cleaned["mood"]["criteria"] == {"happy": None, "tired": "eyes half closed"}
    assert cleaned["lit"]["criteria"] == {"true": "bright"}


@pytest.mark.parametrize(
    "questions,path",
    [
        ({}, "questions"),
        ({"bad id": {"type": "noul"}}, "questions.bad id"),
        ({"q": {"type": "maybe"}}, "questions.q.type"),
        ({"q": {"type": "choice", "criteria": {"only": None}}}, "questions.q.criteria"),
        ({"q": {"type": "choice", "criteria": ["a", "b"]}}, "questions.q.criteria"),
        ({"q": {"type": "score", "criteria": ["one"]}}, "questions.q.criteria"),
        ({"q": {"type": "score", "criteria": [str(i) for i in range(11)]}}, "questions.q.criteria"),
        ({"q": {"type": "noul", "criteria": {"maybe": "x"}}}, "questions.q.criteria"),
    ],
)
def test_invalid_questions_name_the_field(questions, path):
    with pytest.raises(SchemaError) as error:
        validate_questions(questions)
    assert error.value.errors[0][0] == path


def test_state():
    assert validate_state({"a": [1, 2]}) == {"a": [1, 2]}
    with pytest.raises(SchemaError):
        validate_state(None)


@pytest.mark.parametrize("size", [(1280, 720), (640, 480), (100, 100), (3000, 200), (320, 320), (37, 512)])
@pytest.mark.parametrize("max_side", [256, 352, 640])
def test_fit_to_grid_is_a_fixed_point_of_the_qwen_resize(size, max_side):
    width, height = fit_to_grid(*size, max_side)
    assert width % 32 == 0 and height % 32 == 0
    assert width * height >= 256 * 256
    transformers = pytest.importorskip("transformers.models.qwen2_vl.image_processing_qwen2_vl")
    # Once on the grid, the model's own resize must leave the image alone.
    assert transformers.smart_resize(height, width, factor=32, min_pixels=65536, max_pixels=16777216) == (height, width)


def jpeg(width, height):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_picture_round_trip():
    data = jpeg(1280, 720)
    picture = Picture.from_data_url("data:image/jpeg;base64," + base64.b64encode(data).decode())
    assert (picture.mime, picture.width, picture.height) == ("image/jpeg", 1280, 720)
    fitted = picture.fitted(352)
    assert (fitted.width, fitted.height) == (352, 192) and fitted.pil().size == (352, 192)
    assert fitted.fitted(352) is fitted
    same = Picture.from_any({"content_type": "image/jpeg", "base64": base64.b64encode(data).decode()})
    assert same.width == 1280


@pytest.mark.parametrize("value", ["https://example.com/a.jpg", "data:image/jpeg;base64,", "data:text/plain;base64,aGk="])
def test_bad_images(value):
    with pytest.raises(ImageError):
        Picture.from_data_url(value)
