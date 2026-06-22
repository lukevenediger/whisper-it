import { describe, it, expect } from "vitest";
import { SessionStore } from "../../src/whatsapp/session-state";

const segments = [{ start: 0, end: 1, text: "hi" }];

describe("SessionStore", () => {
  it("stores and retrieves the last transcript for a sender", () => {
    const s = new SessionStore({ ttlMs: 1000, now: () => 0 });
    s.set("27821234567@c.us", { segments, model: "small" });
    expect(s.get("27821234567@c.us")?.segments).toEqual(segments);
  });

  it("expires entries past the TTL", () => {
    let t = 0;
    const s = new SessionStore({ ttlMs: 1000, now: () => t });
    s.set("a@c.us", { segments });
    t = 1500;
    expect(s.get("a@c.us")).toBeUndefined();
  });

  it("clears an entry", () => {
    const s = new SessionStore({ ttlMs: 1000, now: () => 0 });
    s.set("a@c.us", { segments });
    s.clear("a@c.us");
    expect(s.get("a@c.us")).toBeUndefined();
  });
});
