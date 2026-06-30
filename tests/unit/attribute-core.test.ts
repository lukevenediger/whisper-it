import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { runAttribution, AttributeError } from "../../src/lib/attribute-core";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const segments = [
  { start: 0, end: 1, text: "hi alice" },
  { start: 1, end: 2, text: "hi bob" },
];

describe("runAttribution (attribute-core)", () => {
  it("rejects with AttributeError when no API key is available", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(runAttribution({ segments, apiKey: "" })).rejects.toBeInstanceOf(AttributeError);
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  });

  it("rejects when segments are empty", async () => {
    await expect(runAttribution({ segments: [], apiKey: "sk-or-test" })).rejects.toBeInstanceOf(
      AttributeError,
    );
  });

  it("resolves merged segments + speakers from a non-streaming response", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: { "0": "Speaker 1", "1": "Speaker 2" },
                  ambiguous: [],
                  notes: "ok",
                }),
              },
            },
          ],
        }),
      ),
    );
    const r = await runAttribution({ segments, apiKey: "sk-or-test" });
    expect(r.merged).toHaveLength(2);
    expect(r.merged[0].speaker).toBe("Speaker 1");
    expect(r.speakers).toEqual(["Speaker 1", "Speaker 2"]);
    expect(r.model).toBeTruthy();
  });

  it("emits an attributing progress event with roster + segment counts", async () => {
    server.use(
      http.post(OPENROUTER, () =>
        HttpResponse.json({
          choices: [{ message: { content: '{"assignments":{"0":"A","1":"A"}}' } }],
        }),
      ),
    );
    const events: any[] = [];
    await runAttribution({
      segments,
      speakers: [{ name: "A" }],
      apiKey: "sk-or-test",
      onProgress: (e) => events.push(e),
    });
    const attributing = events.find((e) => e.status === "attributing");
    expect(attributing).toMatchObject({ rosterSize: 1, segmentCount: 2 });
    expect(attributing.model).toBeTruthy();
  });
});
