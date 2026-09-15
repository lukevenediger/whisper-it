import { describe, it, expect } from "vitest";
import { createPoller } from "../../src/telegram/poller";
import { TelegramApiError } from "../../src/telegram/telegram-client";
import type { TgUpdate } from "../../src/telegram/types";

type Step = { updates: TgUpdate[] } | { error: unknown } | { hang: true };

function fakeApi(script: Step[]) {
  const calls: { offset?: number; timeout?: number; allowed_updates?: string[] }[] = [];
  let i = 0;
  const api = {
    getUpdates: (
      p: { offset?: number; timeout?: number; allowed_updates?: string[] },
      signal?: AbortSignal,
    ) => {
      calls.push(p);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if ("hang" in step)
        return new Promise<TgUpdate[]>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      if ("error" in step) return Promise.reject(step.error);
      return Promise.resolve(step.updates);
    },
  };
  return { api: api as any, calls };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

describe("poller", () => {
  it("dispatches updates and advances the offset past the last update_id", async () => {
    const { api, calls } = fakeApi([
      { updates: [{ update_id: 10 }, { update_id: 11 }] },
      { hang: true },
    ]);
    const seen: number[] = [];
    const sleeps: number[] = [];
    const p = createPoller({
      api,
      onUpdate: (u) => seen.push(u.update_id),
      timeoutSec: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: quiet,
    });
    p.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([10, 11]);
    expect(calls[0]).toMatchObject({
      offset: undefined,
      timeout: 1,
      allowed_updates: ["message", "callback_query"],
    });
    expect(calls[1].offset).toBe(12);
    expect(p.status()).toMatchObject({ running: true, offset: 12, consecutiveErrors: 0 });
    await p.stop();
    expect(p.status().running).toBe(false);
  });

  it("backs off on errors (5 s on 409 conflict, retry_after on 429, exponential otherwise) and recovers", async () => {
    const { api } = fakeApi([
      { error: new TelegramApiError(409, "Conflict: terminated by other getUpdates request") },
      { error: new TelegramApiError(429, "Too Many Requests", 7) },
      { error: new Error("ECONNRESET") },
      { error: new Error("ECONNRESET") },
      { updates: [{ update_id: 1 }] },
      { hang: true },
    ]);
    const sleeps: number[] = [];
    const seen: number[] = [];
    const p = createPoller({
      api,
      onUpdate: (u) => seen.push(u.update_id),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: quiet,
    });
    p.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(sleeps).toEqual([5000, 7000, 1000, 2000]);
    expect(seen).toEqual([1]);
    expect(p.status().consecutiveErrors).toBe(0);
    expect(p.status().lastError).toBeNull();
    await p.stop();
  });

  it("stop() aborts an in-flight long poll and resolves", async () => {
    const { api, calls } = fakeApi([{ hang: true }]);
    const p = createPoller({ api, onUpdate: () => {}, log: quiet });
    p.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    await p.stop();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    expect(p.status().running).toBe(false);
  });

  it("a throwing onUpdate does not stop the loop", async () => {
    const { api } = fakeApi([{ updates: [{ update_id: 1 }, { update_id: 2 }] }, { hang: true }]);
    const seen: number[] = [];
    const p = createPoller({
      api,
      onUpdate: (u) => {
        seen.push(u.update_id);
        if (u.update_id === 1) throw new Error("boom");
      },
      log: quiet,
    });
    p.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([1, 2]);
    await p.stop();
  });
});
