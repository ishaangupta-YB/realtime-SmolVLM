"""Image decoding and sizing shared by every backend.

Clef's vision tower works on 32x32 pixel tiles (16 px patches, merged 2x2), and every side is
rounded to a multiple of 32, with small images scaled up to about 256x256. The page sizes frames
to that grid before encoding them, so the processor's own resize becomes a no-op and the token
count shown in the UI is exact: ``(width / 32) * (height / 32)`` image tokens.
"""

from __future__ import annotations

import base64
import binascii
import io
import math
from dataclasses import dataclass, field

from PIL import Image, UnidentifiedImageError

TILE = 32
MIN_PIXELS = 256 * 256
MIME_BY_FORMAT = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
MAX_BYTES = 4 * 1024 * 1024  # Workers AI limit per image
MAX_IMAGES = 4


class ImageError(ValueError):
    pass


def fit_to_grid(width: int, height: int, max_side: int) -> tuple[int, int]:
    """Size an image keeps after Clef's resize, capped so its longest side is at most ``max_side``."""
    if width <= 0 or height <= 0:
        raise ImageError("image has no pixels")
    scale = min(1.0, max_side / max(width, height))
    w = max(TILE, round(width * scale / TILE) * TILE)
    h = max(TILE, round(height * scale / TILE) * TILE)
    if w * h < MIN_PIXELS:
        grow = math.sqrt(MIN_PIXELS / (width * height))
        w = math.ceil(width * grow / TILE) * TILE
        h = math.ceil(height * grow / TILE) * TILE
    return w, h


def image_tokens(width: int, height: int) -> int:
    return (width // TILE) * (height // TILE)


@dataclass
class Picture:
    """An encoded image plus its decoded form, decoded at most once and only if a backend needs it."""

    data: bytes
    mime: str
    width: int
    height: int
    _pil: Image.Image | None = field(default=None, repr=False)

    @classmethod
    def from_bytes(cls, data: bytes) -> "Picture":
        if not data:
            raise ImageError("empty image")
        if len(data) > MAX_BYTES:
            raise ImageError(f"image is {len(data) / 1e6:.1f} MB, the limit is {MAX_BYTES / 1e6:.0f} MB")
        try:
            with Image.open(io.BytesIO(data)) as probe:
                mime = MIME_BY_FORMAT.get(probe.format or "")
                width, height = probe.size
        except (UnidentifiedImageError, OSError) as error:
            raise ImageError("not a readable PNG, JPEG or WebP image") from error
        if mime is None:
            raise ImageError("only PNG, JPEG and WebP images are supported")
        if width * height > 16_000_000:
            raise ImageError("image is larger than 16 megapixels")
        return cls(data=data, mime=mime, width=width, height=height)

    @classmethod
    def from_data_url(cls, value: str) -> "Picture":
        if not isinstance(value, str):
            raise ImageError("images must be data URLs (data:image/jpeg;base64,...)")
        head, _, payload = value.partition(",")
        if not head.lower().startswith("data:") or ";base64" not in head.lower() or not payload:
            raise ImageError("images must be base64 data URLs (data:image/jpeg;base64,...)")
        try:
            data = base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError) as error:
            raise ImageError("image data URL is not valid base64") from error
        return cls.from_bytes(data)

    @classmethod
    def from_any(cls, value: object) -> "Picture":
        """Accept a data URL, or the ``{"content_type", "base64"}`` object Workers AI also accepts."""
        if isinstance(value, dict) and isinstance(value.get("base64"), str):
            try:
                return cls.from_bytes(base64.b64decode(value["base64"]))
            except (binascii.Error, ValueError) as error:
                raise ImageError("image base64 is not valid") from error
        return cls.from_data_url(value)  # type: ignore[arg-type]

    def pil(self) -> Image.Image:
        if self._pil is None:
            with Image.open(io.BytesIO(self.data)) as image:
                self._pil = image.convert("RGB")
        return self._pil

    def fitted(self, max_side: int) -> "Picture":
        """Return a copy already on Clef's 32 px grid (no-op when the page sized it already)."""
        size = fit_to_grid(self.width, self.height, max_side)
        if size == (self.width, self.height):
            return self
        resized = self.pil().resize(size, Image.Resampling.BICUBIC)
        buffer = io.BytesIO()
        resized.save(buffer, format="JPEG", quality=90)
        return Picture(buffer.getvalue(), "image/jpeg", size[0], size[1], resized)

    def data_url(self) -> str:
        return f"data:{self.mime};base64,{base64.b64encode(self.data).decode('ascii')}"
