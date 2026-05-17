/**
 * Hits a running whisper-it container at LIVE_BASE_URL (default http://localhost:4000).
 * Skipped when the URL is unreachable. CI's e2e job starts the container before running.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";

const BASE_URL = process.env.LIVE_BASE_URL || "http://localhost:4000";
const AUDIO = path.resolve("tests/fixtures/audio/short.wav");

let canRun = false;

beforeAll(async () => {
  try {
    const res = await fetch(BASE_URL + "/api/version", {
      signal: AbortSignal.timeout(2_000),
    });
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

describe("POST /api/transcribe (live whisper-it container)", () => {
  it.runIf(true)(
    "transcribes short.wav with the tiny model",
    async () => {
      if (!canRun) {
        console.warn(`Skipping live transcribe test: ${BASE_URL} not reachable or fixture missing`);
        return;
      }
      const form = new FormData();
      form.append("audio", new Blob([fs.readFileSync(AUDIO)], { type: "audio/wav" }), "short.wav");
      form.append("model", "tiny");
      form.append("language", "en");
      form.append("filename", "short.wav");

      const res = await fetch(BASE_URL + "/api/transcribe", { method: "POST", body: form });
      expect(res.ok).toBe(true);
      const text = await res.text();
      const events = parseEvents(text);
      const result = events.find((e) => e.status === "result");
      expect(
        result,
        `no result event; events: ${JSON.stringify(events.map((e) => e.status))}`,
      ).toBeDefined();
      expect(result.text.toLowerCase()).toMatch(/fox|jump/);
      expect(Array.isArray(result.segments)).toBe(true);
      expect(result.segments.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
