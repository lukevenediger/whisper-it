// Pure parsing of inbound WhatsApp text into bot commands. No I/O.

export type Command = { kind: "none" } | { kind: "help" } | { kind: "diarize"; names: string[] };

// Split a names string on commas, "and", or "&".
const NAME_SEP = /\s*,\s*|\s+and\s+|\s*&\s*/i;

function splitNames(rest: string): string[] {
  const trimmed = (rest || "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(NAME_SEP)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => n.slice(0, 80));
}

/**
 * Parse a standalone text message (the reply-flow case). Commands must lead the
 * message: a bare "diarize"/"diarise" (optionally followed by names) or "help".
 * Anything else is `none`.
 */
export function parseCommand(text: string): Command {
  const trimmed = (text || "").trim();
  if (!trimmed) return { kind: "none" };
  if (/^help$/i.test(trimmed)) return { kind: "help" };

  const m = trimmed.match(/^diari[sz]e\b\s*(.*)$/is);
  if (m) return { kind: "diarize", names: splitNames(m[1]) };

  return { kind: "none" };
}

/**
 * Detect a diarize request anywhere inside an audio message's caption, pulling
 * any names that follow the keyword. Used for the "transcribe-then-attribute
 * immediately" path.
 */
export function extractDiarize(caption: string): { found: boolean; names: string[] } {
  const text = caption || "";
  const m = text.match(/diari[sz]e\b\s*([^\n]*)/i);
  if (!m) return { found: false, names: [] };
  return { found: true, names: splitNames(m[1]) };
}
