import express from "express";
import multer from "multer";
import { spawn, ChildProcess } from "child_process";
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
  const proc: ChildProcess = spawn("python3", [
    scriptPath,
    "--model",
    model,
    "--file",
    tmpPath,
  ]);

  let stdout = "";
  let stderrBuf = "";
  let cleaned = false;

  function cleanup() {
    if (!cleaned) {
      cleaned = true;
      fs.unlink(tmpPath, () => {});
    }
  }

  proc.stdout!.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  proc.stderr!.on("data", (data: Buffer) => {
    stderrBuf += data.toString();

    // Process complete lines from stderr
    const lines = stderrBuf.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    stderrBuf = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {
        // Non-JSON stderr line (Python warnings etc.) — ignore
      }
    }
  });

  proc.on("close", (code) => {
    if (code === 0) {
      try {
        const result = JSON.parse(stdout);
        res.write(
          `data: ${JSON.stringify({ status: "result", ...result })}\n\n`
        );
      } catch {
        res.write(
          `data: ${JSON.stringify({ status: "error", error: "Failed to parse transcription output" })}\n\n`
        );
      }
    } else {
      res.write(
        `data: ${JSON.stringify({ status: "error", error: "Transcription failed" })}\n\n`
      );
    }
    res.end();
    cleanup();
  });

  proc.on("error", (err) => {
    console.error("Failed to start transcription process:", err);
    res.write(
      `data: ${JSON.stringify({ status: "error", error: "Failed to start transcription process" })}\n\n`
    );
    res.end();
    cleanup();
  });

  // Handle client disconnect
  req.on("close", () => {
    if (!proc.killed) {
      proc.kill();
    }
    cleanup();
  });
});

app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
});
