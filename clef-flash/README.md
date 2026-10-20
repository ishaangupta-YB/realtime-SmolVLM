# clef live

Point a camera, a shared screen, an image or a block of text at a set of questions, and get an
answer with a probability for every option, on every frame, from
[clef-flash](https://huggingface.co/Cloudflare/clef-flash), Cloudflare's open-weight 9B decision
model.

A decision model answers a fixed schema of questions instead of writing text. For every frame it
returns a probability for every option of every question, in one forward pass. You change the
questions in the page and the next frame answers them: nothing is retrained.

## What you get

- **Four sources**: webcam (pick the device), screen share, a dropped or pasted image, or plain text/JSON.
- **Three question types**, each with its own card: `choice` (bars per option), `noul` (a yes/no
  meter), `score` (a level histogram with the expected value marked). Every card has a 60-second
  trend strip with hover readout, and shows how long the current answer has held.
- **Question editor** with a form builder, raw JSON with live validation, 8 built-in sets, your own
  saved sets, import/export, and share links.
- **Triggers**: "when *activity* is *on phone* (≥ 70%) for 3 s → notify, chime, speak, attach the
  frame". They fire once per episode, with a cooldown.
- **Smoothing** to stop flicker, a **context** field sent as the state with every frame,
  **snapshots** with the decisions drawn on them, and **CSV export** of every recorded decision.
- **Inspector**: which backend answered, per-stage timing, the raw response, and the same request
  as curl or Python.
- **Backends**: run the model on this machine (Apple Silicon, CUDA or CPU), call Workers AI
  (`@cf/cloudflare/clef-flash`), or any server that speaks `POST /v1/systemone` (SGLang). A demo
  backend lets you try the page with no model at all; it is labelled everywhere as synthetic.
- Light and dark themes, keyboard shortcuts for everything, a layout that works at phone width,
  and no CDN: the page is plain ES modules and works offline.

## Quickstart

You need [uv](https://docs.astral.sh/uv/).

### On this machine

clef-flash is about 19 GB of bf16 weights, so a Mac needs 32 GB of unified memory or more (or a
24 GB+ GPU on Linux/Windows).

```sh
cd clef-flash
uv sync --extra local
uv run hf download Cloudflare/clef-flash --local-dir weights/clef-flash
uv run clefcam
```

Open http://localhost:8765 and allow the camera. The page is usable straight away; frames start
flowing as soon as the weights finish loading.

### On Workers AI (no download)

```sh
cd clef-flash
uv sync
export CLOUDFLARE_ACCOUNT_ID=...   # dashboard → Workers AI
export CLOUDFLARE_API_TOKEN=...    # a token with Workers AI permission
uv run clefcam
```

Latency then includes the round trip to Cloudflare, and every frame is billed as input tokens
(see the [model page](https://developers.cloudflare.com/workers-ai/weights/clef-flash/)).

### Against an SGLang (or other SystemOne) server

```sh
CLEFCAM_SYSTEMONE_URL=http://gpu-box:30000 uv run clefcam
```

### Just the interface

`uv sync && uv run clefcam --backend demo`. Answers are synthetic and the page says so.

With `CLEFCAM_BACKEND=auto` (the default) the server picks local weights if `weights/clef-flash`
exists, then Workers AI if both Cloudflare variables are set, then `CLEFCAM_SYSTEMONE_URL`, then demo.

## Keys

| Key | |
| --- | --- |
| `space` | pause or resume |
| `E` | questions · `⌘/Ctrl ↵` applies |
| `G` | triggers |
| `I` | inspector |
| `,` | settings |
| `1` – `4` | camera · screen · image · text |
| `S` | snapshot with decisions |
| `M` | mirror the view |
| `C` | compact cards |
| `L` | light / dark |
| `⇧ D` | back to the default questions |
| `?` | all shortcuts |

## Questions

The schema is the one `@cf/cloudflare/clef-flash` takes on Workers AI, so a set built here works
there unchanged:

```json
{
  "posture": {
    "type": "choice",
    "instructions": "Posture?",
    "criteria": { "upright": null, "slouching": null, "leaning_in": "close to the screen" }
  },
  "focus": { "type": "score", "instructions": "How focused?", "criteria": ["not working", "distracted", "deep focus"] },
  "phone_in_hand": { "type": "noul", "instructions": "Is the person holding a phone?" }
}
```

- `noul`: yes/no. Optional `criteria` say what `true` and `false` mean.
- `choice`: 2 to 255 options; descriptions may be `null`.
- `score`: 2 to 10 ordered levels, lowest first. The answer is the probability-weighted level.
- Up to 64 questions; ids use letters, digits, `_`, `.` and `-`.

Every token of the prompt costs time on each frame. Short instructions and `null` descriptions keep
it quick; the editor shows a running estimate.

## How it stays fast

- **No backlog, no idle model.** Frames travel over one WebSocket as raw JPEG bytes (no base64,
  no JSON wrapping). The server keeps only the newest unanswered frame per connection, so a slow
  frame never builds a queue. When it starts a frame it tells the page how long it expects to take,
  and the page captures the next frame just before that, so the next frame is already waiting when
  the model frees up.
- **Exact-size frames.** The page resizes each frame onto the model's 32 px grid before encoding,
  off the main thread where the browser allows, so the image processor does no resizing and the
  token count shown is exact. Detail is adjustable (256 to 640 px on the longest side).
- **Linear attention without the CUDA kernels, chosen by measurement.** Without
  flash-linear-attention (always the case on a Mac), transformers runs Qwen3.5's 24
  linear-attention layers through a reference implementation. Depending on the transformers
  version, it solves each 64-token chunk's triangular system either one row at a time in Python or
  with `torch.linalg.solve_triangular`. [`clefcam/gated_delta.py`](clefcam/gated_delta.py) builds
  the same inverse by doubling: log2(64) = 6 rounds of batched matmuls for every chunk and head at
  once. Against the row-by-row fallback (transformers 5.10), the PyTorch profiler counts 196
  tensor operations per layer instead of 1,143 on a 400-token input, about 4,700 per forward pass
  instead of 27,400. Against the `solve_triangular` fallback (5.20) the op count is about the same,
  and the difference comes down to how fast that op is on your GPU. So the engine does not assume:
  at startup it times both on your device and installs this one only if it is faster. The inspector
  shows which one won and by how much. It matches the exact token-by-token recurrence as closely as
  the reference does, and the tests check this on both transformers versions. With
  flash-linear-attention installed (CUDA), nothing is replaced.
- **One model thread.** The local model runs on a single dedicated thread, requests are answered
  in arrival order, and each frame syncs the GPU once instead of once per question.
- **A light page.** Cards are built once per question set; each answer only changes transforms and
  text, batched into one animation frame.

## API

The server is also a SystemOne endpoint, with the same body as Workers AI:

```sh
curl http://localhost:8765/v1/systemone -H 'Content-Type: application/json' -d '{
  "model": "clef-flash",
  "state": "Checkout is down for every customer.",
  "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } }
}'
```

Add `"images": ["data:image/jpeg;base64,..."]` (up to 4) for vision. Timing comes back in the
`Server-Timing` header. `GET /api/info` describes the backend; `/api/docs` lists the routes. The
live stream protocol (`/api/stream`) is described at the top of [`clefcam/server.py`](clefcam/server.py).

## Settings

| Variable | Default | |
| --- | --- | --- |
| `CLEFCAM_BACKEND` | `auto` | `local`, `workers-ai`, `systemone` or `demo` |
| `CLEFCAM_HOST` / `CLEFCAM_PORT` | `127.0.0.1` / `8765` | bind address. Camera frames are sent here, so keep it local unless you mean it |
| `CLEFCAM_MODEL_DIR` | `weights/clef-flash` | local weights |
| `CLEFCAM_DEVICE` | `auto` | `cuda`, `mps` or `cpu` |
| `CLEFCAM_DTYPE` | `bfloat16` | `float16` or `float32` |
| `CLEFCAM_FAST_KERNEL` | `1` | `0` skips the startup comparison and always uses transformers' linear attention |
| `CLEFCAM_MAX_SIDE` | `640` | largest image side the server accepts; the page picks its own size below this |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | | Workers AI credentials |
| `CLEFCAM_WORKERS_MODEL` | `@cf/cloudflare/clef-flash` | or `@cf/cloudflare/clef` for the 27B model |
| `CLEFCAM_SYSTEMONE_URL`, `CLEFCAM_SYSTEMONE_MODEL`, `CLEFCAM_SYSTEMONE_TOKEN` | | another SystemOne server |

`--host`, `--port` and `--backend` on the command line override the environment.

On NVIDIA GPUs, installing [flash-linear-attention](https://github.com/fla-org/flash-linear-attention)
and [causal-conv1d](https://github.com/Dao-AILab/causal-conv1d) lets transformers use its own fused
kernels.

## Layout

| Path | |
| --- | --- |
| `clefcam/server.py` | HTTP, WebSocket stream, SystemOne endpoint |
| `clefcam/engines/` | `local` (transformers), `remote` (Workers AI, SystemOne), `demo` |
| `clefcam/gated_delta.py` | linear attention without the CUDA kernels |
| `clefcam/schema.py`, `imaging.py` | validation (Workers AI rules) and image sizing |
| `web/` | the page: `index.html`, `css/app.css`, `js/*.js` |
| `tests/` | `uv run pytest` |

The model's own inference code (`joint_schema_model.py`) is downloaded with the weights and loaded
from there.

## Tests

```sh
uv sync --extra local
uv run pytest
```

`node tests/web_logic.mjs` checks the page logic (smoothing, triggers, capture pacing, presets)
without a browser.

`tests/test_local_engine.py` runs the whole local path (release code, real tokenizer and image
processor, the fast kernel) on a tiny randomly initialised copy of the architecture. It needs only
the small files from the model repo:
`uv run hf download Cloudflare/clef-flash --local-dir weights/clef-flash --exclude "*.safetensors"`.
It is skipped when they are missing.

## License

clef-flash is released under Apache-2.0 by Cloudflare. This app talks to it through the model's
published API and inference code.
