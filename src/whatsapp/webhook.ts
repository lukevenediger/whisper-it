import express, { Router } from "express";
import crypto from "crypto";
import { InboundMessage } from "./types";

/**
 * HMAC-SHA512 of the raw body, hex-encoded — matches WAHA's X-Webhook-Hmac
 * (set when WHATSAPP_HOOK_HMAC_KEY is configured on the WAHA side).
 */
export function computeWebhookHmac(secret: string, raw: Buffer | string): string {
  return crypto.createHmac("sha512", secret).update(raw).digest("hex");
}

/** Constant-time verification of WAHA's X-Webhook-Hmac header against the raw body. */
export function verifyWebhookHmac(
  secret: string,
  rawBody: Buffer | undefined,
  headerSig: string | undefined,
): boolean {
  if (!rawBody || !headerSig) return false;
  const expected = computeWebhookHmac(secret, rawBody);
  const a = Buffer.from(headerSig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Translate a raw WAHA webhook body into our InboundMessage, or null if it's
 * not an actionable inbound message (wrong event, our own message, etc.).
 * Pure — unit-testable.
 */
export function parseWahaEvent(body: any): InboundMessage | null {
  if (!body || body.event !== "message") return null;
  const p = body.payload;
  if (!p || p.fromMe) return null;
  const from = typeof p.from === "string" ? p.from : "";
  if (!from) return null;

  const media = (p.media && typeof p.media === "object" ? p.media : {}) as {
    url?: string;
    mimetype?: string;
  };
  const mimetype = typeof media.mimetype === "string" ? media.mimetype : undefined;
  const mediaUrl = typeof media.url === "string" ? media.url : undefined;
  const hasAudio = !!p.hasMedia && !!mediaUrl && /^audio\//i.test(mimetype || "");

  return {
    chatId: from,
    messageId: typeof p.id === "string" ? p.id : "",
    body: typeof p.body === "string" ? p.body : "",
    hasAudio,
    mediaUrl,
    mimetype,
  };
}

export type WebhookRouterOptions = {
  /**
   * Shared secret for WAHA's X-Webhook-Hmac. When set, every webhook must carry
   * a valid signature or it's rejected with 401 before any processing. When
   * unset, verification is skipped (the feature is opt-in via the secret).
   */
  secret?: string;
};

/**
 * POST /webhook — WAHA's inbound message hook. Verifies the HMAC signature first
 * (when a secret is configured), then acks 200 and processes asynchronously so
 * long transcriptions don't trip WAHA's retry timeout. Recent message ids are
 * deduped to absorb WAHA delivery retries.
 *
 * Relies on a raw-body capture upstream: `express.json({ verify: (req,_res,buf)
 * => { req.rawBody = buf } })`. Without it, signature verification can't run.
 */
export function createWebhookRouter(
  handle: (msg: InboundMessage) => Promise<void>,
  opts: WebhookRouterOptions = {},
): Router {
  const router = express.Router();
  const recent = new Set<string>();
  const secret = (opts.secret || "").trim();

  router.post("/webhook", (req, res) => {
    if (secret) {
      const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
      const sig = req.get("X-Webhook-Hmac");
      if (!verifyWebhookHmac(secret, rawBody, sig)) {
        res.status(401).json({ error: "invalid or missing webhook signature" });
        return;
      }
    }

    res.status(200).json({ ok: true });

    const msg = parseWahaEvent(req.body);
    if (!msg) return;
    if (msg.messageId) {
      if (recent.has(msg.messageId)) return;
      recent.add(msg.messageId);
      if (recent.size > 500) recent.clear();
    }
    handle(msg).catch((err) => console.error("[whatsapp] handler error:", err));
  });

  return router;
}
