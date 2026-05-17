# Real-world speech corpora for diarization testing

The synthesized eSpeak fixtures in this directory are good enough for CI smoke tests but
they are robotic and do not exercise the hard cases pyannote needs to handle in the wild
(overlap, channel noise, accent variety, room reverb, gender mix). For deeper manual
validation of the on-device diarization path (`WHISPER_DIARIZE=1`), pull samples from one
of the corpora below.

None of these are committed to the repo. All are too large for CI; treat them as
**developer-side fixtures** for ad-hoc runs.

## VoxConverse

- **Use case:** in-the-wild multi-speaker conversation from YouTube. Real overlap,
  background music, varied recording quality. Closest match to "podcast / livestream"
  audio that users are likely to throw at whisper-it.
- **Size:** ~50 h dev + ~20 h test. Individual clips range from a few minutes to ~25 min.
  Pick a single clip first; do not download the whole archive.
- **Annotations:** RTTM speaker turns (per-segment start/end + speaker id).
- **License:** Apache 2.0 (annotations); audio is YouTube-derived, redistributed for
  research use only — do not re-upload clips.
- **URL:** https://github.com/joonson/voxconverse
- **Good for:** smoke-testing pyannote labels against known ground-truth RTTM.

## AMI Meeting Corpus

- **Use case:** ~100 h of scripted and unscripted business-meeting recordings with 4
  speakers and multiple microphones (headset, lapel, far-field array). Heavy
  cross-talk; closest match to the "conference call / standup recording" use case.
- **Size:** ~100 GB at full fidelity. Each meeting is 30-60 min. Use the
  **Mix-Headset** track for a single-channel diarization smoke test.
- **Annotations:** speaker labels, transcripts, dialogue acts. Multiple formats.
- **License:** CC BY 4.0 — free for any use including derivative works, with
  attribution.
- **URL:** https://groups.inf.ed.ac.uk/ami/corpus/
- **Good for:** stress-testing 4-speaker diarization plus the chunking path
  (`WHISPER_CHUNK_THRESHOLD_SEC=1200`) since meetings exceed 20 minutes.

## DIHARD III Challenge

- **Use case:** diverse domains — child speech, restaurant noise, court proceedings,
  webinar audio, broadcast interviews. Designed to break naive diarizers.
- **Size:** ~30 h dev + ~30 h eval, split across 11 domains. A single domain (e.g.
  `restaurant`) is ~3 h and a useful slice on its own.
- **Annotations:** RTTM, scoring scripts (`dscore`), per-domain breakdown.
- **License:** LDC distribution — registration + free academic license required;
  commercial use is paid. Check the LDC catalog entry before downloading.
- **URL:** https://dihardchallenge.github.io/dihard3/
- **Good for:** regression-testing pyannote against pathological cases (overlap,
  child voices, low SNR) and benchmarking accuracy with `dscore` against published
  DER (diarization error rate) numbers.

## Running a corpus sample through whisper-it

For any of these, prefer a single clip <100 MB (the `/api/transcribe` upload cap).

```bash
# Trim a long file to 10 minutes if needed
ffmpeg -i input.wav -t 600 -ac 1 -ar 16000 sample.wav

# Upload via the UI: drag onto the drop zone, tick "Attribute speakers" toggle,
# transcribe. Watch the SSE stream in devtools or:
docker compose logs -f whisper-it

# Compare the produced speaker labels against the corpus RTTM by eye, or use
# pyannote's `pyannote.metrics` package for a numeric DER if you want rigor.
```

## What about CI

CI uses only the synthetic eSpeak fixtures (`tests/fixtures/audio/conv-*.mp3` and
friends) because they are reproducible, small, and license-clean. The corpora above
are explicitly for **manual / nightly-cron** validation by a human.

If you find pyannote regressing on a specific real clip and want a permanent
regression test for it, add a stripped-down derivative (a few seconds, clearly
attributed in this file) to `tests/fixtures/audio/` and wire a Playwright spec
under the nightly workflow — but check the licence first.
