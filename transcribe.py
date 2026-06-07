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

# Track temp dirs/files for cleanup on signal/exit
_TEMP_DIRS = set()
_TEMP_FILES = set()

def _cleanup_temp_dirs():
    for d in list(_TEMP_DIRS):
        try:
            shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass
        _TEMP_DIRS.discard(d)
    for f in list(_TEMP_FILES):
        try:
            os.unlink(f)
        except OSError:
            pass
        _TEMP_FILES.discard(f)

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

from faster_whisper import WhisperModel  # noqa: E402  (must follow patch_tqdm)


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


def _build_result(segments, language, total_duration):
    return {
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
        "language": language or "",
        "duration": round(total_duration or 0.0, 2),
    }


def run_chunked(per_chunk_fn, src_path, chunk_sec, total_duration):
    """Split audio into chunks, transcribe each via per_chunk_fn, offset timestamps.

    per_chunk_fn(chunk_path) -> (segments, language) where segments is an iterable
    of (start, end, text) tuples relative to the chunk. Engine-agnostic, so both
    the Whisper and Parakeet paths reuse the same chunk loop + per-chunk progress.
    """
    chunk_paths, tmpdir = chunk_audio(src_path, chunk_sec)
    n = len(chunk_paths)
    emit({"status": "chunked", "total": n, "chunk_seconds": chunk_sec})

    all_segments = []
    detected_language = None

    try:
        for i, cp in enumerate(chunk_paths):
            emit({"status": "transcribing", "chunk": i + 1, "total": n})
            segments, language = per_chunk_fn(cp)
            if detected_language is None:
                detected_language = language
            offset = i * chunk_sec
            for start, end, text in segments:
                all_segments.append({
                    "start": round(start + offset, 2),
                    "end": round(end + offset, 2),
                    "text": text.strip(),
                })
            try:
                os.unlink(cp)
            except OSError:
                pass
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        _TEMP_DIRS.discard(tmpdir)

    return _build_result(all_segments, detected_language, total_duration)


# ---- Whisper engine (faster-whisper) ----

def whisper_chunk_fn(model, beam_size, language):
    def fn(chunk_path):
        segments, info = model.transcribe(
            chunk_path,
            beam_size=beam_size,
            vad_filter=True,
            condition_on_previous_text=False,
            language=language,
        )
        return ((seg.start, seg.end, seg.text) for seg in segments), info.language
    return fn


def transcribe_single(model, src_path, beam_size, language):
    segments, info = model.transcribe(
        src_path,
        beam_size=beam_size,
        vad_filter=True,
        language=language,
    )
    result_segments = [
        {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()}
        for seg in segments
    ]
    return _build_result(result_segments, info.language, info.duration)


# ---- Parakeet engine (onnx-asr) ----

def to_wav16k(src_path):
    """Convert arbitrary audio to 16 kHz mono PCM WAV for onnx-asr. Returns temp path."""
    fd, wav_path = tempfile.mkstemp(prefix="whisper-pk-", suffix=".wav")
    os.close(fd)
    _TEMP_FILES.add(wav_path)
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", src_path,
            "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le",
            wav_path,
        ],
        stderr=subprocess.DEVNULL,
    )
    return wav_path


def load_parakeet():
    import onnx_asr  # lazy: pulls onnxruntime only on the Parakeet path

    model_id = os.environ.get("WHISPER_PARAKEET_MODEL", "nemo-parakeet-tdt-0.6b-v3")
    asr = onnx_asr.load_model(model_id, quantization="int8")
    vad = onnx_asr.load_vad("silero")
    return asr.with_vad(vad)


def _iter_segments(result):
    """Flatten onnx-asr recognize() output into SegmentResult-like objects.

    recognize() may return a single result or a (possibly nested) iterable of
    per-speech-segment results; normalize defensively to a flat sequence.
    """
    if result is None:
        return
    if hasattr(result, "start") and hasattr(result, "text"):
        yield result
        return
    try:
        items = iter(result)
    except TypeError:
        return
    for item in items:
        yield from _iter_segments(item)


def parakeet_chunk_fn(adapter):
    def fn(chunk_path):  # chunk_path is already 16 kHz mono WAV (from chunk_audio)
        result = adapter.recognize(chunk_path)
        segs = [(float(s.start), float(s.end), s.text) for s in _iter_segments(result)]
        return segs, ""  # Parakeet v3 auto-detects; no language code returned
    return fn


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        default="parakeet-v3",
        choices=["parakeet-v3", "tiny", "base", "small", "medium", "large-v3"],
    )
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

    if args.model == "parakeet-v3":
        adapter = load_parakeet()
        per_chunk = parakeet_chunk_fn(adapter)
        if will_chunk:
            result = run_chunked(per_chunk, args.file, chunk_seconds, duration)
        else:
            emit({"status": "transcribing"})
            wav = to_wav16k(args.file)
            try:
                segments, lang = per_chunk(wav)
            finally:
                try:
                    os.unlink(wav)
                except OSError:
                    pass
                _TEMP_FILES.discard(wav)
            result = _build_result(
                [{"start": round(s, 2), "end": round(e, 2), "text": t.strip()} for s, e, t in segments],
                lang,
                duration,
            )
    else:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=model_dir,
            cpu_threads=cpu_threads,
            num_workers=num_workers,
        )
        if will_chunk:
            result = run_chunked(whisper_chunk_fn(model, beam_size, language), args.file, chunk_seconds, duration)
        else:
            emit({"status": "transcribing"})
            result = transcribe_single(model, args.file, beam_size, language)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
