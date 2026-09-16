// Minimal Telegram Bot API client over global fetch. Only the methods the bot
// needs. The token is part of every URL and must never appear in logs/errors.
import fs from "fs";
import os from "os";
import path from "path";
import type {
  ApiResponse,
  InlineKeyboardMarkup,
  ReplyMarkup,
  TgFile,
  TgMessage,
  TgUpdate,
  TgUser,
} from "./types";

export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram API ${code}: ${description}`);
    this.name = "TelegramApiError";
  }
}

export class TelegramFileTooBigError extends TelegramApiError {
  constructor(readonly bytes?: number) {
    super(400, "file is too big for bot download (20 MB limit)");
    this.name = "TelegramFileTooBigError";
  }
}

export type ChatAction = "typing" | "upload_document";

export interface TelegramApi {
  getMe(): Promise<TgUser>;
  getUpdates(
    p: { offset?: number; timeout?: number; allowed_updates?: string[] },
    signal?: AbortSignal,
  ): Promise<TgUpdate[]>;
  deleteWebhook(): Promise<void>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
  sendMessage(p: {
    chatId: number;
    text: string;
    replyTo?: number;
    replyMarkup?: ReplyMarkup;
  }): Promise<TgMessage>;
  /** Swallows Telegram's "message is not modified" so repeated progress edits are safe. */
  editMessageText(p: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<void>;
  /** `null` removes the keyboard. */
  editMessageReplyMarkup(p: {
    chatId: number;
    messageId: number;
    replyMarkup: InlineKeyboardMarkup | null;
  }): Promise<void>;
  /** Best-effort; never throws. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /** Best-effort; never throws. */
  sendChatAction(chatId: number, action: ChatAction): Promise<void>;
  sendDocument(p: {
    chatId: number;
    file: Buffer;
    filename: string;
    mimeType: string;
    caption?: string;
    replyTo?: number;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<TgMessage>;
  /** Best-effort; never throws (a late answer is harmless). */
  answerCallbackQuery(p: { id: string; text?: string; showAlert?: boolean }): Promise<void>;
  /** getFile + download to a temp file; returns its path. Caller deletes it. */
  downloadFile(fileId: string, ext: string): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TelegramClient implements TelegramApi {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(
    private token: string,
    opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  private async call<T>(
    method: string,
    body?: Record<string, unknown> | FormData,
    signal?: AbortSignal,
    retried = false,
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const init: RequestInit = { method: "POST", signal };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    let parsed: ApiResponse<T> | null = null;
    try {
      parsed = (await res.json()) as ApiResponse<T>;
    } catch {
      parsed = null;
    }
    if (parsed && parsed.ok) return parsed.result;
    const code = parsed && !parsed.ok ? parsed.error_code : res.status;
    const description = parsed && !parsed.ok ? parsed.description : `HTTP ${res.status}`;
    const retryAfter = parsed && !parsed.ok ? parsed.parameters?.retry_after : undefined;
    if (code === 429 && !retried) {
      await sleep(Math.max(0, retryAfter ?? 1) * 1000);
      return this.call<T>(method, body, signal, true);
    }
    throw new TelegramApiError(code, description, retryAfter);
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe");
  }

  getUpdates(
    p: { offset?: number; timeout?: number; allowed_updates?: string[] },
    signal?: AbortSignal,
  ): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", p, signal);
  }

  async deleteWebhook(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  sendMessage(p: {
    chatId: number;
    text: string;
    replyTo?: number;
    replyMarkup?: ReplyMarkup;
  }): Promise<TgMessage> {
    const body: Record<string, unknown> = { chat_id: p.chatId, text: p.text, parse_mode: "HTML" };
    if (p.replyTo)
      body.reply_parameters = { message_id: p.replyTo, allow_sending_without_reply: true };
    if (p.replyMarkup) body.reply_markup = p.replyMarkup;
    return this.call<TgMessage>("sendMessage", body);
  }

  async editMessageText(p: {
    chatId: number;
    messageId: number;
    text: string;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: p.chatId,
      message_id: p.messageId,
      text: p.text,
      parse_mode: "HTML",
    };
    if (p.replyMarkup) body.reply_markup = p.replyMarkup;
    try {
      await this.call("editMessageText", body);
    } catch (err) {
      if (err instanceof TelegramApiError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async editMessageReplyMarkup(p: {
    chatId: number;
    messageId: number;
    replyMarkup: InlineKeyboardMarkup | null;
  }): Promise<void> {
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: p.chatId,
        message_id: p.messageId,
        reply_markup: p.replyMarkup ?? { inline_keyboard: [] },
      });
    } catch (err) {
      if (err instanceof TelegramApiError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      /* best-effort */
    }
  }

  async sendChatAction(chatId: number, action: ChatAction): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      /* best-effort */
    }
  }

  sendDocument(p: {
    chatId: number;
    file: Buffer;
    filename: string;
    mimeType: string;
    caption?: string;
    replyTo?: number;
    replyMarkup?: InlineKeyboardMarkup;
  }): Promise<TgMessage> {
    const form = new FormData();
    form.set("chat_id", String(p.chatId));
    form.set("document", new Blob([p.file], { type: p.mimeType }), p.filename);
    if (p.caption) {
      form.set("caption", p.caption);
      form.set("parse_mode", "HTML");
    }
    if (p.replyTo)
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: p.replyTo, allow_sending_without_reply: true }),
      );
    if (p.replyMarkup) form.set("reply_markup", JSON.stringify(p.replyMarkup));
    return this.call<TgMessage>("sendDocument", form);
  }

  async answerCallbackQuery(p: { id: string; text?: string; showAlert?: boolean }): Promise<void> {
    try {
      const body: Record<string, unknown> = { callback_query_id: p.id };
      if (p.text) body.text = p.text.slice(0, 200);
      if (p.showAlert) body.show_alert = true;
      await this.call("answerCallbackQuery", body);
    } catch {
      /* best-effort */
    }
  }

  async downloadFile(fileId: string, ext: string): Promise<string> {
    let file: TgFile;
    try {
      file = await this.call<TgFile>("getFile", { file_id: fileId });
    } catch (err) {
      if (err instanceof TelegramApiError && /too big/i.test(err.message))
        throw new TelegramFileTooBigError();
      throw err;
    }
    if (typeof file.file_size === "number" && file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES)
      throw new TelegramFileTooBigError(file.file_size);
    if (!file.file_path) throw new TelegramApiError(500, "getFile returned no file_path");

    // Only ever fetch from our own API host; never follow a redirect elsewhere
    // (the URL carries the bot token).
    const url = `${this.baseUrl}/file/bot${this.token}/${file.file_path.replace(/^\/+/, "")}`;
    const res = await this.fetchImpl(url, { redirect: "manual" });
    if (!res.ok) throw new TelegramApiError(res.status, `file download failed (${res.status})`);

    const dir = path.join(os.tmpdir(), "whisper-tg-media");
    fs.mkdirSync(dir, { recursive: true });
    const safeExt = (ext || "ogg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "ogg";
    const dest = path.join(dir, `${Date.now()}-${Math.round(performance.now())}.${safeExt}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return dest;
  }
}
