#!/usr/bin/env python3
import argparse
import json
import sys
import os
import time


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
        # Only emit progress for large downloads (>1MB)
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
            # Throttle: emit at most every 0.5 seconds, or on completion
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

    # Ensure huggingface_hub's auto-tqdm picks up our patched version
    tqdm.auto.tqdm = tqdm.tqdm


# Patch tqdm BEFORE importing faster_whisper (the import triggers tqdm loading)
patch_tqdm()

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    model_dir = os.environ.get("WHISPER_MODELS_DIR", "/models")

    emit({"status": "loading_model"})

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=model_dir,
    )

    emit({"status": "transcribing"})

    segments, info = model.transcribe(args.file, beam_size=5)

    result_segments = []
    full_text_parts = []

    for segment in segments:
        result_segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        })
        full_text_parts.append(segment.text.strip())

    result = {
        "text": " ".join(full_text_parts),
        "segments": result_segments,
        "language": info.language,
        "duration": round(info.duration, 2),
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
