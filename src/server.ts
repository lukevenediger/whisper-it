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

type DiarizeArgs = {
  audioPath: string;
  transcribeResult: any;
  res: any;
  onSuccess: (mergedResult: any) => void;
  onFailure: () => void;
  setCurrentChild: (child: ChildProcess | null) => void;
  isAborted: () => boolean;
};

function runDiarize(args: DiarizeArgs): void {
  const { audioPath, transcribeResult, res, onSuccess, onFailure, setCurrentChild, isAborted } = args;

  res.write(`data: ${JSON.stringify({ status: "diarize_starting" })}\n\n`);

  const scriptPath = path.join(__dirname, "..", "diarize.py");
  const proc: ChildProcess = spawn("python3", [scriptPath, "--file", audioPath]);
  setCurrentChild(proc);

  let stdout = "";
  let stderrBuf = "";
  let stderrRaw = "";

  proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
  proc.stderr!.on("data", (d: Buffer) => {
    const chunk = d.toString();
    stderrRaw += chunk;
    stderrBuf += chunk;
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!isAborted()) res.write(`data: ${JSON.stringify(parsed)}\n\n`);
      } catch {
        console.error("[diarize stderr]", trimmed);
      }
    }
  });

  proc.on("close", (code, signal) => {
    setCurrentChild(null);
    if (isAborted()) return;
    if (code !== 0) {
      console.error(`[diarize] failed (exit=${code} signal=${signal || "none"}):\n${stderrRaw}`);
      onFailure();
      return;
    }
    try {
      const diarResult = JSON.parse(stdout);
      const merged = transcribeResult.segments.map((seg: any, i: number) => {
        const d = diarResult.segments?.[i];
        return d && d.speaker ? { ...seg, speaker: d.speaker } : seg;
      });
      onSuccess({
        ...transcribeResult,
        segments: merged,
        speakers: diarResult.speakers || [],
      });
    } catch (e) {
      console.error("[diarize] parse failed:", e, "stdout:", stdout.slice(0, 500));
      onFailure();
    }
  });

  proc.on("error", (err) => {
    setCurrentChild(null);
    console.error("[diarize] spawn failed:", err);
    if (!isAborted()) onFailure();
  });

  try {
    proc.stdin!.write(JSON.stringify({ segments: transcribeResult.segments }));
    proc.stdin!.end();
  } catch (e) {
    console.error("[diarize] stdin write failed:", e);
    try { proc.kill(); } catch {}
    setCurrentChild(null);
    if (!isAborted()) onFailure();
  }
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

  const diarizeRequested =
    (req.body.diarize === "true" || req.body.diarize === true) &&
    process.env.WHISPER_DIARIZE === "1";

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
        // Non-JSON stderr (Python warnings, errors, tracebacks) — log for diagnosis
        console.error("[python stderr]", trimmed);
      }
    }
  });

  proc.on("close", (code, signal) => {
    currentChild = null;
    if (clientAborted) {
      try { res.end(); } catch {}
      cleanup();
      return;
    }
    if (code === 0) {
      let result: any;
      try {
        result = JSON.parse(stdout);
      } catch {
        res.write(
          `data: ${JSON.stringify({ status: "error", error: "Failed to parse transcription output" })}\n\n`
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

      if (diarizeRequested && Array.isArray(result.segments) && result.segments.length > 0) {
        runDiarize({
          audioPath: tmpPath,
          transcribeResult: result,
          res,
          onSuccess: finalize,
          onFailure: () => finalize(result),
          setCurrentChild: (c) => { currentChild = c; },
          isAborted: () => clientAborted,
        });
        return;
      }
      finalize(result);
      return;
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
    clientAborted = true;
    if (currentChild && !currentChild.killed) {
      try { currentChild.kill(); } catch {}
    }
    cleanup();
  });
});

app.get("/api/stats", (_req, res) => {
  res.json(stats.get());
});

type AttrSegment = { start: number; end: number; text: string };
type AttrSpeaker = { name: string; description?: string };

const ATTR_MAX_SEGMENTS = 600;
const ATTR_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

function buildAttributionPrompt(segments: AttrSegment[], speakers: AttrSpeaker[]): { system: string; user: string } {
  const roster = speakers.length > 0
    ? speakers.map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n")
    : "(none provided — invent stable labels like \"Speaker A\", \"Speaker B\")";

  const seg = segments.map((s, i) => `[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}s: ${s.text}`).join("\n");

  const system = [
    "You assign speakers to transcript segments.",
    "You are given (1) a roster of known speakers with optional context and (2) numbered transcript segments.",
    "For each segment, decide which speaker is talking, using the context provided to map style/topic/role to names.",
    "Return ONLY a JSON object of the form {\"assignments\": {\"0\": \"Name\", \"1\": \"Name\", ...}}.",
    "Keys are segment indices as strings. Values are speaker names from the roster (or your invented labels if no roster).",
    "Do not return any prose, explanation, or markdown — JSON only.",
    "Be consistent: re-use the same name for the same person across segments.",
  ].join(" ");

  const user = `Speaker roster:\n${roster}\n\nSegments:\n${seg}\n\nReturn the JSON object now.`;
  return { system, user };
}

function applyAssignments(segments: AttrSegment[], raw: string): { merged: any[]; speakers: string[]; warning?: string } {
  // Strip markdown fences if model wrapped output
  let json = raw.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Try to extract the first {...} block
    const match = json.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  const assignments = parsed && typeof parsed === "object" ? (parsed.assignments || parsed) : null;
  if (!assignments || typeof assignments !== "object") {
    // Fallback: generic alternating labels
    const merged = segments.map((s, i) => ({ ...s, speaker: `SPEAKER_${String(i % 2).padStart(2, "0")}` }));
    const speakers = Array.from(new Set(merged.map(s => s.speaker)));
    return { merged, speakers, warning: "Model returned unparseable output — using fallback labels." };
  }
  const seen: string[] = [];
  const merged = segments.map((s, i) => {
    const v = assignments[String(i)];
    const speaker = (typeof v === "string" && v.trim()) ? v.trim() : `SPEAKER_??`;
    if (speaker !== "SPEAKER_??" && !seen.includes(speaker)) seen.push(speaker);
    return { ...s, speaker };
  });
  return { merged, speakers: seen };
}

app.post("/api/attribute", async (req, res) => {
  const body = req.body as {
    segments?: AttrSegment[];
    speakers?: AttrSpeaker[];
    model?: string;
    byokKey?: string;
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const fail = (msg: string) => { send({ status: "error", error: msg }); res.end(); };

  const segments = Array.isArray(body?.segments) ? body.segments : null;
  if (!segments || segments.length === 0) return fail("segments array required");
  if (segments.length > ATTR_MAX_SEGMENTS) return fail(`Too many segments (${segments.length}). Max ${ATTR_MAX_SEGMENTS}.`);
  for (const s of segments) {
    if (typeof s.start !== "number" || typeof s.end !== "number" || typeof s.text !== "string") {
      return fail("Each segment needs {start, end, text}");
    }
  }
  const speakers = Array.isArray(body.speakers)
    ? body.speakers.filter(s => s && typeof s.name === "string" && s.name.trim()).map(s => ({
        name: s.name.trim().slice(0, 80),
        description: typeof s.description === "string" ? s.description.trim().slice(0, 400) : "",
      }))
    : [];

  const model = (typeof body.model === "string" && body.model.trim()) ? body.model.trim() : ATTR_DEFAULT_MODEL;
  const serverKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const byok = (typeof body.byokKey === "string" ? body.byokKey : "").trim();
  const apiKey = byok || serverKey;
  if (!apiKey) return fail("No OpenRouter API key available. Provide one via the form or set OPENROUTER_API_KEY on the server.");

  send({ status: "attributing", model, speakerCount: speakers.length, segmentCount: segments.length });

  const { system, user } = buildAttributionPrompt(segments, speakers);

  let openrouterRes: Response;
  try {
    openrouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
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
    try { errBody = (await openrouterRes.text()).slice(0, 400); } catch {}
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

  const { merged, speakers: resolvedSpeakers, warning } = applyAssignments(segments, content);
  send({ status: "result", segments: merged, speakers: resolvedSpeakers, model, warning: warning || null });
  res.end();
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
    hasDiarize: process.env.WHISPER_DIARIZE === "1",
    hasServerKey: !!(process.env.OPENROUTER_API_KEY || "").trim(),
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
