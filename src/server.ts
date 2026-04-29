import express from "express";
import multer from "multer";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import archiver from "archiver";
import { StatsStore } from "./stats";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.WHISPER_DATA_DIR || path.join(os.tmpdir(), "whisper-it-data");

const UPLOAD_DIR = path.join(os.tmpdir(), "whisper-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

function startupSweep() {
  // 1. Remove any stale uploads from prior runs
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch {}
    }
  } catch {}
  // 2. Remove any orphan whisper-chunks-* dirs from killed transcribes
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("whisper-chunks-")) {
        try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}
startupSweep();

const VALID_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
// ISO 639-1 codes supported by Whisper. "auto" means auto-detect.
const VALID_LANGUAGES = new Set([
  "auto",
  "en","es","fr","de","it","pt","nl","pl","ru","uk","tr","sv","da","no","fi","cs","hu","ro","el","bg",
  "ja","ko","zh","ar","he","hi","bn","ur","fa","th","vi","id","ms","ta","te","ml","mr","gu","kn","pa","si",
  "af","sw","am","yo","ig","ha","zu","xh","st",
  "ca","gl","eu","cy","ga","is","sq","sr","hr","sk","sl","et","lv","lt","mk","be","mt","mn","kk","uz","az","hy","ka","ne",
]);

const stats = new StatsStore(DATA_DIR);

const COMMIT = process.env.WHISPER_COMMIT || "dev";
const IS_REAL_COMMIT = COMMIT !== "dev" && /^[0-9a-f]{7,40}$/i.test(COMMIT);
const COMMIT_SHORT = IS_REAL_COMMIT ? COMMIT.slice(-4) : "dev";
const GITHUB_URL = "https://github.com/lukevenediger/whisper-it";
const COMMIT_URL = IS_REAL_COMMIT ? `${GITHUB_URL}/commit/${COMMIT}` : GITHUB_URL;
const X_HANDLE = "@jumpdest7d";
const X_URL = "https://x.com/jumpdest7d";

app.use(express.json({ limit: "20mb" }));

// HTML responses are dynamic-feeling — disable browser caching so commit/version updates show immediately
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

app.post("/api/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided" });
    return;
  }

  const model =
    typeof req.body.model === "string" && VALID_MODELS.includes(req.body.model)
      ? req.body.model
      : "small";

  const rawLang = typeof req.body.language === "string" ? req.body.language.toLowerCase().trim() : "";
  const language = rawLang && VALID_LANGUAGES.has(rawLang) ? rawLang : "auto";

  const fromRecording = req.body.fromRecording === "true" || req.body.fromRecording === true;
  const originalFilename =
    typeof req.body.filename === "string" && req.body.filename
      ? req.body.filename
      : req.file.originalname || "audio";
  const audioBytes = req.file.size || 0;

  const tmpPath = req.file.path;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const scriptPath = path.join(__dirname, "..", "transcribe.py");
  const pyArgs = [scriptPath, "--model", model, "--file", tmpPath];
  if (language && language !== "auto") {
    pyArgs.push("--language", language);
  }
  const proc: ChildProcess = spawn("python3", pyArgs);

  let stdout = "";
  let stderrBuf = "";
  let stderrRaw = "";
  let cleaned = false;
  let clientAborted = false;

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
    const chunk = data.toString();
    stderrRaw += chunk;
    stderrBuf += chunk;
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {
        // Non-JSON stderr (Python warnings, errors, tracebacks) — log for diagnosis
        console.error("[python stderr]", trimmed);
      }
    }
  });

  proc.on("close", (code, signal) => {
    if (clientAborted) {
      try { res.end(); } catch {}
      cleanup();
      return;
    }
    if (code === 0) {
      try {
        const result = JSON.parse(stdout);
        res.write(
          `data: ${JSON.stringify({ status: "result", ...result })}\n\n`
        );
        try {
          stats.record({
            ts: Date.now(),
            model,
            language: result.language || "",
            durationSec: result.duration || 0,
            words: countWords(result.text || ""),
            audioBytes,
            fromRecording,
            filename: originalFilename,
          });
        } catch (err) {
          console.error("Stats record failed:", err);
        }
      } catch {
        res.write(
          `data: ${JSON.stringify({ status: "error", error: "Failed to parse transcription output" })}\n\n`
        );
      }
    } else {
      const tail = stderrRaw.split("\n").filter(l => l.trim() && !l.trim().startsWith("{")).slice(-8).join("\n");
      let reason: string;
      if (signal === "SIGKILL" || (code === null && !signal)) {
        reason = `Process killed (likely out of memory — try a smaller model, or increase Docker's memory allocation). Model: ${model}.`;
      } else if (signal) {
        reason = `Process terminated by signal ${signal}.`;
      } else {
        reason = tail.trim() || `exit code ${code}`;
      }
      console.error(`[transcribe] failed (exit code=${code} signal=${signal || "none"}):\n${stderrRaw}`);
      res.write(
        `data: ${JSON.stringify({ status: "error", error: `Transcription failed: ${reason}` })}\n\n`
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

  req.on("close", () => {
    // If response already finished, this is a normal post-stream close — ignore
    if (res.writableEnded) {
      cleanup();
      return;
    }
    if (!proc.killed) {
      clientAborted = true;
      proc.kill();
    }
    cleanup();
  });
});

app.get("/api/stats", (_req, res) => {
  res.json(stats.get());
});

app.get("/api/version", (_req, res) => {
  res.json({
    commit: COMMIT,
    short: COMMIT_SHORT,
    isReal: IS_REAL_COMMIT,
    commitUrl: COMMIT_URL,
    github: GITHUB_URL,
    x: X_URL,
    xHandle: X_HANDLE,
  });
});

type ZipFile = { name: string; text: string };

function sanitizeZipName(name: string): string {
  // Strip path separators, control chars, leading dots; cap length
  const base = String(name).replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/]+/g, "_").replace(/^\.+/, "");
  const trimmed = base.trim() || "transcript.txt";
  return trimmed.slice(0, 200);
}

app.post("/api/zip", (req, res) => {
  const body = req.body as { files?: ZipFile[]; zipName?: string };
  if (!body || !Array.isArray(body.files) || body.files.length === 0) {
    res.status(400).json({ error: "files array required" });
    return;
  }

  const zipName = sanitizeZipName(body.zipName || "transcripts.zip");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName.replace(/"/g, "")}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Zip error:", err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);

  // De-dup names within zip
  const used = new Set<string>();
  for (const f of body.files) {
    if (!f || typeof f.name !== "string" || typeof f.text !== "string") continue;
    let name = sanitizeZipName(f.name);
    let candidate = name;
    let n = 1;
    while (used.has(candidate)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    }
    used.add(candidate);
    archive.append(f.text, { name: candidate });
  }

  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Whisper-It running at http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Version: ${COMMIT_SHORT} (${COMMIT})`);
});
