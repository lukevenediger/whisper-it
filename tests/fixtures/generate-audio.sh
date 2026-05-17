#!/usr/bin/env bash
# Generate test audio fixtures using espeak-ng + ffmpeg.
# Idempotent — re-running overwrites. Outputs to tests/fixtures/audio/.
# Run from repo root: bash tests/fixtures/generate-audio.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

out="tests/fixtures/audio"
mkdir -p "$out"

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "ERROR: espeak-ng not found." >&2
  echo "  macOS:  brew install espeak-ng" >&2
  echo "  Linux:  apt-get install espeak-ng" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found." >&2
  exit 1
fi

speak() {
  local voice="$1" text="$2" outfile="$3"
  local raw="${outfile%.wav}.raw.wav"
  espeak-ng -v "$voice" -s 160 -w "$raw" "$text"
  ffmpeg -y -loglevel error -i "$raw" -ar 16000 -ac 1 "$outfile"
  rm -f "$raw"
}

echo "==> short.wav"
speak en "The quick brown fox jumps over the lazy dog." "$out/short.wav"

echo "==> medium.wav"
speak en "$(cat tests/fixtures/transcripts/medium.txt)" "$out/medium.wav"

echo "==> multispeaker.wav"
speak en+f3 "Hello, my name is Alice. I work in marketing and I love it." "$out/_alice.wav"
speak en+m3 "Hi Alice, nice to meet you. I am Bob and I work as an engineer." "$out/_bob.wav"
ffmpeg -y -loglevel error -i "$out/_alice.wav" -i "$out/_bob.wav" \
  -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" \
  -ar 16000 -ac 1 "$out/multispeaker.wav"
rm -f "$out/_alice.wav" "$out/_bob.wav"

echo "==> silence-padded.wav"
speak en "Important sentence in the middle." "$out/_speech.wav"
ffmpeg -y -loglevel error -f lavfi -i "anullsrc=r=16000:cl=mono" -t 2 "$out/_silence.wav"
ffmpeg -y -loglevel error -i "$out/_silence.wav" -i "$out/_speech.wav" -i "$out/_silence.wav" \
  -filter_complex "[0][1][2]concat=n=3:v=0:a=1[out]" -map "[out]" \
  -ar 16000 -ac 1 "$out/silence-padded.wav"
rm -f "$out/_silence.wav" "$out/_speech.wav"

echo "==> spanish.wav"
speak es "Hola, me llamo Maria y vivo en Madrid con mi familia." "$out/spanish.wav"

echo "==> long.wav (loop short clip until > 60s)"
ffmpeg -y -loglevel error -stream_loop 25 -i "$out/short.wav" -c copy "$out/long.wav"

echo
echo "Generated:"
ls -la "$out"
