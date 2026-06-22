import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { WAHAClient } from "../../src/whatsapp/waha-client";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("WAHAClient.downloadMedia (SSRF hardening)", () => {
  it("fetches from the configured WAHA host, ignoring the payload URL host", async () => {
    // msw only knows waha.test — if the client fetched the payload host
    // (localhost), onUnhandledRequest:"error" would fail the test.
    server.use(http.get("http://waha.test/api/files/x.ogg", () => HttpResponse.text("AUDIO")));
    const c = new WAHAClient("http://waha.test", "secret-key");
    const file = await c.downloadMedia("http://localhost:3000/api/files/x.ogg", "audio/ogg");
    expect(fs.readFileSync(file, "utf8")).toBe("AUDIO");
    fs.unlinkSync(file);
  });

  it("sends the API key only to the WAHA host", async () => {
    let sawKey: string | null = null;
    server.use(
      http.get("http://waha.test/api/files/y.ogg", ({ request }) => {
        sawKey = request.headers.get("X-Api-Key");
        return HttpResponse.text("A");
      }),
    );
    const c = new WAHAClient("http://waha.test", "secret-key");
    const file = await c.downloadMedia("http://evil.example.com/api/files/y.ogg");
    expect(sawKey).toBe("secret-key");
    fs.unlinkSync(file);
  });

  it("rejects an unparseable media URL", async () => {
    const c = new WAHAClient("http://waha.test", "k");
    await expect(c.downloadMedia("not a url")).rejects.toThrow();
  });
});
