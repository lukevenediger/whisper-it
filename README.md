# Whisper It

A self-hosted audio transcription web app powered by [faster-whisper](https://github.com/SYSTRAN/faster-whisper). Record from your mic or upload an audio file, get text back. No API keys, no tokens, no accounts, no cloud dependency. Runs entirely on your own hardware in a single Docker container.

## Why I Built This

I kept getting frustrated with cloud-based voice transcription. AI assistants butcher voice notes. Commercial transcription APIs need keys and charge per request. And when I'm on the go and just want to quickly transcribe something from my phone, I don't want to deal with any of that.

OpenAI's Whisper model produces significantly better transcriptions, but using it normally means setting up Python environments, managing dependencies, or paying for API access.

Whisper It wraps all of that into a simple web app: open it in your browser, record or upload, and get your text. It costs nothing to run, your audio never leaves your network, and there's zero setup beyond `docker compose up`.

## Features

- **Record or upload** -- Record directly from your mic (with a live audio level visualizer and timer) or drag-and-drop / browse for an audio file
- **Auto-transcribe** -- Transcription starts immediately when you finish recording or select a file. No extra clicks.
- **Multiple Whisper models** -- Choose from tiny (~75 MB), base (~140 MB), small (~460 MB), medium (~1.5 GB), or large-v3 (~3 GB). Default is small, which balances speed and accuracy well on CPU.
- **Re-transcribe** -- Not happy with the result? Pick a different model and re-transcribe the same audio without re-uploading.
- **Download progress** -- First use of a model downloads it automatically. A live progress bar shows the download percentage.
- **Waveform display** -- See an Audacity-style waveform rendering of your audio.
- **Word count** -- Results show language, duration, word count, segment count, and which model was used.
- **Share** -- Uses the OS-level share sheet (WhatsApp, Telegram, Messages, AirDrop, email, etc.) on supported browsers. Falls back to clipboard copy.
- **Microphone selector** -- When multiple mics are detected, pick the right one from a row of buttons. Your choice is remembered across sessions.
- **Mobile-friendly** -- Works on your phone's browser. Record a voice memo and get text in seconds.

## Quick Start

```bash
git clone https://github.com/lukevenediger/whisper-it.git
cd whisper-it
docker compose up --build
```

Open http://localhost:3000 in your browser.

The first transcription with a given model will be slower because it downloads the model weights (~75 MB to ~3 GB depending on model size). After that, the model is cached in a Docker volume and subsequent transcriptions start immediately.

## Deployment

Whisper It has **no built-in authentication**. It's designed for anonymous access within a trusted network.

### On a VPN (Recommended)

Run it on any machine in your Tailscale, WireGuard, or other VPN network. Anyone on the VPN can open it in their browser and transcribe. This is the intended deployment model: zero friction, trusted network.

```bash
# On your server / NAS / spare machine
docker compose up -d --build

# Access from any device on the VPN
# http://your-machine:3000
```

### Behind Cloudflare Tunnel

If you want to expose it to the internet with access control:

1. Set up a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) pointing to `localhost:3000`
2. Add a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) policy to gate on email, SSO, or one-time PIN

This gives you authentication without modifying the app.

### Local Only

Just run it on your laptop for personal use:

```bash
docker compose up --build
# Open http://localhost:3000
```

**Do not** expose Whisper It directly to the public internet without an auth layer in front of it.

## How It Works

```
Browser  -->  Express (port 3000)  -->  python3 transcribe.py  -->  SSE stream
                 |
          Static HTML/JS/CSS
```

1. The frontend is a single HTML file with all CSS and JavaScript inline. No build step, no framework.
2. When you upload or record audio, it POSTs to `/api/transcribe` on the Express server.
3. Express spawns a Python child process running faster-whisper.
4. Progress (model download %, loading, transcribing) is streamed back to the browser via Server-Sent Events (SSE).
5. The final transcription result is sent as the last SSE event.

Everything runs in a single Docker container: Node.js serves the frontend and API, Python handles transcription. Models are cached in a Docker volume so they persist across restarts.

## Whisper Models

| Model | Size | Speed | Accuracy | Best For |
|-------|------|-------|----------|----------|
| tiny | ~75 MB | Fastest | Lower | Quick drafts, short clips |
| base | ~140 MB | Fast | Moderate | General use when speed matters |
| **small** | ~460 MB | Moderate | **Good** | **Default. Best balance for CPU.** |
| medium | ~1.5 GB | Slower | Better | When accuracy matters more than speed |
| large-v3 | ~3 GB | Slowest | Best | Maximum accuracy, long or complex audio |

All models run on CPU using int8 quantization via CTranslate2 for lower memory usage and faster inference.

## API

If you want to integrate with Whisper It programmatically:

### POST /api/transcribe

**Request:**
```
Content-Type: multipart/form-data
Fields:
  audio: (file, required) -- any audio format supported by ffmpeg
  model: (string, optional) -- "tiny", "base", "small", "medium", or "large-v3". Default: "small"
```

**Response:** Server-Sent Events stream

```
data: {"status":"loading_model"}
data: {"status":"downloading","progress":45.2,"total":483000000}
data: {"status":"transcribing"}
data: {"status":"result","text":"...","segments":[{"start":0,"end":5.2,"text":"..."}],"language":"en","duration":10.5}
```

**Max file size:** 100 MB

## Development

To run without Docker (requires Node 20+ and Python 3.10+):

```bash
npm install
pip install faster-whisper
WHISPER_MODELS_DIR=./models npm run dev
```

## Project Structure

```
whisper-it/
├── docker-compose.yml       # Single service, port 3000, persists models volume
├── Dockerfile               # node:20-slim + Python 3 + faster-whisper
├── package.json             # Express, multer, TypeScript
├── tsconfig.json
├── transcribe.py            # Python: faster-whisper with progress reporting
└── src/
    ├── server.ts            # Express server: SSE transcription endpoint
    └── public/
        └── index.html       # Entire frontend in one file
```

## Requirements

- Docker and Docker Compose
- ~512 MB RAM minimum (tiny model), ~2 GB recommended (small model)
- Audio input device (for recording -- uploading works without one)

## License

MIT
