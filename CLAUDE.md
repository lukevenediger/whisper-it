# Whisper It

Local audio transcription web app using faster-whisper. Upload or record audio, get text back.

## Architecture

Single Docker container running:
- **Node.js / Express** (TypeScript) backend — serves static frontend + REST API
- **Python / faster-whisper** — called as a child process from Node for transcription

```
Browser  →  Express (port 3000)  →  python3 transcribe.py  →  JSON response
                ↓
         Static HTML/JS/CSS (single file)
```

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
    ├── server.ts            # Express server: POST /api/transcribe + static file serving
    └── public/
        └── index.html       # UI: model selector, file upload, mic recording, results + copy
```

## Key Design Decisions

- **faster-whisper** over vanilla whisper — faster on CPU, lower memory via CTranslate2 int8 quantization
- **Child process** approach — Node spawns `python3 transcribe.py` per request. Simple, no IPC complexity. Fine for single-user tailnet use.
- **Single HTML file** — all CSS/JS inline, no build step for frontend. Keeps it minimal.
- **Model selection at transcription time** — user picks from tiny/base/small/medium/large-v3 in the UI. Default: small.
- **Models cached in Docker volume** (`whisper-models:/models`) — first transcription with a new model triggers download, subsequent runs reuse it.

## API

### POST /api/transcribe
- **Content-Type:** multipart/form-data
- **Fields:** `audio` (file, required), `model` (string, optional — default "small")
- **Response:** `{ text, segments: [{start, end, text}], language, duration }`
- **Max file size:** 100MB

## Running

```bash
docker compose up --build
```

Then open http://localhost:3000 (or your tailnet hostname:3000).

First transcription with a given model will be slower — it downloads the model weights. Subsequent runs use the cached model from the volume.

## Development (without Docker)

Requires Node 20+ and Python 3.10+ with faster-whisper installed.

```bash
npm install
pip install faster-whisper
WHISPER_MODELS_DIR=./models npm run dev
```

## Status

- All source files are written and TypeScript compiles clean (`npx tsc --noEmit` passes)
- Docker build has NOT been tested yet — Docker Hub pulls were timing out on the original machine
- The app has NOT been end-to-end tested yet
- Next step: build and run the Docker image, then test with a real audio file
