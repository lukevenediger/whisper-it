import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app";

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_DIARIZE = process.env.WHISPER_DIARIZE;

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_DIARIZE === undefined) delete process.env.WHISPER_DIARIZE;
  else process.env.WHISPER_DIARIZE = ORIGINAL_DIARIZE;
});

describe("GET /api/version", () => {
  it("returns the expected shape", async () => {
    const res = await request(app).get("/api/version");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      commit: expect.any(String),
      short: expect.any(String),
      isReal: expect.any(Boolean),
      commitUrl: expect.any(String),
      github: expect.stringContaining("github.com"),
      x: expect.stringContaining("x.com"),
      xHandle: expect.stringMatching(/^@/),
      hasDiarize: expect.any(Boolean),
      hasServerKey: expect.any(Boolean),
    });
  });

  it("hasServerKey flips with OPENROUTER_API_KEY", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    let res = await request(app).get("/api/version");
    expect(res.body.hasServerKey).toBe(true);

    delete process.env.OPENROUTER_API_KEY;
    res = await request(app).get("/api/version");
    expect(res.body.hasServerKey).toBe(false);
  });

  it("hasDiarize flips with WHISPER_DIARIZE", async () => {
    process.env.WHISPER_DIARIZE = "1";
    let res = await request(app).get("/api/version");
    expect(res.body.hasDiarize).toBe(true);

    process.env.WHISPER_DIARIZE = "0";
    res = await request(app).get("/api/version");
    expect(res.body.hasDiarize).toBe(false);
  });
});
