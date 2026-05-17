import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StatsStore } from "../../src/stats";
import fs from "fs";
import path from "path";
import os from "os";

let dir: string;
let store: StatsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-stats-test-"));
  store = new StatsStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(over: Partial<Parameters<StatsStore["record"]>[0]> = {}) {
  return {
    ts: Date.now(),
    model: "small",
    language: "en",
    durationSec: 10,
    words: 25,
    audioBytes: 100_000,
    fromRecording: false,
    filename: "audio.wav",
    ...over,
  };
}

describe("StatsStore", () => {
  it("returns zeroed state when no file exists", () => {
    const s = store.get();
    expect(s.total).toBe(0);
    expect(s.totalWords).toBe(0);
    expect(s.totalDurationSec).toBe(0);
    expect(s.byModel).toEqual({});
    expect(s.firstAt).toBeNull();
  });

  it("records one entry and aggregates", () => {
    store.record(rec({ words: 50, durationSec: 20 }));
    const s = store.get();
    expect(s.total).toBe(1);
    expect(s.totalWords).toBe(50);
    expect(s.totalDurationSec).toBe(20);
    expect(s.byModel.small.count).toBe(1);
    expect(s.byModel.small.durationSec).toBe(20);
  });

  it("aggregates by model", () => {
    store.record(rec({ model: "tiny", words: 10 }));
    store.record(rec({ model: "tiny", words: 20 }));
    store.record(rec({ model: "small", words: 5 }));
    const s = store.get();
    expect(s.byModel.tiny.count).toBe(2);
    expect(s.byModel.small.count).toBe(1);
  });

  it("aggregates by language", () => {
    store.record(rec({ language: "en" }));
    store.record(rec({ language: "es" }));
    store.record(rec({ language: "es" }));
    const s = store.get();
    expect(s.byLanguage.es).toBe(2);
    expect(s.byLanguage.en).toBe(1);
  });

  it("does not bump byLanguage for empty language string", () => {
    store.record(rec({ language: "" }));
    expect(store.get().byLanguage).toEqual({});
  });

  it("splits recording vs upload counts", () => {
    store.record(rec({ fromRecording: true }));
    store.record(rec({ fromRecording: false }));
    store.record(rec({ fromRecording: false }));
    const s = store.get();
    expect(s.recordingCount).toBe(1);
    expect(s.uploadCount).toBe(2);
  });

  it("tracks longest event", () => {
    store.record(rec({ durationSec: 5, filename: "short.wav" }));
    store.record(rec({ durationSec: 50, filename: "long.wav" }));
    store.record(rec({ durationSec: 10, filename: "mid.wav" }));
    const s = store.get();
    expect(s.longestDurationSec).toBe(50);
    expect(s.longest?.filename).toBe("long.wav");
  });

  it("persists across new instances", () => {
    store.record(rec({ words: 7 }));
    const fresh = new StatsStore(dir);
    expect(fresh.get().totalWords).toBe(7);
  });

  it("caps recent array at 50", () => {
    for (let i = 0; i < 60; i++) store.record(rec({ ts: Date.now() + i }));
    expect(store.get().recent.length).toBe(50);
  });

  it("handles 25 concurrent writes without losing data", async () => {
    const writes = Array.from({ length: 25 }, (_, i) =>
      Promise.resolve().then(() =>
        store.record(rec({ words: 1, durationSec: 1, ts: Date.now() + i })),
      ),
    );
    await Promise.all(writes);
    const s = store.get();
    expect(s.total).toBe(25);
    expect(s.totalWords).toBe(25);
  });
});
