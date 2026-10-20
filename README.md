# realtime-SmolVLM

Two independent apps live in this repository.

| Folder | What it is | Start it |
| --- | --- | --- |
| [`smolVLM/`](smolVLM) | Next.js app for real-time vision with SmolVLM | `cd smolVLM && npm install && npm run dev` |
| [`clef-flash/`](clef-flash) | **clef live**: ask questions of a live camera, screen, image or text and get a probability for every answer, using Cloudflare's clef-flash decision model | `cd clef-flash && uv sync --extra local && uv run clefcam` (see its README) |

Each folder has its own README, dependencies and `.gitignore`.
