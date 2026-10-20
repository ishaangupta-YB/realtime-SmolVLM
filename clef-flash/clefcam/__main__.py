"""Start the server: ``uv run clefcam`` (or ``python -m clefcam``)."""

from __future__ import annotations

import argparse
import logging
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="clefcam", description="Live webcam decisions with clef-flash.")
    parser.add_argument("--host", help="interface to bind (default 127.0.0.1, or CLEFCAM_HOST)")
    parser.add_argument("--port", type=int, help="port (default 8765, or CLEFCAM_PORT)")
    parser.add_argument(
        "--backend",
        choices=("auto", "local", "workers-ai", "systemone", "demo"),
        help="who answers (default auto: local weights, then Workers AI credentials, then demo)",
    )
    args = parser.parse_args()
    if args.host:
        os.environ["CLEFCAM_HOST"] = args.host
    if args.port:
        os.environ["CLEFCAM_PORT"] = str(args.port)
    if args.backend:
        os.environ["CLEFCAM_BACKEND"] = args.backend
    # Any op without an MPS kernel runs on the CPU instead of failing the request.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    import uvicorn

    from .config import Settings
    from .server import create_app

    settings = Settings.from_env()
    app = create_app(settings)
    backend = app.state.host.engine.info.kind
    shown = "localhost" if settings.host in ("127.0.0.1", "0.0.0.0") else settings.host
    logging.getLogger("clefcam").info("backend: %s  ->  open http://%s:%d", backend, shown, settings.port)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", ws_max_size=8 * 1024 * 1024)


if __name__ == "__main__":
    main()
