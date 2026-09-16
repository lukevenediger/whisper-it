import { Express } from "express";
import { SenderStatsStore } from "../lib/sender-stats-store";
import { SessionStore } from "../lib/session-store";
import { TelegramClient } from "./telegram-client";
import { TelegramWhitelistStore } from "./whitelist-store";
import { PrefsStore } from "./prefs-store";
import { createSerialQueue } from "./queue";
import { createHandler } from "./handler";
import { createPoller } from "./poller";
import { createAdminRouter } from "./admin";
import { BOT_COMMANDS } from "./commands";
import type { ChatState, TgUser, TranscriptState } from "./types";

const TRANSCRIPT_TTL_MS = 6 * 60 * 60 * 1000; // retry/diarize window per delivered transcript
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;

/** Telegram is enabled only when a bot token is configured. */
export function isTelegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

export type MountOptions = { dataDir: string; fallbackModel?: string };

export type TelegramRuntime = {
  /** Register commands, drop any webhook, and begin long polling. */
  start(): Promise<void>;
  /** Stop polling and abort in-flight jobs. */
  stop(): Promise<void>;
};

/**
 * Wire the Telegram feature into the Express app: stores, client, handler,
 * poller and the admin router (under /api/telegram). Mounting never touches the
 * network — the server entrypoint calls start() after listen(), so importing
 * the app in tests is side-effect free. Returns null when not configured.
 */
export function mountTelegram(app: Express, opts: MountOptions): TelegramRuntime | null {
  if (!isTelegramConfigured()) {
    console.log("[telegram] disabled (TELEGRAM_BOT_TOKEN not set)");
    return null;
  }
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();

  const api = new TelegramClient(token);
  const whitelist = new TelegramWhitelistStore(opts.dataDir);
  const prefs = new PrefsStore(opts.dataDir);
  const senderStats = new SenderStatsStore(opts.dataDir, {
    filename: "telegram-stats.json",
    normalizeKey: (id) => (/^\d+$/.test(id) ? id : ""),
    label: "Telegram",
  });
  const transcripts = new SessionStore<TranscriptState>({
    ttlMs: TRANSCRIPT_TTL_MS,
    maxEntries: 500,
  });
  const chats = new SessionStore<ChatState>({ ttlMs: CHAT_TTL_MS, maxEntries: 1000 });
  const queue = createSerialQueue();

  const handler = createHandler({
    api,
    whitelist,
    prefs,
    senderStats,
    transcripts,
    chats,
    queue,
    hasOpenRouterKey: () => !!(process.env.OPENROUTER_API_KEY || "").trim(),
    fallbackModel: opts.fallbackModel,
  });

  const poller = createPoller({
    api,
    onUpdate: (u) =>
      void handler.handleUpdate(u).catch((err) => console.error("[telegram] handler error:", err)),
  });

  let bot: TgUser | null = null;
  app.use(
    "/api/telegram",
    createAdminRouter({
      whitelist,
      prefs,
      senderStats,
      status: () => ({
        bot,
        polling: poller.status(),
        queue: { running: queue.running(), pending: queue.pending() },
      }),
    }),
  );

  console.log("[telegram] enabled (long polling; start() pending)");
  return {
    async start() {
      await api
        .deleteWebhook()
        .catch((err) => console.warn("[telegram] deleteWebhook:", err?.message || err));
      await api
        .setMyCommands(BOT_COMMANDS)
        .catch((err) => console.warn("[telegram] setMyCommands:", err?.message || err));
      try {
        bot = await api.getMe();
        console.log(`[telegram] polling as @${bot.username || bot.first_name}`);
      } catch (err: any) {
        console.error("[telegram] getMe failed (bad token?):", err?.message || err);
      }
      poller.start();
    },
    async stop() {
      await poller.stop();
      queue.abortAll();
    },
  };
}
