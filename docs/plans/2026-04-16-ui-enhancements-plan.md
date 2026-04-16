# UI Enhancements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add recording visualizer, streaming download progress, re-transcribe with model selection, and OS-level share button to Whisper It.

**Architecture:** Python stderr emits structured JSON progress lines. Node parses stderr and bridges to SSE (`text/event-stream`). Frontend reads the SSE stream for live progress, uses Web Audio API for recording visualization, and Web Share API for sharing.

**Tech Stack:** Express (TypeScript), faster-whisper (Python), vanilla JS/CSS/HTML (single file frontend), Web Audio API, Web Share API, SSE

---

### Task 1: Python Download Progress Reporting

**Files:**
- Modify: `transcribe.py`

**Context:** faster-whisper uses huggingface_hub internally to download models. huggingface_hub's `snapshot_download` uses `hf_transfer` or `tqdm` for progress. We can monkey-patch tqdm to capture download progress and emit structured JSON to stderr.

**Step 1: Add stderr progress reporting to transcribe.py**

Replace the full content of `transcribe.py` with:

```python
#!/usr/bin/env python3
import argparse
import json
import sys
import os

def emit(obj):
    """Write a JSON status line to stderr for the Node process to parse."""
    print(json.dumps(obj), file=sys.stderr, flush=True)

def patch_tqdm():
    """Monkey-patch tqdm so huggingface_hub download progress goes to stderr as JSON."""
    import tqdm
    import tqdm.auto

    original_init = tqdm.tqdm.__init__
    original_update = tqdm.tqdm.update

    def patched_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if self.total and self.total > 1_000_000:  # only for large downloads (model files)
            emit({"status": "downloading", "progress": 0, "total": self.total})

    def patched_update(self, n=1):
        original_update(self, n)
        if self.total and self.total > 1_000_000:
            pct = round(self.n / self.total * 100)
            emit({"status": "downloading", "progress": pct, "total": self.total})

    tqdm.tqdm.__init__ = patched_init
    tqdm.tqdm.update = patched_update
    tqdm.auto.tqdm = tqdm.tqdm

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small", choices=["tiny", "base", "small", "medium", "large-v3"])
    parser.add_argument("--file", required=True)
    args = parser.parse_args()

    patch_tqdm()

    model_dir = os.environ.get("WHISPER_MODELS_DIR", "/models")

    emit({"status": "loading_model"})

    from faster_whisper import WhisperModel
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
```

Key changes:
- `emit()` helper writes JSON to stderr
- `patch_tqdm()` monkey-patches tqdm before importing faster-whisper so download progress is captured
- Status events: `loading_model` -> `downloading` (with progress %) -> `transcribing` -> stdout result

**Step 2: Verify TypeScript still compiles**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && npx tsc --noEmit`
Expected: Clean compile (Python changes don't affect TS)

**Step 3: Commit**

```bash
git add transcribe.py
git commit -m "feat: add stderr progress reporting to transcribe.py"
```

---

### Task 2: Node SSE Streaming

**Files:**
- Modify: `src/server.ts`

**Context:** Currently the POST handler awaits the full Python result then returns JSON. Change it to set SSE headers and stream events as Python emits stderr lines. The final stdout is sent as a `result` event.

**Step 1: Rewrite the transcribe endpoint to stream SSE**

Replace the full content of `src/server.ts` with:

```typescript
import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

const VALID_MODELS = ["tiny", "base", "small", "medium", "large-v3"];

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const model =
    typeof req.body.model === "string" && VALID_MODELS.includes(req.body.model)
      ? req.body.model
      : "small";

  const tmpPath = req.file.path;

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const scriptPath = path.join(__dirname, "..", "transcribe.py");
  const proc = spawn("python3", [scriptPath, "--model", model, "--file", tmpPath]);

  let stdout = "";

  proc.stdout.on("data", (data) => {
    stdout += data;
  });

  proc.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {
        // Non-JSON stderr (e.g. Python warnings) — ignore
      }
    }
  });

  proc.on("close", (code) => {
    fs.unlink(tmpPath, () => {});

    if (code !== 0) {
      res.write(`data: ${JSON.stringify({ status: "error", error: "Transcription failed" })}\n\n`);
    } else {
      try {
        const result = JSON.parse(stdout);
        res.write(`data: ${JSON.stringify({ status: "result", ...result })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ status: "error", error: "Failed to parse output" })}\n\n`);
      }
    }
    res.end();
  });

  proc.on("error", (err) => {
    fs.unlink(tmpPath, () => {});
    res.write(`data: ${JSON.stringify({ status: "error", error: err.message })}\n\n`);
    res.end();
  });

  // Clean up if client disconnects
  req.on("close", () => {
    proc.kill();
    fs.unlink(tmpPath, () => {});
  });
});

app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
});
```

Key changes:
- Response is now `text/event-stream` instead of `application/json`
- Stderr lines parsed as JSON and forwarded as SSE `data:` events
- Final result sent as `{status: "result", text, segments, ...}`
- Client disconnect kills the Python process and cleans up

**Step 2: Verify TypeScript compiles**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && npx tsc --noEmit`
Expected: Clean compile

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: stream transcription progress via SSE"
```

---

### Task 3: Frontend — Recording Visualizer + Timer

**Files:**
- Modify: `src/public/index.html`

**Context:** The single HTML file has all CSS and JS inline. Add a canvas-based audio visualizer and timer that appear during recording, replacing the drop zone content.

**Step 1: Add CSS for the recording visualizer and timer**

After the existing `.error` CSS block (line ~67), add:

```css
.recording-viz {
  display: none; flex-direction: column; align-items: center; gap: 0.75rem;
  padding: 1.5rem; border: 2px solid #d32f2f; border-radius: 8px;
  background: rgba(211,47,47,0.05); margin-bottom: 1rem;
}
.recording-viz.visible { display: flex; }
.recording-viz canvas { width: 100%; height: 60px; border-radius: 4px; }
.recording-timer { font-size: 1.5rem; font-weight: 600; color: #d32f2f; font-variant-numeric: tabular-nums; }

.progress-bar-container {
  width: 100%; background: #252525; border-radius: 4px; height: 6px;
  margin-top: 0.5rem; overflow: hidden; display: none;
}
.progress-bar-container.visible { display: block; }
.progress-bar {
  height: 100%; background: #5b8def; border-radius: 4px;
  transition: width 0.3s ease; width: 0%;
}
```

**Step 2: Add recording visualizer HTML**

After the drop-zone div and before the spinner div, add:

```html
<div class="recording-viz" id="recordingViz">
  <canvas id="vizCanvas"></canvas>
  <div class="recording-timer" id="recordingTimer">00:00</div>
</div>
```

**Step 3: Add progress bar HTML**

After the status div, add:

```html
<div class="progress-bar-container" id="progressContainer">
  <div class="progress-bar" id="progressBar"></div>
</div>
```

**Step 4: Update the recording JS to include visualizer and timer**

Replace the entire recording section (the `recordBtn.addEventListener` block) with:

```javascript
let audioContext = null;
let analyser = null;
let animFrameId = null;
let timerInterval = null;
let recordStartTime = null;

const recordingViz = $("recordingViz");
const vizCanvas = $("vizCanvas");
const vizCtx = vizCanvas.getContext("2d");
const recordingTimer = $("recordingTimer");

function startVisualizer(stream) {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 64;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    const w = vizCanvas.width;
    const h = vizCanvas.height;
    vizCtx.clearRect(0, 0, w, h);

    const barCount = 20;
    const gap = 3;
    const barWidth = (w - gap * (barCount - 1)) / barCount;
    const step = Math.floor(bufferLength / barCount);

    for (let i = 0; i < barCount; i++) {
      const val = dataArray[i * step] / 255;
      const barH = Math.max(2, val * h);
      const x = i * (barWidth + gap);
      const y = (h - barH) / 2;

      vizCtx.fillStyle = `rgba(211, 47, 47, ${0.4 + val * 0.6})`;
      vizCtx.beginPath();
      vizCtx.roundRect(x, y, barWidth, barH, 2);
      vizCtx.fill();
    }
  }
  draw();
}

function stopVisualizer() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (audioContext) audioContext.close();
  audioContext = null;
  analyser = null;
  animFrameId = null;
}

function startTimer() {
  recordStartTime = Date.now();
  recordingTimer.textContent = "00:00";
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    recordingTimer.textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

recordBtn.addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopVisualizer();
      stopTimer();
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const file = new File([blob], "recording.webm", { type: "audio/webm" });
      setFile(file);
      recordBtn.classList.remove("recording");
      recordBtn.textContent = "Record";
      dropZone.style.display = "";
      recordingViz.classList.remove("visible");
    };
    mediaRecorder.start();
    recordBtn.classList.add("recording");
    recordBtn.textContent = "Stop";
    dropZone.style.display = "none";
    recordingViz.classList.add("visible");

    // Size canvas to actual pixel dimensions
    vizCanvas.width = vizCanvas.offsetWidth * window.devicePixelRatio;
    vizCanvas.height = vizCanvas.offsetHeight * window.devicePixelRatio;
    vizCtx.scale(window.devicePixelRatio, window.devicePixelRatio);

    startVisualizer(stream);
    startTimer();
  } catch (err) {
    showError("Microphone access denied.");
  }
});
```

**Step 5: Verify it loads without syntax errors**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && npx tsc --noEmit` (only checks TS, but confirms no build breakage)
Manual: Open in browser, click Record, confirm visualizer and timer appear.

**Step 6: Commit**

```bash
git add src/public/index.html
git commit -m "feat: add recording visualizer with audio bars and timer"
```

---

### Task 4: Frontend — Streaming Progress + Download Bar

**Files:**
- Modify: `src/public/index.html`

**Context:** Replace the fetch().json() call with a streaming fetch that reads SSE events line by line. Show a progress bar during model download and appropriate status text for each phase.

**Step 1: Replace the transcribe click handler**

Replace the `transcribeBtn.addEventListener("click", ...)` block with:

```javascript
const progressContainer = $("progressContainer");
const progressBar = $("progressBar");

async function doTranscribe(modelOverride) {
  const modelToUse = modelOverride || modelSelect.value;
  if (!currentFile) return;

  transcribeBtn.disabled = true;
  spinner.classList.add("visible");
  status.textContent = "Starting...";
  errorEl.classList.remove("visible");
  resultEl.classList.remove("visible");
  progressContainer.classList.remove("visible");
  progressBar.style.width = "0%";

  const form = new FormData();
  form.append("audio", currentFile);
  form.append("model", modelToUse);

  try {
    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "Transcription failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = JSON.parse(line.slice(6));

        if (payload.status === "loading_model") {
          status.textContent = "Loading model...";
        } else if (payload.status === "downloading") {
          status.textContent = `Downloading model... ${payload.progress}%`;
          progressContainer.classList.add("visible");
          progressBar.style.width = `${payload.progress}%`;
        } else if (payload.status === "transcribing") {
          progressContainer.classList.remove("visible");
          status.textContent = "Transcribing...";
        } else if (payload.status === "result") {
          lastResult = { text: payload.text, segments: payload.segments, language: payload.language, duration: payload.duration, model: modelToUse };
          transcript.textContent = payload.text;
          meta.textContent = `${payload.language} \u2022 ${formatDuration(payload.duration)} \u2022 ${payload.segments.length} segments \u2022 ${modelToUse} model`;
          resultEl.classList.add("visible");
          updateRetranscribeUI(modelToUse);
        } else if (payload.status === "error") {
          throw new Error(payload.error);
        }
      }
    }
  } catch (err) {
    showError(err.message);
  } finally {
    spinner.classList.remove("visible");
    status.textContent = "";
    progressContainer.classList.remove("visible");
    transcribeBtn.disabled = false;
  }
}

let lastResult = null;

transcribeBtn.addEventListener("click", () => doTranscribe());
```

Note: `lastResult` tracks the last transcription for re-transcribe and share. `doTranscribe` accepts an optional model override for re-transcribe.

**Step 2: Commit**

```bash
git add src/public/index.html
git commit -m "feat: stream transcription progress with download percentage"
```

---

### Task 5: Frontend — Re-transcribe with Model Badge

**Files:**
- Modify: `src/public/index.html`

**Context:** After transcription, show which model was used and let the user re-transcribe with a different model without re-uploading.

**Step 1: Add re-transcribe HTML to the result area**

Inside the `.result` div, after the `.transcript` div, add:

```html
<div class="retranscribe" id="retranscribe" style="display:none; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid #333;">
  <span style="font-size: 0.85rem; color: #888;">Re-transcribe with:</span>
  <select id="retranscribeModel" style="margin-left: 0.5rem;"></select>
  <button id="retranscribeBtn" class="btn-primary" style="margin-left: 0.5rem; padding: 0.3rem 0.75rem; font-size: 0.85rem;">Re-transcribe</button>
</div>
```

**Step 2: Add JS for re-transcribe**

```javascript
const retranscribeEl = $("retranscribe");
const retranscribeModel = $("retranscribeModel");
const retranscribeBtn = $("retranscribeBtn");

function updateRetranscribeUI(usedModel) {
  retranscribeModel.innerHTML = "";
  const models = ["tiny", "base", "small", "medium", "large-v3"];
  for (const m of models) {
    if (m === usedModel) continue;
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    retranscribeModel.appendChild(opt);
  }
  retranscribeEl.style.display = "flex";
  retranscribeEl.style.alignItems = "center";
}

retranscribeBtn.addEventListener("click", () => {
  doTranscribe(retranscribeModel.value);
});
```

**Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat: add re-transcribe with different model selection"
```

---

### Task 6: Frontend — Share Button

**Files:**
- Modify: `src/public/index.html`

**Context:** Add a Share button that uses `navigator.share()` for OS-level sharing. Falls back to copy. Hidden when API unavailable.

**Step 1: Add Share button HTML**

In the `.result-header` div, after the Copy button, add:

```html
<button class="copy-btn" id="shareBtn" style="display:none; margin-left: 0.5rem;">Share</button>
```

**Step 2: Add Share button JS**

```javascript
const shareBtn = $("shareBtn");

if (navigator.share) {
  shareBtn.style.display = "";
}

shareBtn.addEventListener("click", async () => {
  try {
    await navigator.share({ text: transcript.textContent });
  } catch (err) {
    if (err.name !== "AbortError") {
      navigator.clipboard.writeText(transcript.textContent);
      shareBtn.textContent = "Copied!";
      setTimeout(() => { shareBtn.textContent = "Share"; }, 1500);
    }
  }
});
```

Note: `AbortError` means user dismissed the share sheet — don't show fallback in that case.

**Step 3: Commit**

```bash
git add src/public/index.html
git commit -m "feat: add share button with OS-level share sheet"
```

---

### Task 7: Final Verification

**Step 1: TypeScript compile check**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && npx tsc --noEmit`
Expected: Clean compile

**Step 2: Visual review of index.html**

Read through the full `src/public/index.html` to verify all pieces integrate correctly — no duplicate IDs, no missing elements, proper script ordering.

**Step 3: Docker build test (if Docker available)**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && docker compose build`
Expected: Builds successfully

**Step 4: Manual browser test**

Run: `cd /Users/lukevenediger/lukevenediger/whisper-it && docker compose up`
Test:
- Record audio: visualizer bars animate, timer counts up, stops properly
- Upload file: transcribe with default model, see progress streaming
- Result shows model name, transcript text, copy and share buttons work
- Re-transcribe with different model works
- Share button opens OS share sheet (on supported browsers)
