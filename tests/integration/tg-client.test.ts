import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  TelegramClient,
  TelegramApiError,
  TelegramFileTooBigError,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
} from "../../src/telegram/telegram-client";

const TOKEN = "123456:SECRET-TOKEN";
const BASE = "http://tg.test";
const api = (method: string) => `${BASE}/bot${TOKEN}/${method}`;
const ok = (result: unknown) => HttpResponse.json({ ok: true, result });
const msg = { message_id: 99, date: 1, chat: { id: 5, type: "private" } };

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () => new TelegramClient(TOKEN, { baseUrl: BASE });

describe("TelegramClient", () => {
  it("sendMessage posts JSON with HTML parse mode, reply and keyboard, and unwraps the result", async () => {
    let body: any = null;
    server.use(
      http.post(api("sendMessage"), async ({ request }) => {
        body = await request.json();
        return ok(msg);
      }),
    );
    const kb = { inline_keyboard: [[{ text: "x", callback_data: "t1:noop" }]] };
    const r = await client().sendMessage({
      chatId: 5,
      text: "<b>hi</b>",
      replyTo: 7,
      replyMarkup: kb,
    });
    expect(r.message_id).toBe(99);
    expect(body).toMatchObject({
      chat_id: 5,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      reply_markup: kb,
    });
  });

  it("sendDocument sends multipart with the file part named by filename", async () => {
    let form: FormData | null = null;
    server.use(
      http.post(api("sendDocument"), async ({ request }) => {
        form = await request.formData();
        return ok(msg);
      }),
    );
    await client().sendDocument({
      chatId: 5,
      file: Buffer.from("%PDF-1.4"),
      filename: "transcript.pdf",
      mimeType: "application/pdf",
      caption: "cap",
      replyMarkup: { inline_keyboard: [] },
    });
    const f = form!.get("document") as File;
    expect(f.name).toBe("transcript.pdf");
    expect(await f.text()).toBe("%PDF-1.4");
    expect(form!.get("chat_id")).toBe("5");
    expect(form!.get("caption")).toBe("cap");
    expect(form!.get("parse_mode")).toBe("HTML");
    expect(JSON.parse(form!.get("reply_markup") as string)).toEqual({ inline_keyboard: [] });
  });

  it("downloadFile calls getFile then fetches the file path and writes a temp file", async () => {
    server.use(
      http.post(api("getFile"), async ({ request }) => {
        const b: any = await request.json();
        expect(b.file_id).toBe("FID");
        return ok({
          file_id: "FID",
          file_unique_id: "u",
          file_size: 5,
          file_path: "voice/file_1.oga",
        });
      }),
      http.get(`${BASE}/file/bot${TOKEN}/voice/file_1.oga`, () => HttpResponse.text("AUDIO")),
    );
    const p = await client().downloadFile("FID", "oga");
    expect(p.endsWith(".oga")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("AUDIO");
    fs.unlinkSync(p);
  });

  it("refuses files over 20 MB before downloading, and maps Telegram's 'file is too big' error", async () => {
    server.use(
      http.post(api("getFile"), async ({ request }) => {
        const b: any = await request.json();
        if (b.file_id === "BIG")
          return ok({
            file_id: "BIG",
            file_unique_id: "u",
            file_size: TELEGRAM_MAX_DOWNLOAD_BYTES + 1,
            file_path: "x",
          });
        return HttpResponse.json(
          { ok: false, error_code: 400, description: "Bad Request: file is too big" },
          { status: 400 },
        );
      }),
    );
    await expect(client().downloadFile("BIG", "mp3")).rejects.toBeInstanceOf(
      TelegramFileTooBigError,
    );
    await expect(client().downloadFile("ERR", "mp3")).rejects.toBeInstanceOf(
      TelegramFileTooBigError,
    );
  });

  it("does not follow a redirect off the API host when downloading", async () => {
    server.use(
      http.post(api("getFile"), () =>
        ok({ file_id: "R", file_unique_id: "u", file_path: "r.ogg" }),
      ),
      http.get(
        `${BASE}/file/bot${TOKEN}/r.ogg`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: "http://evil.example.com/leak" },
          }),
      ),
    );
    await expect(client().downloadFile("R", "ogg")).rejects.toThrow();
  });

  it("retries once after a 429 with retry_after", async () => {
    let calls = 0;
    server.use(
      http.post(api("sendMessage"), () => {
        calls += 1;
        if (calls === 1)
          return HttpResponse.json(
            {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 0 },
            },
            { status: 429 },
          );
        return ok(msg);
      }),
    );
    const r = await client().sendMessage({ chatId: 5, text: "x" });
    expect(r.message_id).toBe(99);
    expect(calls).toBe(2);
  });

  it("surfaces API errors as TelegramApiError without leaking the token", async () => {
    server.use(
      http.post(api("sendMessage"), () =>
        HttpResponse.json(
          { ok: false, error_code: 400, description: "Bad Request: chat not found" },
          { status: 400 },
        ),
      ),
    );
    const err = await client()
      .sendMessage({ chatId: 5, text: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.code).toBe(400);
    expect(err.message).toContain("chat not found");
    expect(err.message).not.toContain("SECRET-TOKEN");
  });

  it("editMessageText swallows 'message is not modified'; answerCallbackQuery and sendChatAction never throw", async () => {
    server.use(
      http.post(api("editMessageText"), () =>
        HttpResponse.json(
          { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
          { status: 400 },
        ),
      ),
      http.post(api("answerCallbackQuery"), () =>
        HttpResponse.json(
          { ok: false, error_code: 400, description: "query is too old" },
          { status: 400 },
        ),
      ),
      http.post(api("sendChatAction"), () => HttpResponse.error()),
    );
    const c = client();
    await expect(
      c.editMessageText({ chatId: 5, messageId: 1, text: "same" }),
    ).resolves.toBeUndefined();
    await expect(c.answerCallbackQuery({ id: "q", text: "hi" })).resolves.toBeUndefined();
    await expect(c.sendChatAction(5, "typing")).resolves.toBeUndefined();
  });

  it("getUpdates passes offset/timeout/allowed_updates and returns the array", async () => {
    let body: any = null;
    server.use(
      http.post(api("getUpdates"), async ({ request }) => {
        body = await request.json();
        return ok([{ update_id: 1 }]);
      }),
    );
    const ups = await client().getUpdates({ offset: 10, timeout: 1, allowed_updates: ["message"] });
    expect(ups).toEqual([{ update_id: 1 }]);
    expect(body).toEqual({ offset: 10, timeout: 1, allowed_updates: ["message"] });
  });
});
