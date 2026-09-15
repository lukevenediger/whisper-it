import { describe, it, expect } from "vitest";
import { parseUpdate, extractAudio, extForAudio } from "../../src/telegram/update-parser";
import type { TgMessage, TgUpdate } from "../../src/telegram/types";

const from = { id: 42, is_bot: false, first_name: "Alice", username: "alice" };
const chat = { id: 42, type: "private" as const };
const base = (extra: Partial<TgMessage>): TgMessage => ({
  message_id: 7,
  date: 1,
  chat,
  from,
  ...extra,
});

describe("parseUpdate", () => {
  it("maps a voice note into an InboundMessage with audio", () => {
    const u: TgUpdate = {
      update_id: 1,
      message: base({
        voice: { file_id: "F", duration: 5, mime_type: "audio/ogg", file_size: 100 },
      }),
    };
    const r = parseUpdate(u);
    expect(r).toMatchObject({
      kind: "message",
      msg: {
        chatId: 42,
        userId: 42,
        messageId: 7,
        chatType: "private",
        text: "",
        from: { firstName: "Alice", username: "alice" },
        audio: { kind: "voice", fileId: "F", mimetype: "audio/ogg", fileSize: 100, duration: 5 },
      },
    });
  });

  it("uses the caption as text for media messages", () => {
    const u: TgUpdate = {
      update_id: 1,
      message: base({
        caption: "diarize Alice, Bob",
        audio: { file_id: "A", duration: 3, file_name: "x.mp3" },
      }),
    };
    const r = parseUpdate(u);
    expect(r?.kind === "message" && r.msg.text).toBe("diarize Alice, Bob");
    expect(r?.kind === "message" && r.msg.audio?.fileName).toBe("x.mp3");
  });

  it("maps a callback query", () => {
    const u: TgUpdate = {
      update_id: 2,
      callback_query: { id: "cb1", from, message: base({ text: "hi" }), data: "t1:menu:retry" },
    };
    expect(parseUpdate(u)).toEqual({
      kind: "callback",
      cb: { id: "cb1", chatId: 42, userId: 42, messageId: 7, data: "t1:menu:retry" },
    });
  });

  it("returns null for updates with neither message nor callback, or missing from", () => {
    expect(parseUpdate({ update_id: 3 })).toBeNull();
    expect(
      parseUpdate({ update_id: 4, message: { ...base({ text: "x" }), from: undefined } }),
    ).toBeNull();
  });
});

describe("extractAudio", () => {
  it("accepts documents only when they look like audio", () => {
    expect(extractAudio(base({ document: { file_id: "D", mime_type: "audio/mpeg" } }))?.kind).toBe(
      "document",
    );
    expect(extractAudio(base({ document: { file_id: "D", file_name: "note.m4a" } }))?.kind).toBe(
      "document",
    );
    expect(
      extractAudio(
        base({ document: { file_id: "D", mime_type: "application/pdf", file_name: "a.pdf" } }),
      ),
    ).toBeUndefined();
  });

  it("treats video notes as mp4 audio sources", () => {
    const a = extractAudio(base({ video_note: { file_id: "V", duration: 4, length: 240 } }));
    expect(a).toMatchObject({ kind: "video_note", mimetype: "video/mp4" });
  });

  it("returns undefined for plain text", () => {
    expect(extractAudio(base({ text: "hello" }))).toBeUndefined();
  });
});

describe("extForAudio", () => {
  it("prefers the file name extension, then the mime type, then ogg", () => {
    expect(extForAudio({ kind: "document", fileId: "x", fileName: "clip.M4A" })).toBe("m4a");
    expect(extForAudio({ kind: "audio", fileId: "x", mimetype: "audio/mpeg" })).toBe("mp3");
    expect(extForAudio({ kind: "video_note", fileId: "x", mimetype: "video/mp4" })).toBe("mp4");
    expect(extForAudio({ kind: "voice", fileId: "x" })).toBe("ogg");
  });
});
