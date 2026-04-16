# Whisper It UI Enhancements Design

## Features

### 1. Recording Visualizer + Timer
- Connect MediaRecorder's stream to a Web Audio `AnalyserNode`
- Render ~20 vertical bars in a `<canvas>` that react to frequency data in real-time
- Show an MM:SS timer that increments every second while recording
- Both appear in place of the drop zone during recording

### 2. Streaming Transcription with Download Progress
- **Backend**: Change `/api/transcribe` from a JSON response to an SSE stream (`text/event-stream`)
- **Python**: Write progress lines to stderr. Patch or monitor huggingface_hub download output to extract percentage. Emit structured status lines like `{"status": "downloading", "progress": 45}` and `{"status": "transcribing"}`
- **Node**: Parse Python stderr line-by-line, send SSE events to the browser for `downloading` (with %) and `transcribing` status. Final event sends the transcription result as JSON.
- **Frontend**: Use `fetch` with streaming reader. Show a progress bar with percentage during download, spinner during transcription.

### 3. Re-transcribe with Model Badge
- Result metadata shows which model was used (e.g. "English - 45s - 12 segments - **small** model")
- A "Re-transcribe" dropdown+button appears in the result area, pre-populated with the other models, letting the user re-run with a different model on the same audio file

### 4. Share Button
- Add a "Share" button next to "Copy" in the result header
- Uses `navigator.share({ text: transcriptionText })` to invoke the OS share sheet
- Falls back to clipboard copy on unsupported browsers
- Button hidden entirely if `navigator.share` is undefined

## Architecture Change

```
Before:  Browser -> POST /api/transcribe -> JSON response
After:   Browser -> POST /api/transcribe -> SSE stream (progress events + final result)
```

The Python script gains stderr progress reporting. Node parses stderr and bridges it to SSE. Frontend switches from fetch().json() to reading an event stream.

## Files Changed

- `src/public/index.html` — all frontend changes (visualizer, progress bar, re-transcribe UI, share button)
- `src/server.ts` — SSE streaming response, stderr parsing
- `transcribe.py` — stderr progress reporting for model downloads
