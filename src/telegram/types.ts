import { AttrSegment } from "../lib/attribution";

// --- Telegram Bot API wire subset (only the fields we read) ---

export type TgUser = { id: number; is_bot: boolean; first_name: string; username?: string };
export type TgChat = { id: number; type: "private" | "group" | "supergroup" | "channel" };
export type TgVoice = { file_id: string; duration: number; mime_type?: string; file_size?: number };
export type TgAudio = TgVoice & { file_name?: string; title?: string; performer?: string };
export type TgDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};
export type TgVideoNote = { file_id: string; duration: number; length: number; file_size?: number };
export type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  voice?: TgVoice;
  audio?: TgAudio;
  document?: TgDocument;
  video_note?: TgVideoNote;
  reply_to_message?: { message_id: number };
};
export type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };
export type TgFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
};

export type InlineKeyboardButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };
export type ForceReply = {
  force_reply: true;
  input_field_placeholder?: string;
  selective?: boolean;
};
export type ReplyMarkup = InlineKeyboardMarkup | ForceReply;

export type ApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

// --- Domain types handed to the handler ---

export type AudioKind = "voice" | "audio" | "document" | "video_note";

export type InboundAudio = {
  kind: AudioKind;
  fileId: string;
  mimetype?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
};

export type InboundMessage = {
  chatId: number;
  userId: number;
  messageId: number;
  chatType: TgChat["type"];
  /** Text or caption; "" if none. */
  text: string;
  from: { firstName: string; username?: string };
  audio?: InboundAudio;
  replyToMessageId?: number;
};

export type InboundCallback = {
  id: string;
  chatId: number;
  userId: number;
  /** The bot message the keyboard is attached to. */
  messageId: number;
  data: string;
};

/** Everything needed to retry / re-language / diarize one delivered transcript. */
export type TranscriptState = {
  chatId: number;
  userId: number;
  userMessageId: number;
  audio: InboundAudio;
  /** What the user asked for (may be parakeet-v3 even when a Whisper model ran). */
  requestedModel: string;
  /** Model that actually ran (post-fallback). */
  model: string;
  /** Requested language: "auto" or an ISO code. */
  language: string;
  detectedLanguage: string;
  duration: number;
  text: string;
  segments: AttrSegment[];
  /** OpenRouter model for the Diarize sub-menu. */
  attrModel: string;
  failed?: boolean;
  diarized?: boolean;
};

export type ChatState = {
  lastTranscriptKey?: string;
  pending?: { kind: "names"; transcriptKey: string; promptMessageId: number };
};

export type UserPrefs = { model?: string; language?: string };

export type GlobalDefaults = {
  model: string;
  language: string;
  diarizeEnabled: boolean;
  attrModel: string;
};

export const transcriptKey = (chatId: number, botMessageId: number): string =>
  `${chatId}:${botMessageId}`;
