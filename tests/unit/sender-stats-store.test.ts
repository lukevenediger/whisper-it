import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SenderStatsStore } from "../../src/lib/sender-stats-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const TS = new Date("2026-09-15T10:00:00Z").getTime();

describe("SenderStatsStore (shared)", () => {
  it("defaults to sender-stats.json with the raw id as key", () => {
    const store = new SenderStatsStore(dir);
    store.record(" some-id ", { ts: TS, durationSec: 12, words: 30 });
    expect(fs.existsSync(path.join(dir, "sender-stats.json"))).toBe(true);
    expect(store.get().bySender["some-id"]).toMatchObject({ count: 1 });
  });

  it("writes to a custom filename and applies a custom key normaliser", () => {
    const store = new SenderStatsStore(dir, {
      filename: "telegram-stats.json",
      normalizeKey: (k) => (/^\d+$/.test(k) ? k : ""),
    });
    store.record("123456", { ts: TS, durationSec: 5, words: 9 });
    store.record("not-a-number", { ts: TS, durationSec: 5, words: 9 });
    expect(fs.existsSync(path.join(dir, "telegram-stats.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "whatsapp-stats.json"))).toBe(false);
    expect(store.get().total).toBe(1);
    expect(Object.keys(store.get().bySender)).toEqual(["123456"]);
  });

  it("stores an optional display name per sender", () => {
    const store = new SenderStatsStore(dir, { filename: "t.json", normalizeKey: (k) => k });
    store.record("42", { ts: TS, durationSec: 1, words: 1 }, "Alice (@alice)");
    expect(store.get().bySender["42"].displayName).toBe("Alice (@alice)");
    store.record("42", { ts: TS, durationSec: 1, words: 1 });
    expect(store.get().bySender["42"].displayName).toBe("Alice (@alice)");
    store.record("42", { ts: TS, durationSec: 1, words: 1 }, "Alice B");
    expect(store.get().bySender["42"].displayName).toBe("Alice B");
  });
});
