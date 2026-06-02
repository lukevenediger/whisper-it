import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import request from "supertest";
import { app } from "../../src/app";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

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
  it("returns error when server has no key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const events = await callAttribute({ segments: baseSegments });
    expect(events[0]).toMatchObject({ status: "error", error: expect.stringMatching(/key/i) });
    process.env.OPENROUTER_API_KEY = "sk-or-test";
  });

  it("returns error when segments missing", async () => {
    const events = await callAttribute({});
    expect(events[0]).toMatchObject({ status: "error" });
  });

  it("forwards a clean JSON assignment with ambiguous + notes", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: { "0": "Alice", "1": "Bob" },
                  ambiguous: [1],
                  notes: "Bob's line was short.",
                }),
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
    expect(result.ambiguous).toEqual([1]);
    expect(result.notes).toContain("Bob");
    expect(result.warning).toBeNull();
  });

  it("empty roster ⇒ prompt tells model to guess and label Speaker 1/2/...", async () => {
    let seenSystem = "";
    server.use(
      http.post(OPENROUTER, async ({ request }) => {
        const body = (await request.json()) as any;
        seenSystem = body?.messages?.find((m: any) => m.role === "system")?.content || "";
        return HttpResponse.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ assignments: { "0": "Speaker 1", "1": "Speaker 2" } }),
              },
            },
          ],
        });
      }),
    );
    await callAttribute({ segments: baseSegments, speakers: [] });
    expect(seenSystem).toContain("infer how many distinct speakers");
    expect(seenSystem).toContain('"Speaker 1"');
  });

  it("roster provided ⇒ prompt locks to roster names", async () => {
    let seenSystem = "";
    server.use(
      http.post(OPENROUTER, async ({ request }) => {
        const body = (await request.json()) as any;
        seenSystem = body?.messages?.find((m: any) => m.role === "system")?.content || "";
        return HttpResponse.json({
          choices: [
            { message: { content: JSON.stringify({ assignments: { "0": "A", "1": "B" } }) } },
          ],
        });
      }),
    );
    await callAttribute({
      segments: baseSegments,
      speakers: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(seenSystem).toContain("ONLY speaker names from the roster");
  });

  it("attributing event reports rosterSize + segmentCount + model", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [{ message: { content: '{"assignments":{"0":"A","1":"A"}}' } }],
        }),
      ),
    );
    const events = await callAttribute({
      segments: baseSegments,
      speakers: [{ name: "Alice" }, { name: "Bob" }],
      model: "qwen/qwen3.5-flash-02-23",
    });
    const attributing = events.find((e) => e.status === "attributing");
    expect(attributing.rosterSize).toBe(2);
    expect(attributing.segmentCount).toBe(2);
    expect(attributing.model).toBe("qwen/qwen3.5-flash-02-23");
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

  it("falls back to 'Speaker N' labels on prose output + flags all ambiguous", async () => {
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
    expect(result.segments.map((s: any) => s.speaker)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(result.ambiguous).toEqual([0, 1]);
  });

  it("emits progress events while streaming an SSE completion", async () => {
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;
    const sse =
      [
        chunk('{"assignments": {"0": "Alice", '),
        chunk('"1": "Bob"}, '),
        chunk('"ambiguous": [], "notes": "ok"}'),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    server.use(
      http.post(
        OPENROUTER,
        () => new HttpResponse(sse, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
    const events = await callAttribute({
      segments: baseSegments,
      speakers: [{ name: "Alice" }, { name: "Bob" }],
    });
    const progress = events.filter((e) => e.status === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1).total).toBe(2);
    expect(Math.max(...progress.map((p) => p.done))).toBe(2);
    const result = events.find((e) => e.status === "result");
    expect(result.segments.map((s: any) => s.speaker)).toEqual(["Alice", "Bob"]);
    expect(result.warning).toBeNull();
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
});
