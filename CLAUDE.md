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

### Optional: enable speaker attribution

Speaker attribution is cloud-only (LLM-based) and is opt-in per transcript -- never inline with normal transcription.

```bash
cp .env.example .env
$EDITOR .env       # fill in OPENROUTER_API_KEY
make run
```

- Set `OPENROUTER_API_KEY=sk-or-...` (https://openrouter.ai/keys) to expose a server-side key.
- Users without a server key can paste their own in the attribute screen (BYOK).
- On a transcript: click **Attribute** → fill in speaker names + roles + expected speaker count → submit. The result lands as a new sibling history entry; the original is never overwritten. Ambiguous segments are highlighted; click **Refine** to add more context and re-run.

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
- **Speaker attribution (opt-in, cloud)** -- Open any history item → **Attribute** → `/attribute.html`. Provide speaker names + roles, expected speaker count, and optional context. Calls OpenRouter (server key or BYOK) for a named-speaker JSON assignment. Ambiguous segments are highlighted; **Refine** lets you add more context and re-run without leaving the screen. Result is saved as a new sibling history entry — the original is never overwritten. Never inline with the basic transcribe flow.
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
├── docker-compose.yml       # Single service, port 4000, model + data volumes, mem_limit 8g, env passthrough
├── Dockerfile               # node:20-slim + Python 3 + faster-whisper, thread caps + commit ARG
├── Makefile                 # make run/build/logs/clean (injects COMMIT_HASH=$(git rev-parse HEAD))
├── .dockerignore
├── .env.example             # Documented template for OPENROUTER_API_KEY + WHISPER_DEBUG_FIXTURES
├── package.json             # Express, multer, archiver, TypeScript + test/lint deps
├── tsconfig.json
├── transcribe.py            # Python: loads faster-whisper, transcribes, JSON out; cpu_threads/num_workers/beam_size from env
├── src/
│   ├── server.ts            # Thin entry: imports app, runs startupSweep, calls app.listen
│   ├── app.ts               # Configured Express app: /api/transcribe (SSE) + /api/stats + /api/zip + /api/version + /api/attribute + /api/debug/fixtures, static. Exported for in-process supertest.
│   ├── stats.ts             # Atomic JSON stats store backed by /data/stats.json
│   ├── lib/
│   │   ├── attribution.ts   # buildAttributionPrompt + applyAssignments (markdown-fence / prose-recovery / ambiguous + notes / fallback)
│   │   ├── sanitize.ts      # sanitizeZipName
│   │   └── words.ts         # countWords
│   └── public/
│       ├── index.html       # Main UI: record / multi-upload queue / history / footer / debug-fixtures strip
│       ├── stats.html       # Stats dashboard
│       └── attribute.html   # Cloud post-process: speaker attribution via OpenRouter (server key or BYOK), with speaker count + iteration
├── tests/
│   ├── unit/                # vitest TS
│   ├── integration/         # supertest in-process + msw + live OpenRouter + live transcribe via running container
│   ├── e2e/                 # Playwright specs (basic, retranscribe, batch, language, history, recording, attribute, mobile)
│   └── fixtures/
│       ├── generate-audio.sh    # espeak-ng + ffmpeg → short/medium/multispeaker/silence-padded/spanish/long.wav
│       ├── transcripts/         # Loose-match expected substrings
│       └── audio/               # Generated, gitignored
├── vitest.config.ts          # node env, forks pool, dotenv setup, v8 coverage
├── playwright.config.ts      # chromium / webkit / mobile-iphone / chromium-fake-audio projects; webServer skipped via E2E_NO_SERVER
├── eslint.config.mjs         # flat config, @typescript-eslint, prettier compat
├── .prettierrc + .prettierignore
├── ruff.toml + pytest.ini + requirements-dev.txt
└── .github/workflows/
    ├── ci.yml                # lint / typecheck / unit / integration / e2e / docker-build (parallel, cancel-in-progress)
    └── publish.yml           # Multi-arch Docker Hub push on main + semver tags
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

### POST /api/attribute

Cloud post-process for speaker attribution. Calls OpenRouter on the server's behalf.

- **Content-Type:** application/json
- **Body:** `{ segments: [{start, end, text}], speakers: [{name, description?}], speakerCount?: number | "auto", extraContext?: string, model?, byokKey? }`
- **Auth:** uses `byokKey` if provided, else `process.env.OPENROUTER_API_KEY`. Returns an error if neither is set.
- **Response:** SSE stream — `attributing` (with `model`, `segmentCount`, `speakerCount`, `rosterSize`), `result` (with merged `segments`, `speakers` array, `ambiguous` index list, `notes` string, optional `warning`), `error`.
- **Privacy:** request body is never logged. The key is read into memory once per request and forwarded to OpenRouter only.

### Debug-only endpoints (gated by `WHISPER_DEBUG_FIXTURES=1`)

- `GET /api/debug/fixtures` — list audio fixtures mounted at `/fixtures` (compose mounts `tests/fixtures/audio:/fixtures:ro`).
- `GET /api/debug/fixture-file/:name` — serves a single fixture for the UI's debug picker. Path-validated; 404 when feature disabled.

### GET /api/stats

Aggregate stats JSON used by `/stats.html`. See `src/stats.ts` for shape.

### POST /api/zip

Body `{files: [{name, text}], zipName}` → returns `application/zip` attachment.

### GET /api/version

Returns `{commit, short, isReal, commitUrl, github, x, xHandle, hasServerKey, hasDebugFixtures}`. `hasServerKey` reflects whether `OPENROUTER_API_KEY` is set; `hasDebugFixtures` reflects whether the debug fixtures dropdown is enabled. Client uses these to gate UI controls.

## Tunable env

| Var                                                            | Default   | Notes                                                                                                                                |
| -------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                         | `4000`    | HTTP port                                                                                                                            |
| `WHISPER_MODELS_DIR`                                           | `/models` | model weight cache                                                                                                                   |
| `WHISPER_DATA_DIR`                                             | `/data`   | stats.json location                                                                                                                  |
| `WHISPER_COMMIT`                                               | `dev`     | injected via build arg                                                                                                               |
| `WHISPER_CPU_THREADS`                                          | `2`       | ctranslate2 cpu threads                                                                                                              |
| `WHISPER_NUM_WORKERS`                                          | `1`       | ctranslate2 workers                                                                                                                  |
| `WHISPER_BEAM_SIZE`                                            | `5`       | decoder beam                                                                                                                         |
| `WHISPER_CHUNK_THRESHOLD_SEC`                                  | `1200`    | audio > N sec triggers ffmpeg chunking                                                                                               |
| `WHISPER_CHUNK_SECONDS`                                        | `600`     | chunk length when chunking kicks in                                                                                                  |
| `OMP_NUM_THREADS` / `MKL_NUM_THREADS` / `OPENBLAS_NUM_THREADS` | `2`       | BLAS thread caps                                                                                                                     |
| `OPENROUTER_API_KEY`                                           | _(unset)_ | OpenRouter API key for `/api/attribute` cloud attribution. Optional -- users can BYOK in the attribute screen instead. Never logged. |
| `WHISPER_DEBUG_FIXTURES`                                       | `0`       | Set `1` to expose `tests/fixtures/audio/*` as a dropdown + Run button in the UI. Compose mounts the fixtures dir at `/fixtures:ro`.  |

## Development (without Docker)

Requires Node 20+ and Python 3.10+ with faster-whisper installed.

```bash
npm install
pip install faster-whisper
WHISPER_MODELS_DIR=./models WHISPER_DATA_DIR=./data npm run dev
```

## Testing

Three layers, runnable independently. All tests follow loose-substring matching for transcription output (whisper is non-deterministic word-for-word).

```bash
# Unit tests
npm run test:unit              # vitest, TS only
npm run test:py                # pytest (needs pip install -r requirements-dev.txt)

# Integration tests (in-process Express + msw + real OpenRouter if key is in .env)
npm run test:integration

# E2E (Playwright) — runs against npm run dev by default,
# or against a running Docker container with E2E_BASE_URL + E2E_NO_SERVER
make run
E2E_BASE_URL=http://localhost:4000 E2E_NO_SERVER=1 npm run test:e2e

# Lint + format
npm run lint                   # eslint + prettier --check
npm run lint:fix               # auto-fix
ruff check .                   # python lint

# Coverage
npm run test:coverage          # vitest --coverage (report only, no threshold)

# Audio fixtures (regenerate when adding new clips)
npm run fixtures               # uses espeak-ng + ffmpeg
```

### Test audio fixtures

`tests/fixtures/generate-audio.sh` produces fixtures from text via eSpeak-NG → ffmpeg.

- `short.wav` (~3s, fox), `medium.wav` (~30s), `multispeaker.wav` (two voices concatenated), `silence-padded.wav`, `spanish.wav`, `long.wav` (>60s, triggers chunking)
- Outputs to `tests/fixtures/audio/` which is gitignored
- Required tools: `brew install espeak-ng` on macOS, `apt-get install espeak-ng` on Linux (CI installs this automatically)

`tests/fixtures/generate-conversations.sh` (npm run fixtures:conversations) produces longer multi-speaker dialogues for diarization stress tests, encoded as mp3:

- `conv-2p-1min.mp3` / `conv-2p-10min.mp3` — Alice + Bob (en+f3, en+m3)
- `conv-3p-1min.mp3` / `conv-3p-10min.mp3` — Alice + Bob + Carol (en+f3, en+m3, en+f5)
- Source dialogue scripts live in `tests/fixtures/dialogues/conv-Np.txt` (format: `VOICE|text` per turn). 10-min versions loop the base dialogue to fill the duration.
- mono 22.05 kHz 64 kbps mp3 — small enough to upload through the /api/transcribe 100 MB limit even at 10 minutes (~4.6 MB each)

For real-world validation beyond eSpeak's robotic voices (overlap, accents, room noise), see [tests/fixtures/CORPORA.md](tests/fixtures/CORPORA.md) — pointers to VoxConverse, AMI Meeting Corpus, and DIHARD III with access + licensing notes. These are dev-side only, never in CI.

### Required CI secrets

Set in GitHub repo settings → Secrets and variables → Actions:

| Secret                                   | Purpose                      | Used by                                |
| ---------------------------------------- | ---------------------------- | -------------------------------------- |
| `OPENROUTER_API_KEY`                     | Real cloud-attribution tests | `integration` + `e2e` jobs on every PR |
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Image publishing             | existing `publish` workflow            |

## Status

- All source files compile clean (`npm run typecheck`)
- Lint clean (`npm run lint` + `ruff check .`)
- Unit tests pass (vitest)
- Integration tests pass (supertest, msw, real OpenRouter)
- E2E tests pass (Playwright; chromium + webkit + iPhone projects)
- Docker build and run tested via `make run`
- CI runs lint / typecheck / unit / integration / e2e / docker-build jobs in parallel on every push and PR
- Speaker attribution is cloud-only (OpenRouter LLM with named speakers + ambiguity feedback + iteration). On-device pyannote diarization was removed in favour of this approach — it returned synthetic speaker IDs while users wanted names, and the dep footprint (1GB+ image, 4 conflicting pins, 8GB+ memory, two HF-gated models) was disproportionate.
