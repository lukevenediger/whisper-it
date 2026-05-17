import express from "express";
import multer from "multer";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import archiver from "archiver";
import { StatsStore } from "./stats";
import { countWords } from "./lib/words";
import { sanitizeZipName } from "./lib/sanitize";
import {
  AttrSegment,
  AttrSpeaker,
  ATTR_MAX_SEGMENTS,
  ATTR_DEFAULT_MODEL,
  buildAttributionPrompt,
  applyAssignments,
} from "./lib/attribution";

export const DATA_DIR = process.env.WHISPER_DATA_DIR || path.join(os.tmpdir(), "whisper-it-data");

const UPLOAD_DIR = path.join(os.tmpdir(), "whisper-uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

export function startupSweep() {
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, f));
      } catch {}
    }
  } catch {}
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("whisper-chunks-")) {
        try {
          fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
}

const VALID_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const VALID_LANGUAGES = new Set([
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "uk",
  "tr",
  "sv",
  "da",
  "no",
  "fi",
  "cs",
  "hu",
  "ro",
  "el",
  "bg",
  "ja",
  "ko",
  "zh",
  "ar",
  "he",
  "hi",
  "bn",
  "ur",
  "fa",
  "th",
  "vi",
  "id",
  "ms",
  "ta",
  "te",
  "ml",
  "mr",
  "gu",
  "kn",
  "pa",
  "si",
  "af",
  "sw",
  "am",
  "yo",
  "ig",
  "ha",
  "zu",
  "xh",
  "st",
  "ca",
  "gl",
  "eu",
  "cy",
  "ga",
  "is",
  "sq",
  "sr",
  "hr",
  "sk",
  "sl",
  "et",
  "lv",
  "lt",
  "mk",
  "be",
  "mt",
  "mn",
  "kk",
  "uz",
  "az",
  "hy",
  "ka",
  "ne",
]);

export const stats = new StatsStore(DATA_DIR);

const COMMIT = process.env.WHISPER_COMMIT || "dev";
const IS_REAL_COMMIT = COMMIT !== "dev" && /^[0-9a-f]{7,40}$/i.test(COMMIT);
const COMMIT_SHORT = IS_REAL_COMMIT ? COMMIT.slice(-4) : "dev";
export const GITHUB_URL = "https://github.com/lukevenediger/whisper-it";
const COMMIT_URL = IS_REAL_COMMIT ? `${GITHUB_URL}/commit/${COMMIT}` : GITHUB_URL;
const X_HANDLE = "@jumpdest7d";
const X_URL = "https://x.com/jumpdest7d";

export const app = express();

app.use(express.json({ limit: "20mb" }));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
  }
  next();
});

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

  const rawLang =
    typeof req.body.language === "string" ? req.body.language.toLowerCase().trim() : "";
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
  let currentChild: ChildProcess | null = proc;

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
        console.error("[python stderr]", trimmed);
      }
    }
  });

  proc.on("close", (code, signal) => {
    currentChild = null;
    if (clientAborted) {
      try {
        res.end();
      } catch {}
      cleanup();
      return;
    }
    if (code === 0) {
      let result: any;
      try {
        result = JSON.parse(stdout);
      } catch {
        res.write(
          `data: ${JSON.stringify({ status: "error", error: "Failed to parse transcription output" })}\n\n`,
        );
        res.end();
        cleanup();
        return;
      }

      const finalize = (finalResult: any) => {
        res.write(`data: ${JSON.stringify({ status: "result", ...finalResult })}\n\n`);
        try {
          stats.record({
            ts: Date.now(),
            model,
            language: finalResult.language || "",
            durationSec: finalResult.duration || 0,
            words: countWords(finalResult.text || ""),
            audioBytes,
            fromRecording,
            filename: originalFilename,
          });
        } catch (err) {
          console.error("Stats record failed:", err);
        }
        res.end();
        cleanup();
      };

      finalize(result);
      return;
    } else {
      const tail = stderrRaw
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("{"))
        .slice(-8)
        .join("\n");
      let reason: string;
      if (signal === "SIGKILL" || (code === null && !signal)) {
        reason = `Process killed (likely out of memory — try a smaller model, or increase Docker's memory allocation). Model: ${model}.`;
      } else if (signal) {
        reason = `Process terminated by signal ${signal}.`;
      } else {
        reason = tail.trim() || `exit code ${code}`;
      }
      console.error(
        `[transcribe] failed (exit code=${code} signal=${signal || "none"}):\n${stderrRaw}`,
      );
      res.write(
        `data: ${JSON.stringify({ status: "error", error: `Transcription failed: ${reason}` })}\n\n`,
      );
    }
    res.end();
    cleanup();
  });

  proc.on("error", (err) => {
    console.error("Failed to start transcription process:", err);
    res.write(
      `data: ${JSON.stringify({ status: "error", error: "Failed to start transcription process" })}\n\n`,
    );
    res.end();
    cleanup();
  });

  req.on("close", () => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    clientAborted = true;
    if (currentChild && !currentChild.killed) {
      try {
        currentChild.kill();
      } catch {}
    }
    cleanup();
  });
});

app.get("/api/stats", (_req, res) => {
  res.json(stats.get());
});

app.post("/api/attribute", async (req, res) => {
  const body = req.body as {
    segments?: AttrSegment[];
    speakers?: AttrSpeaker[];
    speakerCount?: number | "auto";
    extraContext?: string;
    model?: string;
    byokKey?: string;
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const fail = (msg: string) => {
    send({ status: "error", error: msg });
    res.end();
  };

  const segments = Array.isArray(body?.segments) ? body.segments : null;
  if (!segments || segments.length === 0) return fail("segments array required");
  if (segments.length > ATTR_MAX_SEGMENTS)
    return fail(`Too many segments (${segments.length}). Max ${ATTR_MAX_SEGMENTS}.`);
  for (const s of segments) {
    if (typeof s.start !== "number" || typeof s.end !== "number" || typeof s.text !== "string") {
      return fail("Each segment needs {start, end, text}");
    }
  }
  const speakers = Array.isArray(body.speakers)
    ? body.speakers
        .filter((s) => s && typeof s.name === "string" && s.name.trim())
        .map((s) => ({
          name: s.name.trim().slice(0, 80),
          description: typeof s.description === "string" ? s.description.trim().slice(0, 400) : "",
        }))
    : [];

  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : ATTR_DEFAULT_MODEL;
  const serverKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const byok = (typeof body.byokKey === "string" ? body.byokKey : "").trim();
  const apiKey = byok || serverKey;
  if (!apiKey)
    return fail(
      "No OpenRouter API key available. Provide one via the form or set OPENROUTER_API_KEY on the server.",
    );

  const speakerCount =
    typeof body.speakerCount === "number" && body.speakerCount > 0
      ? Math.floor(body.speakerCount)
      : "auto";
  const extraContext =
    typeof body.extraContext === "string" ? body.extraContext.slice(0, 4000) : "";

  send({
    status: "attributing",
    model,
    speakerCount,
    rosterSize: speakers.length,
    segmentCount: segments.length,
  });

  const { system, user } = buildAttributionPrompt({
    segments,
    speakers,
    speakerCount,
    extraContext,
  });

  let openrouterRes: Response;
  try {
    openrouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": GITHUB_URL,
        "X-Title": "Whisper It",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });
  } catch (e: any) {
    return fail(`OpenRouter request failed: ${e?.message || String(e)}`);
  }

  if (!openrouterRes.ok) {
    let errBody = "";
    try {
      errBody = (await openrouterRes.text()).slice(0, 400);
    } catch {}
    return fail(`OpenRouter ${openrouterRes.status}: ${errBody || openrouterRes.statusText}`);
  }

  let payload: any;
  try {
    payload = await openrouterRes.json();
  } catch (e: any) {
    return fail(`OpenRouter returned non-JSON: ${e?.message || String(e)}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return fail("OpenRouter response missing message content");
  }

  const {
    merged,
    speakers: resolvedSpeakers,
    ambiguous,
    notes,
    warning,
  } = applyAssignments(segments, content);
  send({
    status: "result",
    segments: merged,
    speakers: resolvedSpeakers,
    ambiguous,
    notes,
    model,
    warning: warning || null,
  });
  res.end();
});

const DEBUG_FIXTURES_ENABLED = process.env.WHISPER_DEBUG_FIXTURES === "1";
const FIXTURES_DIR = process.env.WHISPER_FIXTURES_DIR || "/fixtures";
const FIXTURE_EXT_RE = /\.(mp3|wav|m4a|ogg|oga|flac|aac|webm)$/i;

app.get("/api/version", (_req, res) => {
  res.json({
    commit: COMMIT,
    short: COMMIT_SHORT,
    isReal: IS_REAL_COMMIT,
    commitUrl: COMMIT_URL,
    github: GITHUB_URL,
    x: X_URL,
    xHandle: X_HANDLE,
    hasServerKey: !!(process.env.OPENROUTER_API_KEY || "").trim(),
    hasDebugFixtures: DEBUG_FIXTURES_ENABLED && fs.existsSync(FIXTURES_DIR),
  });
});

app.get("/api/debug/fixtures", (_req, res) => {
  if (!DEBUG_FIXTURES_ENABLED) {
    res.status(404).json({ error: "Debug fixtures disabled. Set WHISPER_DEBUG_FIXTURES=1." });
    return;
  }
  try {
    const names = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => FIXTURE_EXT_RE.test(f))
      .sort();
    const files = names.map((name) => {
      const stat = fs.statSync(path.join(FIXTURES_DIR, name));
      return { name, sizeBytes: stat.size };
    });
    res.json({ dir: FIXTURES_DIR, files });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/debug/fixture-file/:name", (req, res) => {
  if (!DEBUG_FIXTURES_ENABLED) {
    res.status(404).end();
    return;
  }
  const name = req.params.name;
  if (!name || name !== path.basename(name) || name.startsWith(".") || !FIXTURE_EXT_RE.test(name)) {
    res.status(400).json({ error: "invalid fixture name" });
    return;
  }
  const full = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: "fixture not found" });
    return;
  }
  res.sendFile(full);
});

type ZipFile = { name: string; text: string };

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

  const used = new Set<string>();
  for (const f of body.files) {
    if (!f || typeof f.name !== "string" || typeof f.text !== "string") continue;
    const name = sanitizeZipName(f.name);
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

export const COMMIT_INFO = { COMMIT, COMMIT_SHORT };
