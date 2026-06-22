import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SenderStatsStore } from "../../src/whatsapp/sender-stats-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-stats-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const TS = new Date("2026-06-22T10:00:00Z").getTime();

describe("SenderStatsStore", () => {
  it("records per-sender and per-day totals keyed by normalized number", () => {
    const store = new SenderStatsStore(dir);
    store.record("27821234567@c.us", { ts: TS, durationSec: 12, words: 30 });
    store.record("27821234567@c.us", { ts: TS, durationSec: 8, words: 10 });
    const s = store.get();
    expect(s.total).toBe(2);
    expect(s.bySender["27821234567"]).toMatchObject({ count: 2, durationSec: 20, words: 40 });
    const day = Object.keys(s.byDay)[0];
    expect(s.byDay[day]).toBe(2);
  });

  it("tracks greeted state per sender (first-message welcome)", () => {
    const store = new SenderStatsStore(dir);
    expect(store.hasGreeted("27821234567@c.us")).toBe(false);
    store.markGreeted("27821234567@c.us");
    expect(store.hasGreeted("27821234567@c.us")).toBe(true);
  });

  it("persists across instances", () => {
    const a = new SenderStatsStore(dir);
    a.record("27821234567@c.us", { ts: TS, durationSec: 5, words: 9 });
    a.markGreeted("27821234567@c.us");
    const b = new SenderStatsStore(dir);
    expect(b.hasGreeted("27821234567@c.us")).toBe(true);
    expect(b.get().total).toBe(1);
  });
});
