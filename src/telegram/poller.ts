// Long-polling loop over getUpdates. One poller per bot token — Telegram
// answers 409 if two instances poll the same token. Started/stopped by the
// server entrypoint, never at module import (tests import the app).
import type { TelegramApi } from "./telegram-client";
import { TelegramApiError } from "./telegram-client";
import type { TgUpdate } from "./types";

export type PollerOptions = {
  api: Pick<TelegramApi, "getUpdates">;
  onUpdate: (u: TgUpdate) => void;
  /** Long-poll timeout in seconds (Telegram holds the request open this long). */
  timeoutSec?: number;
  allowedUpdates?: string[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: Pick<Console, "log" | "warn" | "error">;
};

export type PollerStatus = {
  running: boolean;
  offset: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
};

export type Poller = { start(): void; stop(): Promise<void>; status(): PollerStatus };

const MAX_BACKOFF_MS = 30_000;
const CONFLICT_BACKOFF_MS = 5_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export function createPoller(o: PollerOptions): Poller {
  const timeoutSec = o.timeoutSec ?? 30;
  const allowedUpdates = o.allowedUpdates ?? ["message", "callback_query"];
  const sleep = o.sleep ?? defaultSleep;
  const log = o.log ?? console;

  let ac: AbortController | null = null;
  let loop: Promise<void> | null = null;
  // Generic (network/5xx) failures back off exponentially; 409/429 use fixed
  // waits and don't feed the exponential counter.
  let genericErrors = 0;
  const status: PollerStatus = {
    running: false,
    offset: null,
    lastPollAt: null,
    lastError: null,
    consecutiveErrors: 0,
  };

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await o.api.getUpdates(
          {
            offset: status.offset ?? undefined,
            timeout: timeoutSec,
            allowed_updates: allowedUpdates,
          },
          signal,
        );
        status.lastPollAt = Date.now();
        status.consecutiveErrors = 0;
        status.lastError = null;
        genericErrors = 0;
        for (const u of updates) {
          status.offset = u.update_id + 1;
          try {
            o.onUpdate(u);
          } catch (err) {
            log.error("[telegram] onUpdate threw:", err);
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        status.consecutiveErrors += 1;
        status.lastError = err instanceof Error ? err.message : String(err);
        let backoff: number;
        if (err instanceof TelegramApiError && err.code === 409) {
          backoff = CONFLICT_BACKOFF_MS;
          log.warn(
            "[telegram] getUpdates conflict (409): another instance is polling this bot token. Retrying in 5s.",
          );
        } else if (err instanceof TelegramApiError && err.code === 429) {
          backoff = Math.max(1, err.retryAfter ?? 1) * 1000;
          log.warn(`[telegram] rate limited; retrying in ${backoff / 1000}s`);
        } else {
          genericErrors += 1;
          backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (genericErrors - 1));
          log.error(
            `[telegram] getUpdates failed (${status.lastError}); retrying in ${backoff / 1000}s`,
          );
        }
        await sleep(backoff, signal);
      }
    }
  }

  return {
    start() {
      if (ac) return;
      ac = new AbortController();
      status.running = true;
      loop = run(ac.signal).finally(() => {
        status.running = false;
      });
    },
    async stop() {
      if (!ac) return;
      ac.abort();
      try {
        await loop;
      } catch {
        /* loop never rejects, but be safe */
      }
      ac = null;
      loop = null;
      status.running = false;
    },
    status: () => ({ ...status }),
  };
}
