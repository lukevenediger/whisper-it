/**
 * Real Parakeet v3 transcription against a running whisper-it container.
 *
 * OPT-IN: gated behind PARAKEET_LIVE=1 because the first run downloads the
 * ~670 MB Parakeet ONNX weights — far too heavy for every PR. Run locally (or
 * nightly) against a warmed container:
 *
 *   make run
 *   PARAKEET_LIVE=1 LIVE_BASE_URL=http://localhost:4000 npm run test:integration
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

const BASE_URL = process.env.LIVE_BASE_URL || "http://localhost:4000";
const ENABLED = !!(process.env.PARAKEET_LIVE || "").trim();
const AUDIO = path.resolve("tests/fixtures/audio/short.wav");

let canRun = false;

beforeAll(async () => {
  if (!ENABLED) return;
  try {
    const res = await fetch(BASE_URL + "/api/version", { signal: AbortSignal.timeout(2_000) });
    canRun = res.ok && fs.existsSync(AUDIO);
  } catch {
    canRun = false;
  }
});

function parseEvents(text: string): any[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

async function transcribe(model: string, language: string) {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(AUDIO)], { type: "audio/wav" }), "short.wav");
  form.append("model", model);
  form.append("language", language);
  form.append("filename", "short.wav");
  const res = await fetch(BASE_URL + "/api/transcribe", { method: "POST", body: form });
  expect(res.ok).toBe(true);
  return parseEvents(await res.text());
}

const describeOrSkip = ENABLED ? describe : describe.skip;

describeOrSkip("POST /api/transcribe (live Parakeet v3)", () => {
  it("transcribes English short.wav with parakeet-v3", async () => {
    if (!canRun) {
      console.warn(`Skipping Parakeet live test: ${BASE_URL} unreachable or fixture missing`);
      return;
    }
    const events = await transcribe("parakeet-v3", "auto");
    const result = events.find((e) => e.status === "result");
    expect(result, `events: ${JSON.stringify(events.map((e) => e.status))}`).toBeDefined();
    expect(result.text.toLowerCase()).toMatch(/fox|jump/);
    expect(Array.isArray(result.segments)).toBe(true);
    expect(result.segments.length).toBeGreaterThan(0);
    // No fallback should occur for auto-detect.
    expect(events.find((e) => e.status === "fallback")).toBeUndefined();
  }, 300_000);

  it("falls back to Whisper when an unsupported language is forced", async () => {
    if (!canRun) return;
    const events = await transcribe("parakeet-v3", "ja");
    const fallback = events.find((e) => e.status === "fallback");
    expect(fallback, `events: ${JSON.stringify(events.map((e) => e.status))}`).toBeDefined();
    expect(fallback.to).toBe("small");
    // Whisper still produces a transcript. We don't assert on the words: forcing
    // an unsupported language (ja) on English audio yields a valid-but-foreign
    // rendering — the point is that the fallback engine ran and returned text.
    const result = events.find((e) => e.status === "result");
    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 300_000);
});
