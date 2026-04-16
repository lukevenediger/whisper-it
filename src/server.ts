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

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const model = typeof req.body.model === "string" && VALID_MODELS.includes(req.body.model)
    ? req.body.model
    : "small";

  const tmpPath = req.file.path;

  try {
    const result = await transcribe(tmpPath, model);
    res.json(result);
  } catch (err: any) {
    console.error("Transcription failed:", err);
    res.status(500).json({ error: err.message || "Transcription failed" });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
});

function transcribe(filePath: string, model: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "..", "transcribe.py");
    const proc = spawn("python3", [scriptPath, "--model", model, "--file", filePath]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
});
