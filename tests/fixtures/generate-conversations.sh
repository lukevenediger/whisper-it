#!/usr/bin/env bash
# Generate multi-speaker conversation fixtures in mp3 format.
# Reads dialogue scripts (one line per turn: "VOICE|text") from
# tests/fixtures/dialogues/ and produces:
#   conv-2p-1min.mp3   conv-2p-10min.mp3
#   conv-3p-1min.mp3   conv-3p-10min.mp3
#
# Idempotent. Re-runs overwrite. Outputs to tests/fixtures/audio/.
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

# Map dialogue speaker letter -> espeak-ng voice variant
voice_for() {
  case "$1" in
    A) echo "en+f3" ;;  # Alice — female
    B) echo "en+m3" ;;  # Bob   — male
    C) echo "en+f5" ;;  # Carol — female (different timbre)
    *) echo "en" ;;
  esac
}

# Render a dialogue script into a single mono 16kHz wav (concatenated turns).
render_dialogue_to_wav() {
  local script="$1" outwav="$2"
  local tmpdir
  tmpdir=$(mktemp -d -t whisper-conv-XXXXXX)
  local list="$tmpdir/list.txt"
  : > "$list"
  local i=0
  while IFS='|' read -r voice text; do
    [ -z "$voice" ] && continue
    case "$voice" in \#*) continue ;; esac
    local part="$tmpdir/part-$(printf %04d "$i").wav"
    espeak-ng -v "$(voice_for "$voice")" -s 165 -w "$part" -- "$text"
    echo "file '$part'" >> "$list"
    i=$((i + 1))
  done < "$script"

  ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -ar 16000 -ac 1 "$outwav"
  rm -rf "$tmpdir"
}

# Loop a source wav until target_sec is reached, then encode to mp3.
loop_and_encode_mp3() {
  local src_wav="$1" outmp3="$2" target_sec="$3"
  local dur
  dur=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$src_wav")
  # round up
  local dur_int
  dur_int=$(awk -v d="$dur" 'BEGIN{printf "%d", (d == int(d) ? d : int(d)+1)}')
  local loops=1
  if [ "$dur_int" -lt "$target_sec" ]; then
    loops=$(( (target_sec + dur_int - 1) / dur_int ))
  fi
  local tmp_dir tmp
  tmp_dir=$(mktemp -d -t whisper-conv-loop-XXXXXX)
  tmp="$tmp_dir/looped.wav"
  ffmpeg -y -loglevel error -stream_loop $((loops - 1)) -i "$src_wav" -c copy "$tmp"
  ffmpeg -y -loglevel error -i "$tmp" -t "$target_sec" -c:a libmp3lame -b:a 64k -ac 1 -ar 22050 "$outmp3"
  rm -rf "$tmp_dir"
}

build() {
  local script="$1" base_label="$2"
  local base_wav="$out/_${base_label}.wav"
  echo "==> rendering $base_label base dialogue"
  render_dialogue_to_wav "$script" "$base_wav"
  echo "==> $out/${base_label}-1min.mp3"
  loop_and_encode_mp3 "$base_wav" "$out/${base_label}-1min.mp3" 60
  echo "==> $out/${base_label}-10min.mp3"
  loop_and_encode_mp3 "$base_wav" "$out/${base_label}-10min.mp3" 600
  rm -f "$base_wav"
}

build tests/fixtures/dialogues/conv-2p.txt conv-2p
build tests/fixtures/dialogues/conv-3p.txt conv-3p

echo
echo "Generated:"
ls -lh "$out"/conv-*.mp3
