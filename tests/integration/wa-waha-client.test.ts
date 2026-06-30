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

  it("does not follow a redirect off the WAHA host (no key leak via 30x)", async () => {
    // If the download followed the redirect, it would hit evil.example.com with
    // X-Api-Key attached; onUnhandledRequest:"error" would fail the test. With
    // redirect:"manual" the 302 surfaces as a non-ok response and we reject.
    server.use(
      http.get(
        "http://waha.test/api/files/r.ogg",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://evil.example.com/leak" },
          }),
      ),
    );
    const c = new WAHAClient("http://waha.test", "secret-key");
    await expect(c.downloadMedia("http://waha.test/api/files/r.ogg")).rejects.toThrow();
  });
});
