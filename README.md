# MiniScheme

AI paint scheme previews for tabletop miniatures. Take a photo of an unpainted or primed model, describe the vibe you want, get 3 full schemes back — each with a repainted preview image and a complete base / shade / layer / edge-highlight recipe using real GW paint names.

## Architecture

- **Single-file HTML frontend** (`public/index.html`) — camera/upload, brief input, engine selector, progressive results grid
- **`scheme-background.js`** — Netlify Background Function (15 min budget). Uses Claude Sonnet 4.6 to generate 3 schemes, then renders all 3 images in parallel via the chosen engine. Writes progress to Netlify Blobs.
- **`job-status.js`** — Fast sync function. Reads job state from Blobs for the frontend poller.
- **`_shared.js`** — Shared HTTP helpers, Anthropic streaming client, and the 3 pluggable image engine adapters.

The browser submits a job, then polls `/job-status?id=…` every 2 seconds. Scheme cards fill in progressively as each image finishes rendering — so you see the first result in ~20s even if the slowest engine takes a minute.

## Deploy

1. Push to a GitHub repo and connect to Netlify, or drag-and-drop the folder at app.netlify.com.
2. Set environment variables in **Site settings → Environment variables**:

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Always | Claude scheme generation |
| `IMAGE_ENGINE` | Optional | Default engine: `gemini` / `replicate` / `openai`. Defaults to `gemini`. |
| `GEMINI_API_KEY` | If using Gemini | aistudio.google.com/app/apikey |
| `REPLICATE_API_TOKEN` | If using Flux Kontext | replicate.com/account/api-tokens |
| `OPENAI_API_KEY` | If using gpt-image-1 | OpenAI dashboard |

No Netlify Blobs configuration needed — it works zero-config from any Netlify function.

## Engine notes

- **Gemini** — fastest and cheapest (~$0.04 per image). Good structural preservation. Recommended default.
- **Flux Kontext** (Replicate) — strongest at preserving sculpt detail but slowest (~20–40s per image, polled).
- **gpt-image-1** — most painterly output, most expensive (~$0.50+ per image), can over-stylise.

Users pick per-request via the radio buttons, so pluggability works at runtime.

## Limits & known constraints

- Netlify background functions: 15 min execution, 6 MB request payload. Client downscales images to 1024px before upload (~270 KB base64) so this isn't a concern.
- Job state in Netlify Blobs is not garbage-collected. For a production app you'd want a periodic cleanup, but for personal use the cost is trivial.
- If all three engines fail, the job is marked `error` with the combined messages.
