import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/lib/session-store";

type State = { segments: { start: number; end: number; text: string }[]; model?: string };
const segments = [{ start: 0, end: 1, text: "hi" }];

describe("SessionStore<T>", () => {
  it("stores and retrieves state by key", () => {
    const s = new SessionStore<State>({ ttlMs: 1000, now: () => 0 });
    s.set("k1", { segments, model: "small" });
    expect(s.get("k1")?.segments).toEqual(segments);
  });

  it("expires entries past the TTL", () => {
    let t = 0;
    const s = new SessionStore<State>({ ttlMs: 1000, now: () => t });
    s.set("k1", { segments });
    t = 1500;
    expect(s.get("k1")).toBeUndefined();
  });

  it("clears an entry", () => {
    const s = new SessionStore<State>({ ttlMs: 1000, now: () => 0 });
    s.set("k1", { segments });
    s.clear("k1");
    expect(s.get("k1")).toBeUndefined();
  });

  it("update() merges a patch into existing state and returns it", () => {
    const s = new SessionStore<State>({ ttlMs: 1000, now: () => 0 });
    s.set("k1", { segments, model: "small" });
    expect(s.update("k1", { model: "medium" })).toEqual({ segments, model: "medium" });
    expect(s.get("k1")?.model).toBe("medium");
  });

  it("update() on a missing key returns undefined and stores nothing", () => {
    const s = new SessionStore<State>({ ttlMs: 1000, now: () => 0 });
    expect(s.update("nope", { model: "medium" })).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    let t = 0;
    const s = new SessionStore<State>({ ttlMs: 10_000, now: () => t, maxEntries: 2 });
    s.set("a", { segments });
    t = 1;
    s.set("b", { segments });
    t = 2;
    s.set("c", { segments });
    expect(s.size()).toBe(2);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeDefined();
    expect(s.get("c")).toBeDefined();
  });
});
