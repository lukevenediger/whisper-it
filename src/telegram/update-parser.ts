// Pure mapping of raw Telegram updates into the handler's inbound types. No I/O.
import type { InboundAudio, InboundCallback, InboundMessage, TgMessage, TgUpdate } from "./types";

export type ParsedUpdate =
  | { kind: "message"; msg: InboundMessage }
  | { kind: "callback"; cb: InboundCallback }
  | null;

const AUDIO_EXTS = new Set([
  "ogg",
  "oga",
  "opus",
  "mp3",
  "m4a",
  "wav",
  "flac",
  "aac",
  "webm",
  "mp4",
]);
const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "video/mp4": "mp4",
};

function fileExt(name?: string): string {
  const m = (name || "").match(/\.([a-z0-9]{2,4})$/i);
  return m ? m[1].toLowerCase() : "";
}

/** Pick the audio-bearing field of a message, if any. Documents must look like audio. */
export function extractAudio(m: TgMessage): InboundAudio | undefined {
  if (m.voice) {
    const v = m.voice;
    return {
      kind: "voice",
      fileId: v.file_id,
      mimetype: v.mime_type || "audio/ogg",
      fileSize: v.file_size,
      duration: v.duration,
    };
  }
  if (m.audio) {
    const a = m.audio;
    return {
      kind: "audio",
      fileId: a.file_id,
      mimetype: a.mime_type,
      fileName: a.file_name,
      fileSize: a.file_size,
      duration: a.duration,
    };
  }
  if (m.video_note) {
    const v = m.video_note;
    return {
      kind: "video_note",
      fileId: v.file_id,
      mimetype: "video/mp4",
      fileSize: v.file_size,
      duration: v.duration,
    };
  }
  if (m.document) {
    const d = m.document;
    const mime = (d.mime_type || "").toLowerCase();
    const looksAudio = mime.startsWith("audio/") || AUDIO_EXTS.has(fileExt(d.file_name));
    if (!looksAudio) return undefined;
    return {
      kind: "document",
      fileId: d.file_id,
      mimetype: d.mime_type,
      fileName: d.file_name,
      fileSize: d.file_size,
    };
  }
  return undefined;
}

/** Temp-file extension for a download: file name ext → mime map → "ogg". */
export function extForAudio(a: InboundAudio): string {
  const fromName = fileExt(a.fileName);
  if (fromName) return fromName;
  const fromMime = MIME_EXT[(a.mimetype || "").toLowerCase()];
  return fromMime || "ogg";
}

export function parseUpdate(u: TgUpdate): ParsedUpdate {
  if (u.callback_query) {
    const cb = u.callback_query;
    if (!cb.from || !cb.message) return null;
    return {
      kind: "callback",
      cb: {
        id: cb.id,
        chatId: cb.message.chat.id,
        userId: cb.from.id,
        messageId: cb.message.message_id,
        data: typeof cb.data === "string" ? cb.data : "",
      },
    };
  }
  const m = u.message;
  if (!m || !m.from || !m.chat) return null;
  const msg: InboundMessage = {
    chatId: m.chat.id,
    userId: m.from.id,
    messageId: m.message_id,
    chatType: m.chat.type,
    text: typeof m.text === "string" ? m.text : typeof m.caption === "string" ? m.caption : "",
    from: { firstName: m.from.first_name || "", username: m.from.username },
  };
  const audio = extractAudio(m);
  if (audio) msg.audio = audio;
  if (m.reply_to_message) msg.replyToMessageId = m.reply_to_message.message_id;
  return { kind: "message", msg };
}
