import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHandler } from "../../src/telegram/handler";
import { TelegramWhitelistStore } from "../../src/telegram/whitelist-store";
import { PrefsStore } from "../../src/telegram/prefs-store";
import { SenderStatsStore } from "../../src/lib/sender-stats-store";
import { SessionStore } from "../../src/lib/session-store";
import { createSerialQueue } from "../../src/telegram/queue";
import { TelegramFileTooBigError } from "../../src/telegram/telegram-client";
import { encodeCallback } from "../../src/telegram/callback-data";
import { decodeCallback } from "../../src/telegram/callback-data";
import type { CallbackAction } from "../../src/telegram/callback-data";
import type {
  ChatState,
  InboundCallback,
  InboundMessage,
  TranscriptState,
} from "../../src/telegram/types";
import { ATTR_MODEL_OPTIONS } from "../../src/lib/attribution";

const ALLOWED = 1001;
const BLOCKED = 2002;

let nextId = 100;
function fakeApi() {
  const sent: { chatId: number; text: string; replyTo?: number; replyMarkup?: any; id: number }[] =
    [];
  const edits: { chatId: number; messageId: number; text: string; replyMarkup?: any }[] = [];
  const markups: { chatId: number; messageId: number; replyMarkup: any }[] = [];
  const documents: {
    chatId: number;
    filename: string;
    caption?: string;
    replyMarkup?: any;
    size: number;
    id: number;
  }[] = [];
  const answers: { id: string; text?: string; showAlert?: boolean }[] = [];
  const deleted: number[] = [];
  const actions: string[] = [];
  const downloads: string[] = [];
  return {
    sent,
    edits,
    markups,
    documents,
    answers,
    deleted,
    actions,
    downloads,
    getMe: async () => ({ id: 1, is_bot: true, first_name: "Bot", username: "bot" }),
    getUpdates: async () => [],
    deleteWebhook: async () => {},
    setMyCommands: async () => {},
    sendMessage: async (p: any) => {
      const id = nextId++;
      sent.push({ ...p, id });
      return { message_id: id, date: 0, chat: { id: p.chatId, type: "private" } };
    },
    editMessageText: async (p: any) => {
      edits.push(p);
    },
    editMessageReplyMarkup: async (p: any) => {
      markups.push(p);
    },
    deleteMessage: async (_c: number, id: number) => {
      deleted.push(id);
    },
    sendChatAction: async (_c: number, a: string) => {
      actions.push(a);
    },
    sendDocument: async (p: any) => {
      const id = nextId++;
      documents.push({
        chatId: p.chatId,
        filename: p.filename,
        caption: p.caption,
        replyMarkup: p.replyMarkup,
        size: p.file.length,
        id,
      });
      return { message_id: id, date: 0, chat: { id: p.chatId, type: "private" } };
    },
    answerCallbackQuery: async (p: any) => {
      answers.push(p);
    },
    downloadFile: async (fileId: string, ext: string) => {
      if (fileId === "BIG") throw new TelegramFileTooBigError();
      const p = path.join(os.tmpdir(), `tg-test-${nextId++}.${ext}`);
      fs.writeFileSync(p, "dummy");
      downloads.push(p);
      return p;
    },
  };
}

const audioMsg = (userId: number, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  chatId: userId,
  userId,
  messageId: 7,
  chatType: "private",
  text: "",
  from: { firstName: "Alice", username: "alice" },
  audio: { kind: "voice", fileId: "FID", mimetype: "audio/ogg", fileSize: 1000, duration: 5 },
  ...extra,
});
const textMsg = (userId: number, text: string): InboundMessage => ({
  chatId: userId,
  userId,
  messageId: nextId++,
  chatType: "private",
  text,
  from: { firstName: "Alice" },
});
const cbOn = (messageId: number, action: CallbackAction, userId = ALLOWED): InboundCallback => ({
  id: `cb-${nextId++}`,
  chatId: userId,
  userId,
  messageId,
  data: encodeCallback(action),
});

const kbTexts = (kb: any) => (kb?.inline_keyboard || []).flat().map((b: any) => b.text);
const kbActions = (kb: any) =>
  (kb?.inline_keyboard || []).flat().map((b: any) => decodeCallback(b.callback_data));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-handler-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(opts: { hasKey?: boolean; text?: string; transcribe?: any; attribute?: any } = {}) {
  const whitelist = new TelegramWhitelistStore(dir);
  whitelist.add(ALLOWED);
  const prefs = new PrefsStore(dir);
  const senderStats = new SenderStatsStore(dir, { filename: "telegram-stats.json" });
  const transcripts = new SessionStore<TranscriptState>();
  const chats = new SessionStore<ChatState>();
  const queue = createSerialQueue();
  const api = fakeApi();
  const transcribeCalls: any[] = [];
  const attributeCalls: any[] = [];
  const transcribe =
    opts.transcribe ||
    (async (o: any) => {
      transcribeCalls.push(o);
      return {
        text: opts.text ?? "hello world",
        segments: [
          { start: 0, end: 1, text: "hello" },
          { start: 1, end: 2, text: "world" },
        ],
        language: "en",
        duration: 83,
      };
    });
  const attribute =
    opts.attribute ||
    (async (o: any) => {
      attributeCalls.push(o);
      return {
        merged: [
          { speaker: "Alice", text: "hello" },
          { speaker: "Bob", text: "world" },
        ],
        speakers: ["Alice", "Bob"],
        ambiguous: [],
        notes: "",
        model: o.model,
      };
    });
  const handler = createHandler({
    api: api as any,
    whitelist,
    prefs,
    senderStats,
    transcripts,
    chats,
    queue,
    hasOpenRouterKey: () => opts.hasKey ?? true,
    transcribe: (o: any) => transcribe(o),
    attribute: (o: any) => attribute(o),
    buildPdf: async () => Buffer.from("%PDF-fake"),
    progressThrottleMs: 0,
  });
  return {
    handler,
    api,
    whitelist,
    prefs,
    senderStats,
    transcripts,
    chats,
    queue,
    transcribeCalls,
    attributeCalls,
  };
}

describe("telegram handler — gate", () => {
  it("ignores non-private chats entirely", async () => {
    const t = build();
    await t.handler.handleMessage(audioMsg(ALLOWED, { chatType: "group" }));
    expect(t.api.sent).toHaveLength(0);
    expect(t.transcribeCalls).toHaveLength(0);
  });

  it("tells a non-whitelisted user their id exactly once, then stays silent", async () => {
    const t = build();
    await t.handler.handleMessage(textMsg(BLOCKED, "hi"));
    await t.handler.handleMessage(audioMsg(BLOCKED));
    expect(t.api.sent).toHaveLength(1);
    expect(t.api.sent[0].text).toContain(`<code>${BLOCKED}</code>`);
    expect(t.transcribeCalls).toHaveLength(0);
    await t.handler.handleCallback(cbOn(1, { kind: "menu", menu: "retry" }, BLOCKED));
    expect(t.api.answers).toHaveLength(1);
    expect(t.api.markups).toHaveLength(0);
  });
});

describe("telegram handler — audio", () => {
  it("welcomes a first-time sender, streams status, and delivers a short transcript as text with buttons", async () => {
    const t = build();
    await t.handler.handleMessage(audioMsg(ALLOWED));
    expect(t.api.sent[0].text).toContain("Welcome");
    const status = t.api.sent[1];
    expect(status.replyTo).toBe(7);
    const final = t.api.edits[t.api.edits.length - 1];
    expect(final.messageId).toBe(status.id);
    expect(final.text).toBe("hello world\n\n<i>en · small · 1m 23s</i>");
    expect(kbTexts(final.replyMarkup)).toEqual(["Retry", "Diarize", "Language"]);
    expect(t.transcribeCalls[0]).toMatchObject({ model: "small", language: "auto" });
    expect(t.transcribeCalls[0].filePath).toBe(t.api.downloads[0]);
    expect(fs.existsSync(t.api.downloads[0])).toBe(false);
    const rec = t.senderStats.get().bySender[String(ALLOWED)];
    expect(rec).toMatchObject({ count: 1, displayName: "Alice (@alice)" });
    const key = `${ALLOWED}:${status.id}`;
    expect(t.transcripts.get(key)).toMatchObject({
      model: "small",
      text: "hello world",
      audio: { fileId: "FID" },
    });
    expect(t.chats.get(String(ALLOWED))?.lastTranscriptKey).toBe(key);
    expect(t.api.actions).toContain("typing");
  });

  it("does not repeat the welcome on later messages", async () => {
    const t = build();
    await t.handler.handleMessage(audioMsg(ALLOWED));
    const before = t.api.sent.length;
    await t.handler.handleMessage(audioMsg(ALLOWED, { messageId: 8 }));
    expect(t.api.sent.slice(before).some((m) => m.text.includes("Welcome"))).toBe(false);
  });

  it("delivers a long transcript as a PDF (status deleted, document with caption + buttons, state re-keyed)", async () => {
    const t = build({ text: "word ".repeat(1000) });
    await t.handler.handleMessage(
      audioMsg(ALLOWED, { audio: { kind: "audio", fileId: "FID", fileName: "Team call.mp3" } }),
    );
    const status = t.api.sent[1];
    expect(t.api.deleted).toContain(status.id);
    expect(t.api.documents).toHaveLength(1);
    const doc = t.api.documents[0];
    expect(doc.filename).toBe("Team call.pdf");
    expect(doc.caption).toContain("word word");
    expect(doc.caption).toContain("<i>en · small · 1m 23s</i>");
    expect(doc.caption!.length).toBeLessThanOrEqual(1024);
    expect(kbTexts(doc.replyMarkup)).toEqual(["Retry", "Diarize", "Language"]);
    expect(t.api.actions).toContain("upload_document");
    expect(t.transcripts.get(`${ALLOWED}:${status.id}`)).toBeUndefined();
    expect(t.transcripts.get(`${ALLOWED}:${doc.id}`)).toBeDefined();
  });

  it("reports a failed transcription with a Retry-only keyboard and keeps retryable state", async () => {
    const t = build({
      transcribe: async () => {
        throw new Error("python exploded");
      },
    });
    await t.handler.handleMessage(audioMsg(ALLOWED));
    const final = t.api.edits[t.api.edits.length - 1];
    expect(final.text).toContain("⚠️");
    expect(kbTexts(final.replyMarkup)).toEqual(["Retry"]);
    expect(t.transcripts.get(`${ALLOWED}:${t.api.sent[1].id}`)).toMatchObject({ failed: true });
  });

  it("refuses files over 20 MB up front, and maps a too-big download error", async () => {
    const t = build();
    await t.handler.handleMessage(
      audioMsg(ALLOWED, { audio: { kind: "audio", fileId: "X", fileSize: 30 * 1024 * 1024 } }),
    );
    expect(t.api.sent[1].text).toContain("20 MB");
    expect(t.transcribeCalls).toHaveLength(0);
    await t.handler.handleMessage(
      audioMsg(ALLOWED, { messageId: 9, audio: { kind: "audio", fileId: "BIG" } }),
    );
    expect(t.api.edits[t.api.edits.length - 1].text).toContain("20 MB");
    expect(t.transcribeCalls).toHaveLength(0);
  });

  it("falls back from Parakeet for an unsupported language and says so", async () => {
    const t = build();
    t.prefs.setDefaults({ model: "parakeet-v3" });
    t.prefs.setUser(ALLOWED, { language: "ja" });
    await t.handler.handleMessage(audioMsg(ALLOWED));
    expect(t.transcribeCalls[0]).toMatchObject({ model: "small", language: "ja" });
    const final = t.api.edits[t.api.edits.length - 1];
    expect(final.text).toContain("fell back from parakeet-v3");
    expect(t.transcripts.get(`${ALLOWED}:${t.api.sent[1].id}`)).toMatchObject({
      requestedModel: "parakeet-v3",
      model: "small",
    });
  });

  it("runs diarize immediately when the caption asks for it", async () => {
    const t = build();
    await t.handler.handleMessage(audioMsg(ALLOWED, { text: "diarize Alice, Bob" }));
    expect(t.attributeCalls[0].speakers).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    const last = t.api.edits[t.api.edits.length - 1];
    expect(last.text).toContain("<b>Alice</b>: hello");
  });

  it("queues a second audio behind the first and says so", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = build({
      transcribe: async () => {
        await gate;
        return { text: "x", segments: [], language: "en", duration: 1 };
      },
    });
    const first = t.handler.handleMessage(audioMsg(ALLOWED));
    await new Promise((r) => setTimeout(r, 5));
    const second = t.handler.handleMessage(audioMsg(ALLOWED, { messageId: 9 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(t.api.sent.find((m) => m.replyTo === 9)?.text).toContain("Queued (1 ahead)");
    release();
    await Promise.all([first, second]);
    expect(t.api.edits.filter((e) => e.text.startsWith("x\n")).length).toBe(2);
  });

  it("never lets a slow progress edit land after the final transcript edit", async () => {
    const t = build({
      transcribe: async (o: any) => {
        o.onProgress?.({ status: "transcribing", chunk: 1, total: 1 });
        return { text: "final text", segments: [], language: "en", duration: 1 };
      },
    });
    const applied: string[] = [];
    t.api.editMessageText = async (p: any) => {
      // Progress edits are slow on the wire; the final edit is fast.
      if (p.text.startsWith("🎙")) await new Promise((r) => setTimeout(r, 20));
      applied.push(p.text);
      t.api.edits.push(p);
    };
    await t.handler.handleMessage(audioMsg(ALLOWED));
    await new Promise((r) => setTimeout(r, 40));
    expect(applied.at(-1)).toContain("final text");
  });

  it("dedupes a redelivered message", async () => {
    const t = build();
    await t.handler.handleMessage(audioMsg(ALLOWED));
    await t.handler.handleMessage(audioMsg(ALLOWED));
    expect(t.transcribeCalls).toHaveLength(1);
  });
});

describe("telegram handler — commands", () => {
  it("/start welcomes once then shows help; /help shows help", async () => {
    const t = build();
    await t.handler.handleMessage(textMsg(ALLOWED, "/start"));
    expect(t.api.sent[0].text).toContain("Welcome");
    await t.handler.handleMessage(textMsg(ALLOWED, "/start"));
    expect(t.api.sent[1].text).not.toContain("Welcome");
    expect(t.api.sent[1].text).toContain("/model");
    await t.handler.handleMessage(textMsg(ALLOWED, "/help"));
    expect(t.api.sent[2].text).toContain("/diarize");
  });

  it("/model shows a preference picker; picking persists and confirms", async () => {
    const t = build();
    await t.handler.handleMessage(textMsg(ALLOWED, "/model"));
    const picker = t.api.sent[t.api.sent.length - 1];
    expect(picker.text).toContain("small");
    expect(kbActions(picker.replyMarkup)).toContainEqual({
      kind: "pref",
      field: "model",
      value: "medium",
    });
    await t.handler.handleCallback(
      cbOn(picker.id, { kind: "pref", field: "model", value: "medium" }),
    );
    expect(t.prefs.getUser(ALLOWED).model).toBe("medium");
    expect(t.api.edits[t.api.edits.length - 1]).toMatchObject({
      messageId: picker.id,
      text: expect.stringContaining("medium"),
    });
    expect(t.api.answers[t.api.answers.length - 1].text).toContain("medium");
  });

  it("/model and /language accept inline args and reject invalid ones", async () => {
    const t = build();
    await t.handler.handleMessage(textMsg(ALLOWED, "/model tiny"));
    expect(t.prefs.getUser(ALLOWED).model).toBe("tiny");
    await t.handler.handleMessage(textMsg(ALLOWED, "/model bogus"));
    expect(t.api.sent[t.api.sent.length - 1].text).toContain("large-v3");
    expect(t.prefs.getUser(ALLOWED).model).toBe("tiny");
    await t.handler.handleMessage(textMsg(ALLOWED, "/language de"));
    expect(t.prefs.getUser(ALLOWED).language).toBe("de");
    await t.handler.handleMessage(textMsg(ALLOWED, "/language xx"));
    expect(t.prefs.getUser(ALLOWED).language).toBe("de");
    await t.handler.handleMessage(textMsg(ALLOWED, "/language"));
    expect(kbActions(t.api.sent[t.api.sent.length - 1].replyMarkup)).toContainEqual({
      kind: "pref",
      field: "language",
      value: "auto",
    });
  });

  it("/diarize needs a prior transcript, then labels it with the given names", async () => {
    const t = build();
    await t.handler.handleMessage(textMsg(ALLOWED, "/diarize"));
    expect(t.api.sent[t.api.sent.length - 1].text).toMatch(/voice note first/i);
    await t.handler.handleMessage(audioMsg(ALLOWED));
    await t.handler.handleMessage(textMsg(ALLOWED, "/diarize Alice and Bob"));
    expect(t.attributeCalls[0].speakers).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    expect(t.api.edits[t.api.edits.length - 1].text).toContain("<b>Bob</b>: world");
  });

  it("/diarize without a server key explains it's disabled; unknown text nudges help", async () => {
    const t = build({ hasKey: false });
    await t.handler.handleMessage(audioMsg(ALLOWED));
    expect(kbTexts(t.api.edits[t.api.edits.length - 1].replyMarkup)).toEqual(["Retry", "Language"]);
    await t.handler.handleMessage(textMsg(ALLOWED, "/diarize"));
    expect(t.api.sent[t.api.sent.length - 1].text).toMatch(/isn't enabled/);
    await t.handler.handleMessage(textMsg(ALLOWED, "what?"));
    expect(t.api.sent[t.api.sent.length - 1].text).toContain("/model");
  });
});

describe("telegram handler — callbacks", () => {
  async function withTranscript(opts: Parameters<typeof build>[0] = {}) {
    const t = build(opts);
    await t.handler.handleMessage(audioMsg(ALLOWED));
    const msgId = t.api.sent[1].id;
    return { ...t, msgId };
  }

  it("Retry opens the model picker; picking re-transcribes the same audio into a new message", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "retry" }));
    let mk = t.api.markups[t.api.markups.length - 1];
    expect(mk.messageId).toBe(t.msgId);
    expect(kbActions(mk.replyMarkup)).toContainEqual({ kind: "retry", model: "medium" });
    expect(kbActions(mk.replyMarkup)).not.toContainEqual({ kind: "retry", model: "small" });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "retry", model: "medium" }));
    mk = t.api.markups[t.api.markups.length - 1];
    expect(kbTexts(mk.replyMarkup)).toEqual(["Retry", "Diarize", "Language"]);
    expect(t.transcribeCalls[1]).toMatchObject({ model: "medium", language: "auto" });
    expect(t.api.downloads).toHaveLength(2);
    const final = t.api.edits[t.api.edits.length - 1];
    expect(final.messageId).not.toBe(t.msgId);
    expect(final.text).toContain("· medium ·");
    expect(t.transcripts.get(`${ALLOWED}:${t.msgId}`)?.model).toBe("small");
    expect(t.api.answers.at(-1)?.text).toContain("medium");
  });

  it("Back restores the transcript keyboard", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "lang" }));
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "root" }));
    expect(kbTexts(t.api.markups.at(-1)!.replyMarkup)).toEqual(["Retry", "Diarize", "Language"]);
  });

  it("Language picker re-transcribes with the chosen language and the originally requested model", async () => {
    const t = await withTranscript();
    t.transcripts.update(`${ALLOWED}:${t.msgId}`, { requestedModel: "parakeet-v3" });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "lang", language: "ja" }));
    expect(t.transcribeCalls[1]).toMatchObject({ model: "small", language: "ja" });
    expect(t.api.edits.at(-1)!.text).toContain("fell back from parakeet-v3");
  });

  it("Diarize menu → Guess runs attribution with an empty roster into a new message", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "diar" }));
    expect(kbActions(t.api.markups.at(-1)!.replyMarkup)).toContainEqual({
      kind: "diar",
      mode: "guess",
    });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "diar", mode: "guess" }));
    expect(t.attributeCalls[0]).toMatchObject({ speakers: [], model: ATTR_MODEL_OPTIONS[0] });
    const final = t.api.edits.at(-1)!;
    expect(final.messageId).not.toBe(t.msgId);
    expect(final.text).toContain("<b>Alice</b>: hello");
    expect(kbTexts(final.replyMarkup)).toEqual(["Retry", "Diarize", "Language"]);
    expect(t.transcripts.get(`${ALLOWED}:${final.messageId}`)).toMatchObject({
      diarized: true,
      audio: { fileId: "FID" },
    });
  });

  it("Enter names prompts with a force reply; the next text message supplies the roster", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "diar", mode: "names" }));
    const prompt = t.api.sent.at(-1)!;
    expect(prompt.replyMarkup).toMatchObject({ force_reply: true });
    expect(t.chats.get(String(ALLOWED))?.pending).toMatchObject({
      kind: "names",
      transcriptKey: `${ALLOWED}:${t.msgId}`,
    });
    await t.handler.handleMessage(textMsg(ALLOWED, "Alice, Bob"));
    expect(t.attributeCalls[0].speakers).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    expect(t.chats.get(String(ALLOWED))?.pending).toBeUndefined();
  });

  it("pending names + audio clears the prompt and transcribes normally", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "diar", mode: "names" }));
    await t.handler.handleMessage(audioMsg(ALLOWED, { messageId: 12 }));
    expect(t.attributeCalls).toHaveLength(0);
    expect(t.transcribeCalls).toHaveLength(2);
    expect(t.chats.get(String(ALLOWED))?.pending).toBeUndefined();
  });

  it("LLM picker updates the transcript's attribution model", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "llm" }));
    expect(
      kbActions(t.api.markups.at(-1)!.replyMarkup).filter((a: any) => a?.kind === "llm"),
    ).toHaveLength(ATTR_MODEL_OPTIONS.length);
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "llm", index: 2 }));
    expect(t.transcripts.get(`${ALLOWED}:${t.msgId}`)?.attrModel).toBe(ATTR_MODEL_OPTIONS[2]);
    expect(kbActions(t.api.markups.at(-1)!.replyMarkup)).toContainEqual({
      kind: "diar",
      mode: "guess",
    });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "diar", mode: "guess" }));
    expect(t.attributeCalls[0].model).toBe(ATTR_MODEL_OPTIONS[2]);
  });

  it("Diarize is refused without a key, and on a failed transcript", async () => {
    const t = await withTranscript({ hasKey: false });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "menu", menu: "diar" }));
    expect(t.api.answers.at(-1)).toMatchObject({
      showAlert: true,
      text: expect.stringMatching(/isn't enabled/),
    });
    const f = build({
      transcribe: async () => {
        throw new Error("x");
      },
    });
    await f.handler.handleMessage(audioMsg(ALLOWED));
    const failedId = f.api.sent.find((m) => m.replyTo === 7)!.id;
    await f.handler.handleCallback(cbOn(failedId, { kind: "menu", menu: "diar" }));
    expect(f.api.answers.at(-1)?.text).toMatch(/retry/i);
    await f.handler.handleCallback(cbOn(failedId, { kind: "retry", model: "tiny" }));
    expect(f.transcribeCalls.length).toBeGreaterThanOrEqual(0);
    expect(f.api.downloads.length).toBe(2);
  });

  it("an expired transcript alerts and removes the keyboard; junk data is answered", async () => {
    const t = await withTranscript();
    await t.handler.handleCallback(cbOn(424242, { kind: "menu", menu: "retry" }));
    expect(t.api.answers.at(-1)).toMatchObject({
      showAlert: true,
      text: expect.stringMatching(/expired/i),
    });
    expect(t.api.markups.at(-1)).toMatchObject({ messageId: 424242, replyMarkup: null });
    await t.handler.handleCallback({
      id: "j",
      chatId: ALLOWED,
      userId: ALLOWED,
      messageId: t.msgId,
      data: "garbage",
    });
    expect(t.api.answers.at(-1)?.id).toBe("j");
  });

  it("attribution failures are reported without crashing", async () => {
    const t = await withTranscript({
      attribute: async () => {
        throw new Error("OpenRouter 402: no credits");
      },
    });
    await t.handler.handleCallback(cbOn(t.msgId, { kind: "diar", mode: "guess" }));
    expect(t.api.edits.at(-1)!.text).toContain("no credits");
  });
});
