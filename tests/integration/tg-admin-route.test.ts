import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { createAdminRouter } from "../../src/telegram/admin";
import { TelegramWhitelistStore } from "../../src/telegram/whitelist-store";
import { PrefsStore } from "../../src/telegram/prefs-store";
import { SenderStatsStore } from "../../src/lib/sender-stats-store";
import { ATTR_MODEL_OPTIONS } from "../../src/lib/attribution";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-admin-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function build() {
  const whitelist = new TelegramWhitelistStore(dir);
  const prefs = new PrefsStore(dir);
  const senderStats = new SenderStatsStore(dir, { filename: "telegram-stats.json" });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/telegram",
    createAdminRouter({
      whitelist,
      prefs,
      senderStats,
      status: () => ({
        bot: { id: 1, is_bot: true, first_name: "Whisper", username: "whisper_it_bot" },
        polling: { running: true, offset: 5, lastPollAt: 1, lastError: null, consecutiveErrors: 0 },
        queue: { running: false, pending: 0 },
      }),
    }),
  );
  return { app, whitelist, prefs, senderStats };
}

describe("telegram admin router", () => {
  it("GET /status reports bot, polling and queue", async () => {
    const { app } = build();
    const res = await request(app).get("/api/telegram/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      bot: { username: "whisper_it_bot" },
      polling: { running: true },
      queue: { pending: 0 },
    });
  });

  it("whitelist GET/PUT round-trips and drops junk", async () => {
    const { app } = build();
    let res = await request(app).get("/api/telegram/whitelist");
    expect(res.body).toEqual({ ids: [] });
    res = await request(app)
      .put("/api/telegram/whitelist")
      .send({ ids: ["42", 7, "x", -1] });
    expect(res.body).toEqual({ ids: [42, 7] });
    res = await request(app).put("/api/telegram/whitelist").send({ nope: true });
    expect(res.body).toEqual({ ids: [] });
  });

  it("settings GET/PUT validate and persist", async () => {
    const { app } = build();
    let res = await request(app).get("/api/telegram/settings");
    expect(res.body).toMatchObject({ model: "small", language: "auto", diarizeEnabled: true });
    res = await request(app).put("/api/telegram/settings").send({
      model: "bogus",
      language: "de",
      diarizeEnabled: false,
      attrModel: ATTR_MODEL_OPTIONS[1],
    });
    expect(res.body).toMatchObject({
      model: "small",
      language: "de",
      diarizeEnabled: false,
      attrModel: ATTR_MODEL_OPTIONS[1],
    });
  });

  it("users GET lists overrides and DELETE clears one", async () => {
    const { app, prefs } = build();
    prefs.setUser(9, { model: "tiny" });
    let res = await request(app).get("/api/telegram/users");
    expect(res.body).toEqual({ users: { "9": { model: "tiny" } } });
    res = await request(app).delete("/api/telegram/users/9");
    expect(res.status).toBe(200);
    expect(prefs.getUser(9)).toEqual({});
    res = await request(app).delete("/api/telegram/users/abc");
    expect(res.status).toBe(400);
  });

  it("GET /stats returns the usage store", async () => {
    const { app, senderStats } = build();
    senderStats.record("9", { ts: Date.now(), durationSec: 3, words: 5 }, "Alice");
    const res = await request(app).get("/api/telegram/stats");
    expect(res.body.total).toBe(1);
    expect(res.body.bySender["9"].displayName).toBe("Alice");
  });
});
