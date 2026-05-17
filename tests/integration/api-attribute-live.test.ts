/**
 * Live OpenRouter call. Requires OPENROUTER_API_KEY in the environment.
 * Uses a cheap model and a small payload to keep cost negligible.
 * Skipped when the key is absent so this file is safe on PRs without secrets.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app";

const HAS_KEY = !!(process.env.OPENROUTER_API_KEY || "").trim();
const describeOrSkip = HAS_KEY ? describe : describe.skip;

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
beforeAll(() => {
  // app.ts reads OPENROUTER_API_KEY at request time, not import time — leave as-is
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
});

function parseEvents(text: string): any[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

describeOrSkip("POST /api/attribute (live OpenRouter)", () => {
  it("labels segments with provided speaker names", async () => {
    const res = await request(app)
      .post("/api/attribute")
      .send({
        model: "deepseek/deepseek-v4-flash",
        segments: [
          { start: 0, end: 2, text: "Hi everyone, my name is Alice and I run product marketing." },
          { start: 2, end: 4, text: "Hi Alice, nice to meet you. I'm Bob, engineering lead." },
          { start: 4, end: 6, text: "So Bob, what brings you to product reviews?" },
          { start: 6, end: 8, text: "Mostly the cross-team alignment, Alice." },
        ],
        speakers: [
          { name: "Alice", description: "product marketing manager" },
          { name: "Bob", description: "engineering lead" },
        ],
      });

    expect(res.status).toBe(200);
    const events = parseEvents(res.text);
    const result = events.find((e) => e.status === "result");
    expect(result, `no result event; events: ${JSON.stringify(events)}`).toBeDefined();
    const named = result.segments.filter((s: any) => s.speaker !== "SPEAKER_??").length;
    expect(named).toBeGreaterThanOrEqual(3);
    const lower = (result.speakers as string[]).map((s) => s.toLowerCase());
    expect(lower.some((s) => s.includes("alice") || s.includes("bob"))).toBe(true);
    expect(Array.isArray(result.ambiguous)).toBe(true);
    expect(typeof result.notes).toBe("string");
  }, 60_000);
});
