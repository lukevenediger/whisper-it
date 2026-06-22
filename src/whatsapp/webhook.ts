import express, { Router } from "express";
import { InboundMessage } from "./types";

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

/**
 * POST /webhook — WAHA's inbound message hook. Acks immediately (200) and
 * processes asynchronously so long transcriptions don't trip WAHA's retry
 * timeout. Recent message ids are deduped to absorb WAHA delivery retries.
 */
export function createWebhookRouter(handle: (msg: InboundMessage) => Promise<void>): Router {
  const router = express.Router();
  const recent = new Set<string>();

  router.post("/webhook", (req, res) => {
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
