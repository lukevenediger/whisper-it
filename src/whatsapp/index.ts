import { Express } from "express";
import { WAHAClient } from "./waha-client";
import { WhitelistStore } from "./whitelist-store";
import { SettingsStore } from "./settings-store";
import { SenderStatsStore } from "./sender-stats-store";
import { SessionStore } from "./session-state";
import { createHandler } from "./handler";
import { createWebhookRouter } from "./webhook";
import { createAdminRouter } from "./admin";

/** WhatsApp is enabled only when a WAHA base URL is configured. */
export function isWhatsAppConfigured(): boolean {
  return !!(process.env.WAHA_BASE_URL || "").trim();
}

export type MountOptions = { dataDir: string; fallbackModel?: string };

/**
 * Wire the WhatsApp feature into the Express app: stores, WAHA client, message
 * handler, and the webhook + admin routers (both under /api/whatsapp). No-op
 * when WAHA isn't configured. Returns whether it mounted.
 */
export function mountWhatsApp(app: Express, opts: MountOptions): boolean {
  if (!isWhatsAppConfigured()) {
    console.log("[whatsapp] disabled (WAHA_BASE_URL not set)");
    return false;
  }

  const baseUrl = (process.env.WAHA_BASE_URL || "").trim();
  const apiKey = (process.env.WAHA_API_KEY || "").trim();
  const session = (process.env.WAHA_SESSION || "default").trim();

  const waha = new WAHAClient(baseUrl, apiKey, session);
  const whitelist = new WhitelistStore(opts.dataDir);
  const settings = new SettingsStore(opts.dataDir);
  const senderStats = new SenderStatsStore(opts.dataDir);
  const sessions = new SessionStore();

  const handle = createHandler({
    waha,
    whitelist,
    settings,
    senderStats,
    sessions,
    hasOpenRouterKey: () => !!(process.env.OPENROUTER_API_KEY || "").trim(),
    fallbackModel: opts.fallbackModel,
  });

  const webhookSecret = (process.env.WHATSAPP_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    console.warn(
      "[whatsapp] WHATSAPP_WEBHOOK_SECRET not set — webhooks are UNAUTHENTICATED. " +
        "Set it (and WAHA's WHATSAPP_HOOK_HMAC_KEY to the same value) to enforce HMAC.",
    );
  }
  app.use("/api/whatsapp", createWebhookRouter(handle, { secret: webhookSecret }));
  app.use("/api/whatsapp", createAdminRouter({ waha, whitelist, settings, senderStats }));

  // Best-effort: make sure the session exists/starts so the QR is available.
  const hookUrl = (process.env.WHATSAPP_HOOK_URL || "").trim() || undefined;
  waha.ensureSession(hookUrl).catch((err) => console.error("[whatsapp] ensureSession:", err));

  console.log(`[whatsapp] enabled (WAHA ${baseUrl}, session "${session}")`);
  return true;
}
