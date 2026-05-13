#!/usr/bin/env python3
import argparse
import atexit
import json
import os
import signal
import sys

_TEMP_FILES = set()

def _cleanup():
    for f in list(_TEMP_FILES):
        try: os.unlink(f)
        except Exception: pass
        _TEMP_FILES.discard(f)

def _sig(signum, frame):
    _cleanup()
    sys.exit(128 + signum)

signal.signal(signal.SIGTERM, _sig)
signal.signal(signal.SIGINT, _sig)
atexit.register(_cleanup)


def emit(obj):
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def merge(whisper_segments, turns):
    """For each whisper segment, label with the speaker that overlaps it the most."""
    labeled = []
    for seg in whisper_segments:
        s_start = float(seg["start"])
        s_end = float(seg["end"])
        best_speaker = None
        best_overlap = 0.0
        for t in turns:
            overlap = max(0.0, min(s_end, t["end"]) - max(s_start, t["start"]))
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = t["speaker"]
        labeled.append({
            "start": s_start,
            "end": s_end,
            "text": seg["text"],
            "speaker": best_speaker or "SPEAKER_??",
        })
    return labeled


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, help="audio file path")
    args = parser.parse_args()

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
        whisper_segments = payload["segments"]
    except Exception as e:
        emit({"status": "error", "error": f"Invalid segments JSON on stdin: {e}"})
        sys.exit(2)

    hf_token = os.environ.get("HF_TOKEN", "").strip()
    if not hf_token:
        emit({
            "status": "error",
            "error": "HF_TOKEN env var required for diarization. Accept model terms at https://huggingface.co/pyannote/speaker-diarization-3.1 then set HF_TOKEN.",
        })
        sys.exit(3)

    emit({"status": "loading_diarizer"})

    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as e:
        emit({"status": "error", "error": f"Diarization dependencies missing: {e}"})
        sys.exit(4)

    cpu_threads = int(os.environ.get("WHISPER_CPU_THREADS", "2"))
    torch.set_num_threads(cpu_threads)
    model_dir = os.environ.get("WHISPER_MODELS_DIR", "/models")

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
            cache_dir=model_dir,
        )
    except Exception as e:
        emit({"status": "error", "error": f"Failed to load pyannote pipeline: {e}"})
        sys.exit(5)

    emit({"status": "diarizing"})

    try:
        diarization = pipeline(args.file)
    except Exception as e:
        emit({"status": "error", "error": f"Diarization run failed: {e}"})
        sys.exit(6)

    turns = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        turns.append({
            "start": round(turn.start, 2),
            "end": round(turn.end, 2),
            "speaker": speaker,
        })

    labeled = merge(whisper_segments, turns)
    speakers = sorted({s["speaker"] for s in labeled if s["speaker"] != "SPEAKER_??"})

    print(json.dumps({"segments": labeled, "speakers": speakers, "turns": turns}))


if __name__ == "__main__":
    main()
