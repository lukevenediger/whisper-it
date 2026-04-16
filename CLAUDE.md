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
- **Local only** -- Just run it on your laptop at `localhost:3000` for personal use.

**Do not** expose Whisper It directly to the public internet without an auth layer in front of it.

## Running

```bash
docker compose up --build
```

Then open http://localhost:3000.

First transcription with a given model will be slower -- it downloads the model weights. Subsequent runs use the cached model from the Docker volume.

## Features

- **Record or upload** -- Record from your mic (with live visualizer) or upload/drop an audio file
- **Auto-transcribe** -- Transcription starts immediately, no extra button clicks
- **Model selection** -- Choose from tiny/base/small/medium/large-v3, default is small
- **Re-transcribe** -- Try a different model on the same audio without re-uploading
- **Download progress** -- Live progress bar when a model is downloading for the first time
- **Waveform display** -- Audacity-style waveform of your audio
- **Share** -- Uses OS-level share sheet (WhatsApp, Telegram, Messages, etc.) on supported browsers
- **Mic selector** -- Pick which microphone to use when multiple are available

## Architecture

Single Docker container running:
- **Node.js / Express** (TypeScript) backend -- serves static frontend + REST API
- **Python / faster-whisper** -- called as a child process from Node for transcription

```
Browser  ->  Express (port 3000)  ->  python3 transcribe.py  ->  SSE stream
                |
         Static HTML/JS/CSS (single file)
```

Transcription progress is streamed to the browser via Server-Sent Events (SSE). The Python script emits structured JSON to stderr for download progress and status updates, which Node bridges to the SSE stream.

## Project Structure

```
whisper-it/
├── docker-compose.yml       # Single service, exposes port 3000, persists models volume
├── Dockerfile               # node:20-slim + Python 3 + faster-whisper + app build
├── .dockerignore
├── package.json             # Express, multer, TypeScript
├── tsconfig.json
├── transcribe.py            # Python script: loads faster-whisper, transcribes file, outputs JSON
└── src/
    ├── server.ts            # Express server: POST /api/transcribe (SSE) + static file serving
    └── public/
        └── index.html       # UI: single file with all CSS/JS inline
```

## Key Design Decisions

- **faster-whisper** over vanilla whisper -- faster on CPU, lower memory via CTranslate2 int8 quantization
- **Child process** approach -- Node spawns `python3 transcribe.py` per request. Simple, no IPC complexity. Fine for single-user use.
- **Single HTML file** -- all CSS/JS inline, no build step for frontend. Keeps it minimal.
- **No auth** -- intended for use behind a VPN or reverse proxy that handles auth. Keeps the app simple.
- **Models cached in Docker volume** (`whisper-models:/models`) -- first transcription with a new model triggers download, subsequent runs reuse it.

## API

### POST /api/transcribe
- **Content-Type:** multipart/form-data
- **Fields:** `audio` (file, required), `model` (string, optional -- default "small")
- **Response:** SSE stream with events: `loading_model`, `downloading` (with progress %), `transcribing`, `result` (with text, segments, language, duration)
- **Max file size:** 100MB

## Development (without Docker)

Requires Node 20+ and Python 3.10+ with faster-whisper installed.

```bash
npm install
pip install faster-whisper
WHISPER_MODELS_DIR=./models npm run dev
```

## Status

- All source files are written and TypeScript compiles clean (`npx tsc --noEmit` passes)
- Docker build and run tested and working
- End-to-end tested: file upload, recording, transcription, re-transcribe, share
