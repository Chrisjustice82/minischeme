# MiniScheme

AI paint scheme previews for tabletop miniatures. Take a photo of an unpainted or primed model, describe the vibe you want, get 3 full schemes back — each with a repainted preview image and a complete base / shade / layer / edge-highlight recipe using real GW paint names.

## Architecture

- **Single-file HTML frontend** (`public/index.html`) — camera/upload, brief input, engine selector, progressive results grid
- **`scheme-background.js`** — Netlify Background Function (15 min budget). Uses Claude Sonnet 4.6 to generate 3 schemes, then renders all 3 images in parallel via the chosen engine. Writes progress to Upstash Redis.
- **`job-status.js`** — Fast sync function. Reads job state from Upstash for the frontend poller.
- **`diag.js`** — Health check. Visit `/.netlify/functions/diag` to see what's configured.
- **`_shared.js`** — Shared HTTP helpers, Anthropic streaming client, image engine adapters, and Upstash Redis client.

Zero npm dependencies — everything uses Node's built-in `https` module. This means no `npm install` is required and the functions deploy cleanly whether you use drag-and-drop or a connected Git repo.

The browser submits a job, then polls `/job-status?id=…` every 2 seconds. Scheme cards fill in progressively as each image finishes rendering.

## Deploy

1. **Create a free Upstash Redis database**: go to [upstash.com](https://upstash.com), sign up, create a Redis DB (free tier gives 10,000 commands/day — far more than you'll ever need). Copy the **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** from the database's "REST API" section.

2. **Push to a GitHub repo** and connect it to Netlify (or drag-and-drop the folder at app.netlify.com).

3. **Set environment variables** in Netlify (Site settings → Environment variables):

| Variable | Required? | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | Always | Job state storage |
| `UPSTASH_REDIS_REST_TOKEN` | Always | Job state auth |
| `ANTHROPIC_API_KEY` | Always | Claude scheme generation |
| `IMAGE_ENGINE` | Optional | Default engine: `gemini` / `replicate` / `openai`. Defaults to `gemini`. |
| `GEMINI_API_KEY` | If using Gemini | aistudio.google.com/app/apikey |
| `REPLICATE_API_TOKEN` | If using Flux Kontext | replicate.com/account/api-tokens |
| `OPENAI_API_KEY` | If using gpt-image-1 | OpenAI dashboard |

4. **Verify** by hitting `https://<your-site>.netlify.app/.netlify/functions/diag` — should return `"ok": true`.

## Engine notes

- **Gemini** — fastest and cheapest (~$0.04 per image). Good structural preservation. Recommended default.
- **Flux Kontext** (Replicate) — strongest at preserving sculpt detail but slowest (~20–40s per image, polled).
- **gpt-image-1** — most painterly output, most expensive (~$0.50+ per image), can over-stylise.

Users pick per-request via the radio buttons.

## Limits

- Job records in Upstash expire after 1 hour (set via Redis TTL).
- Netlify background function: 15 min execution, 6 MB request payload. Client downscales images to 1024px before upload (~270 KB base64).
- If all three image renders fail, the job is marked `error` with the combined messages.
