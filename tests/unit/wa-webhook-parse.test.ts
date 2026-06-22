import { describe, it, expect } from "vitest";
import { parseWahaEvent } from "../../src/whatsapp/webhook";

const voiceNote = {
  event: "message",
  session: "default",
  payload: {
    id: "true_27821234567@c.us_AAA",
    from: "27821234567@c.us",
    fromMe: false,
    body: "",
    hasMedia: true,
    media: { url: "http://waha/api/files/x.ogg", mimetype: "audio/ogg" },
  },
};

describe("parseWahaEvent", () => {
  it("maps a voice-note message to an InboundMessage", () => {
    const m = parseWahaEvent(voiceNote)!;
    expect(m).toMatchObject({
      chatId: "27821234567@c.us",
      messageId: "true_27821234567@c.us_AAA",
      hasAudio: true,
      mediaUrl: "http://waha/api/files/x.ogg",
      mimetype: "audio/ogg",
    });
  });

  it("ignores non-message events", () => {
    expect(parseWahaEvent({ event: "session.status", payload: {} })).toBeNull();
  });

  it("ignores our own outbound messages", () => {
    expect(
      parseWahaEvent({ ...voiceNote, payload: { ...voiceNote.payload, fromMe: true } }),
    ).toBeNull();
  });

  it("treats a text message as non-audio", () => {
    const m = parseWahaEvent({
      event: "message",
      payload: { id: "x", from: "1@c.us", fromMe: false, body: "diarize", hasMedia: false },
    })!;
    expect(m.hasAudio).toBe(false);
    expect(m.body).toBe("diarize");
  });

  it("does not mark non-audio media (e.g. images) as audio", () => {
    const m = parseWahaEvent({
      event: "message",
      payload: {
        id: "x",
        from: "1@c.us",
        fromMe: false,
        hasMedia: true,
        media: { url: "http://waha/img.jpg", mimetype: "image/jpeg" },
      },
    })!;
    expect(m.hasAudio).toBe(false);
  });
});
