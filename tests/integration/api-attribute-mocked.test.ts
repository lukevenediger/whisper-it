import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import request from "supertest";
import { app } from "../../src/app";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

// Force the server-side handler to think a key is configured
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
beforeAll(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseEvents(text: string): any[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

async function callAttribute(body: any) {
  const res = await request(app).post("/api/attribute").send(body);
  return parseEvents(res.text);
}

const baseSegments = [
  { start: 0, end: 1, text: "hello" },
  { start: 1, end: 2, text: "world" },
];

describe("POST /api/attribute (mocked OpenRouter)", () => {
  it("returns error when no key and no byok", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const events = await callAttribute({ segments: baseSegments });
    expect(events[0]).toMatchObject({ status: "error", error: expect.stringMatching(/key/i) });
    process.env.OPENROUTER_API_KEY = "sk-or-test";
  });

  it("returns error when segments missing", async () => {
    const events = await callAttribute({});
    expect(events[0]).toMatchObject({ status: "error" });
  });

  it("forwards a clean JSON assignment", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ assignments: { "0": "Alice", "1": "Bob" } }),
              },
            },
          ],
        }),
      ),
    );
    const events = await callAttribute({
      segments: baseSegments,
      speakers: [{ name: "Alice" }, { name: "Bob" }],
    });
    const result = events.find((e) => e.status === "result");
    expect(result).toBeDefined();
    expect(result.segments.map((s: any) => s.speaker)).toEqual(["Alice", "Bob"]);
    expect(result.speakers).toEqual(["Alice", "Bob"]);
    expect(result.warning).toBeNull();
  });

  it("handles markdown-fenced JSON", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content:
                  "```json\n" + JSON.stringify({ assignments: { "0": "X", "1": "Y" } }) + "\n```",
              },
            },
          ],
        }),
      ),
    );
    const events = await callAttribute({ segments: baseSegments, speakers: [] });
    const result = events.find((e) => e.status === "result");
    expect(result.segments.map((s: any) => s.speaker)).toEqual(["X", "Y"]);
  });

  it("falls back to SPEAKER_NN on prose output", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [{ message: { content: "Sure! I cannot answer that as a JSON." } }],
        }),
      ),
    );
    const events = await callAttribute({ segments: baseSegments, speakers: [] });
    const result = events.find((e) => e.status === "result");
    expect(result.warning).toMatch(/unparseable/i);
    expect(result.segments.map((s: any) => s.speaker)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
  });

  it("propagates upstream 401", async () => {
    server.use(http.post(OPENROUTER, () => new HttpResponse("Invalid key", { status: 401 })));
    const events = await callAttribute({ segments: baseSegments, speakers: [] });
    const err = events.find((e) => e.status === "error");
    expect(err).toBeDefined();
    expect(err.error).toContain("401");
  });

  it("handles upstream network error", async () => {
    server.use(http.post(OPENROUTER, () => HttpResponse.error()));
    const events = await callAttribute({ segments: baseSegments, speakers: [] });
    const err = events.find((e) => e.status === "error");
    expect(err).toBeDefined();
    expect(err.error).toMatch(/request failed|fetch/i);
  });

  it("uses BYOK over server key when both provided", async () => {
    let seenAuth = "";
    server.use(
      http.post(OPENROUTER, ({ request }) => {
        seenAuth = request.headers.get("authorization") || "";
        return HttpResponse.json({
          choices: [{ message: { content: '{"assignments":{"0":"A","1":"A"}}' } }],
        });
      }),
    );
    await callAttribute({
      segments: baseSegments,
      speakers: [],
      byokKey: "sk-or-byok-secret",
    });
    expect(seenAuth).toContain("sk-or-byok-secret");
    expect(seenAuth).not.toContain("sk-or-test");
  });
});
