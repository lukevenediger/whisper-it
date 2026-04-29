# Whisper It

Local audio transcription web app using faster-whisper. Upload or record audio, get text back. No API keys, no tokens, no account required. Just run it and transcribe.

## Why This Exists

Cloud-based voice transcription (including Claude's voice notes) often produces mediocre results. OpenAI's Whisper model does significantly better, but using it typically means setting up API keys, paying per-request, or wrangling Python scripts.

Whisper It is a one-shot transcription tool that runs entirely on your own hardware. It's designed for quick, on-the-go transcription from your phone or laptop -- record or upload audio, get text, copy or share it. No setup, no cost per use, no data leaving your network.

## Intended Use

Whisper It has **no authentication**. It's designed for anonymous access within a trusted network.

**Recommended deployment:**

- **VPN / WireGuard / Tailscale** -- Run it on a machine in your network and access it from any device on the VPN. This is the intended setup: anyone on the network can transcribe without logging in.
- **Cloudflare Tunnel + Access** -- If you want to expose it to the internet, put it behind a Cloudflare Tunnel with Cloudflare Access to gate on email, SSO, or one-time PIN. This gives you auth without modifying the app.
- **Local only** -- Just run it on your laptop at `localhost:4000` for personal use.

**Do not** expose Whisper It directly to the public internet without an auth layer in front of it.

## Running

```bash
make run                       # preferred: builds + runs detached, bakes commit hash into footer
# or
docker compose up --build      # works, but footer version label falls back to "dev"
```

Then open http://localhost:4000. Stats dashboard at http://localhost:4000/stats.html.

First transcription with a given model will be slower -- it downloads the model weights. Subsequent runs use the cached model from the Docker volume.

## Features

- **Record or upload** -- Record from your mic (with live visualizer) or upload/drop one or more audio files
- **Multi-file batch upload** -- Drop or pick multiple files; queued and transcribed sequentially with a live status list
- **Auto-titled history** -- Uploads titled by filename; recordings titled `Recording YYYY-MM-DD HH-MM-SS`; batches show a `Batch · N of M` badge
- **Auto-transcribe** -- Transcription starts immediately, no extra button clicks
- **Model selection** -- Choose from tiny/base/small/medium/large-v3, default is small
- **Language selector** -- Force a specific ISO 639-1 language code or leave on Auto-detect (handles silent-stretch hallucination); persists in localStorage
- **Long-audio chunking** -- ffmpeg pre-splits audio > 20 min into 10-min mono 16 kHz WAV chunks; each chunk transcribed independently with VAD; timestamps offset back to original timeline
- **Live ETA + tab title** -- Queue panel shows per-chunk progress + refining ETA; browser tab title updates to `[N/total] · ETA filename`
- **Re-transcribe** -- Try a different model or language on the same audio without re-uploading
- **Download progress** -- Live progress bar when a model is downloading for the first time
- **Waveform display** -- Audacity-style waveform of your audio
- **Save transcript .txt** -- Per-history-item Download button, named after source file
- **Save batch .zip** -- Per-batch zip download (one .txt per source audio, named after source filename)
- **Share** -- Uses OS-level share sheet (WhatsApp, Telegram, Messages, etc.) on supported browsers
- **Mic selector** -- Pick which microphone to use when multiple are available
- **Persistent stats** -- `/stats.html` shows total counts, audio duration, words, by-model/by-language breakdowns, last-30-days chart, longest item, recent activity. Persisted across restarts in the `whisper-data` volume.
- **Audio auto-deleted** -- Server deletes uploaded audio file as soon as transcription ends or client disconnects
- **Footer version + links** -- All pages footer shows commit short hash linking to GitHub commit, plus GitHub repo and `@jumpdest7d` X link

## Architecture

Single Docker container running:
- **Node.js / Express** (TypeScript) backend -- serves static frontend + REST API
- **Python / faster-whisper** -- called as a child process from Node for transcription

```
Browser  ->  Express (port 4000)  ->  python3 transcribe.py  ->  SSE stream
                |
         Static HTML/JS/CSS (single file)
```

Transcription progress is streamed to the browser via Server-Sent Events (SSE). The Python script emits structured JSON to stderr for download progress and status updates, which Node bridges to the SSE stream.

## Project Structure

```
whisper-it/
├── docker-compose.yml       # Single service, port 4000, model + data volumes, mem_limit 4g
├── Dockerfile               # node:20-slim + Python 3 + faster-whisper, thread caps + commit ARG
├── Makefile                 # make run/build/logs/clean (injects COMMIT_HASH=$(git rev-parse HEAD))
├── .dockerignore
├── package.json             # Express, multer, archiver, TypeScript
├── tsconfig.json
├── transcribe.py            # Python: loads faster-whisper, transcribes, JSON out; cpu_threads/num_workers/beam_size from env
└── src/
    ├── server.ts            # Express: /api/transcribe (SSE) + /api/stats + /api/zip + /api/version, static
    ├── stats.ts             # Atomic JSON stats store backed by /data/stats.json
    └── public/
        ├── index.html       # Main UI: record / multi-upload queue / history / footer
        └── stats.html       # Stats dashboard
```

## Key Design Decisions

- **faster-whisper** over vanilla whisper -- faster on CPU, lower memory via CTranslate2 int8 quantization
- **Child process** approach -- Node spawns `python3 transcribe.py` per request. Simple, no IPC complexity. Fine for single-user use.
- **Single HTML file per page** -- all CSS/JS inline, no build step for frontend. Keeps it minimal.
- **No auth** -- intended for use behind a VPN or reverse proxy that handles auth. Keeps the app simple.
- **Models cached in Docker volume** (`whisper-models:/models`) -- first transcription with a new model triggers download, subsequent runs reuse it.
- **Stats in separate Docker volume** (`whisper-data:/data`) -- atomic-write JSON file, survives container restarts and rebuilds. Browser localStorage is for per-user history; the server stats are an aggregate counter.
- **Audio is never retained server-side** -- multer writes to `/tmp/whisper-uploads/`; `cleanup()` deletes on close / error / client disconnect (idempotent guard). Server startup sweeps `/tmp/whisper-uploads/*` and orphan `/tmp/whisper-chunks-*` dirs.
- **SIGTERM-safe Python** -- `transcribe.py` registers SIGTERM/SIGINT/atexit handlers that nuke its chunk dir before exit, so killing the Python process (client disconnect, container restart) doesn't leak temp files.
- **Server-side zip via `archiver`** -- client posts `{files:[{name,text}]}` to `/api/zip`, server streams a STORE+DEFLATE zip. Sanitizes names + dedupes within zip.
- **Thread fan-out caps** -- `WHISPER_CPU_THREADS=2` + `WHISPER_NUM_WORKERS=1` + `OMP/MKL/OPENBLAS_NUM_THREADS=2` baked in. ctranslate2 otherwise allocates per-thread scratch buffers proportional to CPU count, which OOMs even on `base` for high-core hosts.
- **Build-time commit injection** -- `Dockerfile` accepts `ARG COMMIT_HASH`, exposes via `WHISPER_COMMIT` env. `compose.yml` passes `${COMMIT_HASH:-dev}`. `Makefile` does `git rev-parse HEAD` automatically. Footer renders short hash → linked to exact GitHub commit.

## API

### POST /api/transcribe
- **Content-Type:** multipart/form-data
- **Fields:** `audio` (file, required), `model` (string, optional -- default "small"), `language` (string, optional -- ISO 639-1 or "auto", default "auto"), `filename` (string, optional), `fromRecording` (string "true"/"false", optional)
- **Response:** SSE stream with events: `loading_model`, `downloading` (with progress %), `chunking` (long audio only, includes `duration`), `chunked` (long audio only, includes `total` + `chunk_seconds`), `transcribing` (with `chunk` + `total` for long audio), `result` (with text, segments, language, duration), `error` (with descriptive message; OOM is detected via SIGKILL / null exit code and reported with model name)
- **Max file size:** 100MB
- Audio file is deleted from disk immediately after the request completes.

### GET /api/stats
Aggregate stats JSON used by `/stats.html`. See `src/stats.ts` for shape.

### POST /api/zip
Body `{files: [{name, text}], zipName}` → returns `application/zip` attachment.

### GET /api/version
Returns `{commit, short, isReal, commitUrl, github, x, xHandle}` for the footer.

## Tunable env

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `4000` | HTTP port |
| `WHISPER_MODELS_DIR` | `/models` | model weight cache |
| `WHISPER_DATA_DIR` | `/data` | stats.json location |
| `WHISPER_COMMIT` | `dev` | injected via build arg |
| `WHISPER_CPU_THREADS` | `2` | ctranslate2 cpu threads |
| `WHISPER_NUM_WORKERS` | `1` | ctranslate2 workers |
| `WHISPER_BEAM_SIZE` | `5` | decoder beam |
| `WHISPER_CHUNK_THRESHOLD_SEC` | `1200` | audio > N sec triggers ffmpeg chunking |
| `WHISPER_CHUNK_SECONDS` | `600` | chunk length when chunking kicks in |
| `OMP_NUM_THREADS` / `MKL_NUM_THREADS` / `OPENBLAS_NUM_THREADS` | `2` | BLAS thread caps |

## Development (without Docker)

Requires Node 20+ and Python 3.10+ with faster-whisper installed.

```bash
npm install
pip install faster-whisper
WHISPER_MODELS_DIR=./models WHISPER_DATA_DIR=./data npm run dev
```

## Status

- All source files compile clean (`npx tsc --noEmit` passes)
- Docker build and run tested via `make run`
- End-to-end tested: single upload, multi-file batch, recording, transcription, re-transcribe, .txt download, .zip batch download, stats page, footer commit link, OOM error path with diagnostic message
