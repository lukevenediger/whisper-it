import { describe, it, expect } from "vitest";
import crypto from "crypto";
import express from "express";
import request from "supertest";
import { createWebhookRouter } from "../../src/whatsapp/webhook";
import type { InboundMessage } from "../../src/whatsapp/types";

function makeApp(secret?: string) {
  const calls: InboundMessage[] = [];
  const app = express();
  // Stash the raw body so the webhook route can verify the HMAC.
  app.use(
    express.json({
      verify: (req, _res, buf) => ((req as express.Request & { rawBody?: Buffer }).rawBody = buf),
    }),
  );
  app.use(
    "/api/whatsapp",
    createWebhookRouter(
      async (msg) => {
        calls.push(msg);
      },
      { secret },
    ),
  );
  return { app, calls };
}

function sign(secret: string, raw: string): string {
  return crypto.createHmac("sha512", secret).update(raw).digest("hex");
}

const voiceNote = {
  event: "message",
  payload: {
    id: "true_1@c.us_AAA",
    from: "27821234567@c.us",
    fromMe: false,
    hasMedia: true,
    media: { url: "http://waha/x.ogg", mimetype: "audio/ogg" },
  },
};

const tick = () => new Promise((r) => setImmediate(r));

describe("POST /api/whatsapp/webhook", () => {
  it("acks 200 and dispatches a valid message to the handler", async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post("/api/whatsapp/webhook").send(voiceNote);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe("27821234567@c.us");
  });

  it("dedupes repeated deliveries of the same message id", async () => {
    const { app, calls } = makeApp();
    await request(app).post("/api/whatsapp/webhook").send(voiceNote);
    await request(app).post("/api/whatsapp/webhook").send(voiceNote);
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("acks but does not dispatch non-message events", async () => {
    const { app, calls } = makeApp();
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .send({ event: "session.status", payload: {} });
    expect(res.status).toBe(200);
    await tick();
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/whatsapp/webhook (HMAC enforced)", () => {
  const SECRET = "shared-hmac-secret";

  it("accepts a request with a valid X-Webhook-Hmac signature", async () => {
    const { app, calls } = makeApp(SECRET);
    const raw = JSON.stringify(voiceNote);
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .set("X-Webhook-Hmac", sign(SECRET, raw))
      .send(raw);
    expect(res.status).toBe(200);
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("rejects (401) a request with a wrong signature and never dispatches", async () => {
    const { app, calls } = makeApp(SECRET);
    const raw = JSON.stringify(voiceNote);
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .set("X-Webhook-Hmac", "deadbeef")
      .send(raw);
    expect(res.status).toBe(401);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("rejects (401) a request with no signature when a secret is configured", async () => {
    const { app, calls } = makeApp(SECRET);
    const res = await request(app).post("/api/whatsapp/webhook").send(voiceNote);
    expect(res.status).toBe(401);
    await tick();
    expect(calls).toHaveLength(0);
  });
});
