import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import archiver from "archiver";
import { StatsStore } from "./stats";
import { countWords } from "./lib/words";
import { sanitizeZipName } from "./lib/sanitize";
import { resolveEngine, PARAKEET_MODEL } from "./lib/engine";
import { AttrSegment, AttrSpeaker } from "./lib/attribution";
import { runTranscription, TranscribeError, TranscribeAbortError } from "./lib/transcribe-core";
import { runAttribution, AttributeError } from "./lib/attribute-core";
import { mountWhatsApp, isWhatsAppConfigured } from "./whatsapp";

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

const VALID_MODELS = ["parakeet-v3", "tiny", "base", "small", "medium", "large-v3"];

// Whisper model used when a Parakeet request forces an unsupported language.
const PARAKEET_FALLBACK_MODEL =
  typeof process.env.WHISPER_PARAKEET_FALLBACK_MODEL === "string" &&
  VALID_MODELS.includes(process.env.WHISPER_PARAKEET_FALLBACK_MODEL) &&
  process.env.WHISPER_PARAKEET_FALLBACK_MODEL !== PARAKEET_MODEL
    ? process.env.WHISPER_PARAKEET_FALLBACK_MODEL
    : "small";
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

app.use(
  express.json({
    limit: "20mb",
    // Capture the raw body so the WhatsApp webhook route can verify WAHA's HMAC.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

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

  const requestedModel =
    typeof req.body.model === "string" && VALID_MODELS.includes(req.body.model)
      ? req.body.model
      : "small";

  const rawLang =
    typeof req.body.language === "string" ? req.body.language.toLowerCase().trim() : "";
  const language = rawLang && VALID_LANGUAGES.has(rawLang) ? rawLang : "auto";

  // Route to the right engine. A Parakeet request with a forced, unsupported
  // language transparently downgrades to a Whisper model (surfaced via SSE below).
  const resolution = resolveEngine(requestedModel, language, PARAKEET_FALLBACK_MODEL);
  const model = resolution.model;

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

  if (resolution.fallback) {
    res.write(`data: ${JSON.stringify({ status: "fallback", ...resolution.fallback })}\n\n`);
  }

  let cleaned = false;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      fs.unlink(tmpPath, () => {});
    }
  };

  const ac = new AbortController();
  let clientAborted = false;
  req.on("close", () => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    clientAborted = true;
    ac.abort();
    cleanup();
  });

  runTranscription({
    model,
    filePath: tmpPath,
    language,
    signal: ac.signal,
    onProgress: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
  })
    .then((result) => {
      if (clientAborted) return;
      res.write(`data: ${JSON.stringify({ status: "result", ...result })}\n\n`);
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
      res.end();
      cleanup();
    })
    .catch((err) => {
      if (err instanceof TranscribeAbortError) {
        try {
          res.end();
        } catch {}
        cleanup();
        return;
      }
      let wire = "Transcription failed";
      if (err instanceof TranscribeError) {
        if (err.kind === "parse") wire = "Failed to parse transcription output";
        else if (err.kind === "spawn") wire = "Failed to start transcription process";
        else wire = `Transcription failed: ${err.message}`;
      }
      res.write(`data: ${JSON.stringify({ status: "error", error: wire })}\n\n`);
      res.end();
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
    model?: string;
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });
  const send = (obj: any) => {
    if (!clientGone) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    const result = await runAttribution({
      segments: body?.segments,
      speakers: body?.speakers,
      model: body?.model,
      referer: GITHUB_URL,
      onProgress: (event) => send(event),
    });
    send({
      status: "result",
      segments: result.merged,
      speakers: result.speakers,
      ambiguous: result.ambiguous,
      notes: result.notes,
      model: result.model,
      warning: result.warning || null,
    });
    res.end();
  } catch (err) {
    send({ status: "error", error: err instanceof AttributeError ? err.message : String(err) });
    res.end();
  }
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
    hasWhatsApp: isWhatsAppConfigured(),
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

// WhatsApp transcription (WAHA). No-op unless WAHA_BASE_URL is configured.
mountWhatsApp(app, { dataDir: DATA_DIR, fallbackModel: PARAKEET_FALLBACK_MODEL });

export const COMMIT_INFO = { COMMIT, COMMIT_SHORT };
