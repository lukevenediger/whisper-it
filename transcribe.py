#!/usr/bin/env python3
import argparse
import atexit
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# Track temp dirs for cleanup on signal/exit
_TEMP_DIRS = set()

def _cleanup_temp_dirs():
    for d in list(_TEMP_DIRS):
        try:
            shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass
        _TEMP_DIRS.discard(d)

def _sigterm_handler(signum, frame):
    _cleanup_temp_dirs()
    sys.exit(128 + signum)

signal.signal(signal.SIGTERM, _sigterm_handler)
signal.signal(signal.SIGINT, _sigterm_handler)
atexit.register(_cleanup_temp_dirs)


def emit(obj):
    """Write a JSON object to stderr for progress reporting."""
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def patch_tqdm():
    """Monkey-patch tqdm to capture download progress and emit structured JSON to stderr.

    huggingface_hub uses tqdm (via tqdm.auto) for download progress bars.
    We intercept __init__ and update to emit JSON progress events instead.
    This must be called BEFORE importing faster_whisper, which triggers tqdm loading.
    """
    import tqdm
    import tqdm.auto

    _original_init = tqdm.tqdm.__init__
    _original_update = tqdm.tqdm.update

    def _patched_init(self, *args, **kwargs):
        _original_init(self, *args, **kwargs)
        self._last_emit_time = 0
        if self.total and self.total > 1_000_000:
            self._emit_progress = True
            emit({
                "status": "downloading",
                "progress": 0,
                "total": self.total,
            })
        else:
            self._emit_progress = False

    def _patched_update(self, n=1):
        _original_update(self, n)
        if getattr(self, "_emit_progress", False) and self.total:
            now = time.monotonic()
            if now - self._last_emit_time >= 0.5 or self.n >= self.total:
                self._last_emit_time = now
                pct = round((self.n / self.total) * 100, 1)
                emit({
                    "status": "downloading",
                    "progress": pct,
                    "total": self.total,
                })

    tqdm.tqdm.__init__ = _patched_init
    tqdm.tqdm.update = _patched_update
    tqdm.auto.tqdm = tqdm.tqdm


patch_tqdm()

from faster_whisper import WhisperModel


def ffprobe_duration(path):
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            stderr=subprocess.DEVNULL,
        )
        return float(out.decode().strip())
    except Exception:
        return None


def chunk_audio(path, chunk_sec):
    """Split audio into mono 16kHz WAV chunks via ffmpeg. Returns (chunk_paths, tmpdir)."""
    tmpdir = tempfile.mkdtemp(prefix="whisper-chunks-")
    _TEMP_DIRS.add(tmpdir)
    pattern = os.path.join(tmpdir, "chunk%04d.wav")
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", path,
            "-ac", "1", "-ar", "16000",
            "-f", "segment",
            "-segment_time", str(chunk_sec),
            "-c:a", "pcm_s16le",
            pattern,
        ],
        stderr=subprocess.DEVNULL,
    )
    chunks = sorted(glob.glob(os.path.join(tmpdir, "chunk*.wav")))
    return chunks, tmpdir


def transcribe_chunked(model, src_path, chunk_sec, beam_size, total_duration, language):
    chunk_paths, tmpdir = chunk_audio(src_path, chunk_sec)
    n = len(chunk_paths)
    emit({"status": "chunked", "total": n, "chunk_seconds": chunk_sec})

    all_segments = []
    full_text_parts = []
    detected_language = None

    try:
        for i, cp in enumerate(chunk_paths):
            emit({"status": "transcribing", "chunk": i + 1, "total": n})
            segments, info = model.transcribe(
                cp,
                beam_size=beam_size,
                vad_filter=True,
                condition_on_previous_text=False,
                language=language,
            )
            if detected_language is None:
                detected_language = info.language
            offset = i * chunk_sec
            for seg in segments:
                all_segments.append({
                    "start": round(seg.start + offset, 2),
                    "end": round(seg.end + offset, 2),
                    "text": seg.text.strip(),
                })
                full_text_parts.append(seg.text.strip())
            try:
                os.unlink(cp)
            except OSError:
                pass
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _TEMP_DIRS.discard(tmpdir)

    return {
        "text": " ".join(full_text_parts),
        "segments": all_segments,
        "language": detected_language or "",
        "duration": round(total_duration or 0.0, 2),
    }


def transcribe_single(model, src_path, beam_size, language):
    segments, info = model.transcribe(
        src_path,
        beam_size=beam_size,
        vad_filter=True,
        language=language,
    )

    result_segments = []
    full_text_parts = []

    for segment in segments:
        result_segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        })
        full_text_parts.append(segment.text.strip())

    return {
        "text": " ".join(full_text_parts),
        "segments": result_segments,
        "language": info.language,
        "duration": round(info.duration, 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--file", required=True)
    parser.add_argument("--language", default=None, help="ISO 639-1 language code (e.g. 'en'). Omit for auto-detect.")
    args = parser.parse_args()
    language = args.language if args.language and args.language.lower() != "auto" else None

    model_dir = os.environ.get("WHISPER_MODELS_DIR", "/models")
    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS", "2"))
    num_workers = int(os.environ.get("WHISPER_NUM_WORKERS", "1"))
    beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
    long_threshold = int(os.environ.get("WHISPER_CHUNK_THRESHOLD_SEC", "1200"))  # 20 min
    chunk_seconds = int(os.environ.get("WHISPER_CHUNK_SECONDS", "600"))  # 10 min

    duration = ffprobe_duration(args.file)
    will_chunk = duration is not None and duration > long_threshold

    if will_chunk:
        emit({"status": "chunking", "duration": round(duration, 2)})

    emit({"status": "loading_model"})

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=model_dir,
        cpu_threads=cpu_threads,
        num_workers=num_workers,
    )

    if will_chunk:
        result = transcribe_chunked(model, args.file, chunk_seconds, beam_size, duration, language)
    else:
        emit({"status": "transcribing"})
        result = transcribe_single(model, args.file, beam_size, language)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
