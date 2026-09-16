import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { mountTelegram, isTelegramConfigured } from "../../src/telegram";

// Nothing may touch the network merely by mounting — polling starts only via
// start(). Any fetch (the Telegram client's only transport) fails the test.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    throw new Error(`unexpected network call: ${typeof input === "string" ? input : input?.url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("mountTelegram", () => {
  it("is a no-op without TELEGRAM_BOT_TOKEN", () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(isTelegramConfigured()).toBe(false);
      expect(
        mountTelegram(express(), { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "tg-")) }),
      ).toBeNull();
    } finally {
      if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });

  it("mounts the admin routes without polling when a token is set", async () => {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    try {
      const app = express();
      app.use(express.json());
      const rt = mountTelegram(app, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "tg-")) });
      expect(rt).not.toBeNull();
      const res = await request(app).get("/api/telegram/status");
      expect(res.status).toBe(200);
      expect(res.body.polling.running).toBe(false);
      expect(res.body.bot).toBeNull();
      await rt!.stop();
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  });
});
