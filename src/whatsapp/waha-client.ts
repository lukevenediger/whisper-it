import fs from "fs";
import os from "os";
import path from "path";

/** The subset of WAHA the message handler depends on (so it can be faked in tests). */
export interface WahaApi {
  sendText(chatId: string, text: string, replyTo?: string): Promise<void>;
  sendSeen(chatId: string): Promise<void>;
  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  /** Download media to a temp file; returns its path. Caller deletes it. */
  downloadMedia(url: string, mimetype?: string): Promise<string>;
}

const DOWNLOAD_DIR = path.join(os.tmpdir(), "whisper-wa-media");

function extForMime(mimetype?: string, url?: string): string {
  if (url) {
    const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i);
    if (m) return m[1].toLowerCase();
  }
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
  };
  return map[(mimetype || "").split(";")[0].trim()] || "ogg";
}

/**
 * Thin WAHA (WhatsApp HTTP API) client. The only module that knows the WAHA
 * wire format. Server-side only — the API key never leaves the backend.
 */
export class WAHAClient implements WahaApi {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private session = "default",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "X-Api-Key": this.apiKey, ...extra };
  }

  private async post(endpoint: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  }

  async sendText(chatId: string, text: string, replyTo?: string): Promise<void> {
    const body: Record<string, unknown> = { session: this.session, chatId, text };
    if (replyTo) body.reply_to = replyTo;
    await this.post("/api/sendText", body);
  }

  async sendSeen(chatId: string): Promise<void> {
    await this.post("/api/sendSeen", { session: this.session, chatId });
  }

  async startTyping(chatId: string): Promise<void> {
    await this.post("/api/startTyping", { session: this.session, chatId });
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.post("/api/stopTyping", { session: this.session, chatId });
  }

  async downloadMedia(url: string, mimetype?: string): Promise<string> {
    // SSRF / credential-leak guard: the media URL comes from the webhook payload,
    // which is attacker-influenced until webhook signature verification lands
    // (phase 2). Trust only the path — force the request onto the configured WAHA
    // origin so the X-Api-Key is never sent anywhere but WAHA. Also fixes WAHA
    // emitting localhost-based file URLs that don't resolve from this container.
    const parsed = new URL(url); // throws on a malformed URL → caller surfaces it
    const target = `${this.baseUrl}${parsed.pathname}${parsed.search}`;
    const res = await fetch(target, { headers: this.headers() });
    if (!res.ok) throw new Error(`media download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const file = path.join(
      DOWNLOAD_DIR,
      `${Date.now()}-${Math.round(performance.now())}.${extForMime(mimetype, url)}`,
    );
    fs.writeFileSync(file, buf);
    return file;
  }

  // --- Admin / session lifecycle (used by the proxy endpoints) ---

  /** Current session info incl. `status` (STARTING|SCAN_QR_CODE|WORKING|FAILED). */
  async getSessionStatus(): Promise<{ status: string; [k: string]: unknown }> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${this.session}`, {
      headers: this.headers(),
    });
    if (!res.ok) return { status: res.status === 404 ? "STOPPED" : "FAILED" };
    return (await res.json()) as { status: string };
  }

  /** QR as base64 JSON ({ mimetype, data }) for the admin page to render. */
  async getQR(): Promise<{ mimetype: string; data: string } | null> {
    const res = await fetch(`${this.baseUrl}/api/${this.session}/auth/qr`, {
      headers: this.headers({ Accept: "application/json" }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { mimetype: string; data: string };
  }

  /** Create (if missing) and start the session. Idempotent / best-effort. */
  async ensureSession(webhookUrl?: string): Promise<void> {
    const config = webhookUrl
      ? { webhooks: [{ url: webhookUrl, events: ["message"] }] }
      : undefined;
    await this.post("/api/sessions", { name: this.session, start: true, config }).catch(() => {});
    await this.post(`/api/sessions/${this.session}/start`, {}).catch(() => {});
  }

  async restart(): Promise<void> {
    await this.post(`/api/sessions/${this.session}/stop`, {}).catch(() => {});
    // ensureSession (create-or-start) so Restart works even if the session was
    // never created or got logged out.
    await this.ensureSession();
  }

  async logout(): Promise<void> {
    await this.post(`/api/sessions/${this.session}/logout`, {}).catch(() => {});
  }
}
