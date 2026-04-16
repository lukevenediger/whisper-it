#!/usr/bin/env python3
import argparse
import json
import sys
import os

from faster_whisper import WhisperModel

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    model_dir = os.environ.get("WHISPER_MODELS_DIR", "/models")

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=model_dir,
    )

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
