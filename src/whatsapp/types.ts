import { AttrSegment } from "../lib/attribution";

/** A normalized inbound WhatsApp message handed to the orchestration handler. */
export type InboundMessage = {
  /** Chat JID, e.g. "27821234567@c.us". */
  chatId: string;
  /** Provider message id (used for reply_to quoting). */
  messageId: string;
  /** Text body / caption ("" if none). */
  body: string;
  /** True for voice notes / audio attachments. */
  hasAudio: boolean;
  /** Direct media download URL from WAHA (when hasAudio). */
  mediaUrl?: string;
  /** Media mimetype, e.g. "audio/ogg". */
  mimetype?: string;
};

/** Stored transcript state for the interactive diarize flow. */
export type FlowState = {
  segments: AttrSegment[];
  /** Model used for the transcription (informational). */
  model?: string;
};

export type SenderSettings = {
  /** Default transcription model. */
  model: string;
  /** Default language ISO code or "auto". */
  language: string;
  /** Whether the diarize command is offered (also gated on OPENROUTER_API_KEY). */
  diarizeEnabled: boolean;
};
