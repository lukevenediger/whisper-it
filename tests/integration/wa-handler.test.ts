import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHandler } from "../../src/whatsapp/handler";
import { WhitelistStore } from "../../src/whatsapp/whitelist-store";
import { SettingsStore } from "../../src/whatsapp/settings-store";
import { SenderStatsStore } from "../../src/whatsapp/sender-stats-store";
import { SessionStore } from "../../src/whatsapp/session-state";
import type { InboundMessage } from "../../src/whatsapp/types";

const ALLOWED = "27821234567@c.us";
const BLOCKED = "27999999999@c.us";

function audioMsg(chatId: string, body = ""): InboundMessage {
  return {
    chatId,
    messageId: "msg-1",
    body,
    hasAudio: true,
    mediaUrl: "http://waha/api/files/x.ogg",
    mimetype: "audio/ogg",
  };
}
function textMsg(chatId: string, body: string): InboundMessage {
  return { chatId, messageId: "msg-2", body, hasAudio: false };
}

function makeFakeWaha() {
  const sent: { chatId: string; text: string; replyTo?: string }[] = [];
  const seen: string[] = [];
  return {
    sent,
    seen,
    sendText: async (chatId: string, text: string, replyTo?: string) => {
      sent.push({ chatId, text, replyTo });
    },
    sendSeen: async (chatId: string) => {
      seen.push(chatId);
    },
    startTyping: async () => {},
    stopTyping: async () => {},
    downloadMedia: async () => {
      const p = path.join(os.tmpdir(), `wa-test-${sent.length}-${seen.length}.ogg`);
      fs.writeFileSync(p, "dummy");
      return p;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-handler-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(opts: { hasKey?: boolean } = {}) {
  const whitelist = new WhitelistStore(dir);
  whitelist.add(ALLOWED);
  const settings = new SettingsStore(dir);
  const senderStats = new SenderStatsStore(dir);
  const sessions = new SessionStore();
  const waha = makeFakeWaha();
  const transcribe = async () => ({
    text: "hello world",
    segments: [
      { start: 0, end: 1, text: "hello" },
      { start: 1, end: 2, text: "world" },
    ],
    language: "en",
    duration: 2,
  });
  const attribute = async () => ({
    merged: [
      { start: 0, end: 1, text: "hello", speaker: "Speaker 1" },
      { start: 1, end: 2, text: "world", speaker: "Speaker 2" },
    ],
    speakers: ["Speaker 1", "Speaker 2"],
    ambiguous: [],
    notes: "",
    model: "test-model",
  });
  const handle = createHandler({
    waha,
    whitelist,
    settings,
    senderStats,
    sessions,
    hasOpenRouterKey: () => opts.hasKey ?? true,
    transcribe,
    attribute,
  });
  return { handle, waha, senderStats, sessions };
}

describe("WhatsApp handler", () => {
  it("silently ignores non-whitelisted senders", async () => {
    const { handle, waha } = build();
    await handle(audioMsg(BLOCKED));
    expect(waha.sent).toHaveLength(0);
  });

  it("greets a first-time sender, transcribes the audio, and replies (quoting)", async () => {
    const { handle, waha, senderStats, sessions } = build();
    await handle(audioMsg(ALLOWED));
    // welcome + transcript reply
    expect(waha.sent.length).toBeGreaterThanOrEqual(2);
    expect(waha.sent[0].text.toLowerCase()).toContain("welcome");
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text).toContain("hello world");
    expect(reply.replyTo).toBe("msg-1");
    expect(waha.seen).toContain(ALLOWED);
    expect(senderStats.get().total).toBe(1);
    expect(sessions.get(ALLOWED)?.segments).toHaveLength(2);
  });

  it("offers the diarize hint when attribution is available", async () => {
    const { handle, waha } = build({ hasKey: true });
    senderGreeted(waha); // not needed; second message path below
    await handle(audioMsg(ALLOWED));
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text.toLowerCase()).toContain("diarize");
  });

  it("runs the interactive diarize flow on a follow-up reply", async () => {
    const { handle, waha } = build();
    await handle(audioMsg(ALLOWED)); // populates session
    const before = waha.sent.length;
    await handle(textMsg(ALLOWED, "diarize"));
    const reply = waha.sent[waha.sent.length - 1];
    expect(waha.sent.length).toBeGreaterThan(before);
    expect(reply.text).toContain("Speaker 1");
    expect(reply.text).toContain("Speaker 2");
  });

  it("diarizes immediately when the caption contains the keyword", async () => {
    const { handle, waha } = build();
    await handle(audioMsg(ALLOWED, "diarize Alice, Bob"));
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text).toContain("Speaker 1"); // attribute stub output
  });

  it("tells the user to send audio first when diarize has no transcript", async () => {
    const { handle, waha, senderStats } = build();
    senderStats.markGreeted(ALLOWED); // skip welcome
    await handle(textMsg(ALLOWED, "diarize"));
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text.toLowerCase()).toContain("voice note");
  });

  it("responds to 'help' with usage text", async () => {
    const { handle, waha, senderStats } = build();
    senderStats.markGreeted(ALLOWED);
    await handle(textMsg(ALLOWED, "help"));
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text.toLowerCase()).toContain("voice note");
  });

  it("hides the diarize hint when no OpenRouter key is configured", async () => {
    const { handle, waha } = build({ hasKey: false });
    await handle(audioMsg(ALLOWED));
    const reply = waha.sent[waha.sent.length - 1];
    expect(reply.text.toLowerCase()).not.toContain("reply *diarize*");
  });
});

// no-op helper kept for readability of the hint test
function senderGreeted(_waha: unknown) {}
