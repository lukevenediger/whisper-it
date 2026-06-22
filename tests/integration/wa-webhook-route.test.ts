import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createWebhookRouter } from "../../src/whatsapp/webhook";
import type { InboundMessage } from "../../src/whatsapp/types";

function makeApp() {
  const calls: InboundMessage[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/api/whatsapp",
    createWebhookRouter(async (msg) => {
      calls.push(msg);
    }),
  );
  return { app, calls };
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
