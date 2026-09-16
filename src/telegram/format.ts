// Pure text formatting for Telegram replies (HTML parse mode). No I/O.
import type { AttributeResult } from "../lib/attribute-core";
import type { EngineResolution } from "../lib/engine";
import type { TranscribeProgress } from "../lib/transcribe-core";
import type { TranscriptState } from "./types";

export const TG_TEXT_MAX = 4096;
export const TG_CAPTION_MAX = 1024;
/** Rendered transcripts longer than this are sent as a PDF instead of a message. */
export const TEXT_CUTOFF = (() => {
  const n = parseInt(process.env.TELEGRAM_TEXT_LIMIT || "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, TG_TEXT_MAX) : 3000;
})();

export function escapeHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fmtDuration(sec: number): string {
  const s = Math.round(sec || 0);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type Meta = {
  language: string;
  model: string;
  duration: number;
  fallback?: EngineResolution["fallback"];
};

export function footer(m: Meta): string {
  const parts = [m.language || null, m.model, fmtDuration(m.duration)].filter(Boolean);
  if (m.fallback) parts.push(`fell back from ${m.fallback.from}`);
  return `<i>${escapeHtml(parts.join(" · "))}</i>`;
}

type FitOpts = { cutoff?: number };
const fits = (html: string, o: FitOpts) =>
  html.length <= Math.min(o.cutoff ?? TEXT_CUTOFF, TG_TEXT_MAX);

export function transcriptReply(
  state: TranscriptState,
  o: FitOpts & { fallback?: EngineResolution["fallback"] } = {},
): { html: string; plain: string; fitsText: boolean } {
  const plain = (state.text || "").trim() || "(no speech detected)";
  const meta = footer({
    language: state.detectedLanguage,
    model: state.model,
    duration: state.duration,
    fallback: o.fallback,
  });
  const html = `${escapeHtml(plain)}\n\n${meta}`;
  return { html, plain, fitsText: fits(html, o) };
}

export type AttributedLine = { speaker: string; ambiguous: boolean; text: string };

/** Merge consecutive same-speaker segments into lines (ambiguous ones stay separate). */
export function attributedLines(result: AttributeResult): AttributedLine[] {
  const lines: AttributedLine[] = [];
  let last: string | null = null;
  result.merged.forEach((seg: any, i: number) => {
    const ambiguous = result.ambiguous.includes(i);
    const text = (seg.text || "").trim();
    const speaker = String(seg.speaker ?? "?");
    if (speaker === last && !ambiguous) {
      lines[lines.length - 1].text += ` ${text}`;
    } else {
      lines.push({ speaker, ambiguous, text });
      last = ambiguous ? null : speaker;
    }
  });
  return lines;
}

export function attributedReply(
  result: AttributeResult,
  meta: Meta,
  o: FitOpts = {},
): { html: string; plain: string; fitsText: boolean } {
  const lines = attributedLines(result);
  const plain = lines.map((l) => `${l.speaker}${l.ambiguous ? " ⚠️" : ""}: ${l.text}`).join("\n");
  let html = lines
    .map((l) => `<b>${escapeHtml(l.speaker)}</b>${l.ambiguous ? " ⚠️" : ""}: ${escapeHtml(l.text)}`)
    .join("\n");
  if (result.notes) html += `\n\n<i>${escapeHtml(result.notes)}</i>`;
  html += `\n\n${footer(meta)}`;
  return { html, plain, fitsText: fits(html, o) };
}

/** Caption for a PDF delivery: a preview of the text plus the footer, within Telegram's limit. */
export function pdfCaption(previewSource: string, footerHtml: string): string {
  const tail = `…\n\n${footerHtml}`;
  const budget = TG_CAPTION_MAX - tail.length;
  let preview = "";
  for (const ch of (previewSource || "").trim()) {
    const next = preview + escapeHtml(ch);
    if (next.length > budget) break;
    preview = next;
  }
  return `${preview}${tail}`;
}

export function progressText(ev: TranscribeProgress, model: string): string | null {
  switch (ev.status) {
    case "loading_model":
      return `⏳ Loading ${model}…`;
    case "downloading": {
      const p = typeof ev.progress === "number" ? ` ${Math.round(ev.progress)}%` : "";
      return `⬇️ Downloading ${model}…${p}`;
    }
    case "chunking":
      return "✂️ Splitting long audio…";
    case "chunked":
      return `🎙 Transcribing (${model})… ${typeof ev.total === "number" ? `${ev.total} chunks` : ""}`.trim();
    case "transcribing": {
      const chunk =
        typeof ev.chunk === "number" && typeof ev.total === "number"
          ? ` chunk ${ev.chunk}/${ev.total}`
          : "";
      return `🎙 Transcribing (${model})…${chunk}`;
    }
    default:
      return null;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function pdfFilename(
  state: TranscriptState,
  o: { now?: Date; speakers?: boolean } = {},
): string {
  const suffix = o.speakers ? " - speakers" : "";
  const name = (state.audio.fileName || "").replace(/\.[a-z0-9]{2,4}$/i, "").trim();
  if (name) return `${name}${suffix}.pdf`;
  const d = o.now || new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `Recording ${stamp}${suffix}.pdf`;
}

export const HELP = [
  "🎙️ <b>Whisper It</b> — send me a voice note, audio file or forward one and I'll transcribe it.",
  "",
  "Under each transcript:",
  "• <b>Retry</b> — run it again with a different model",
  "• <b>Language</b> — force a language and re-run",
  "• <b>Diarize</b> — label the speakers (guess, or give names)",
  "",
  "Commands:",
  "/model — pick your default model",
  "/language — pick your default language",
  "/diarize Alice, Bob — label speakers on your last transcript",
  "/help — show this again",
].join("\n");

export const WELCOME = `👋 <b>Welcome!</b>\n\n${HELP}`;

export const NOT_AUTHORISED = (id: number): string =>
  `Not authorised. Your Telegram ID is <code>${id}</code> — ask the admin to whitelist it.`;

export const FILE_TOO_BIG = (bytes?: number): string => {
  const mb = bytes ? ` (${(bytes / 1024 / 1024).toFixed(0)} MB)` : "";
  return `That file is too big${mb} — Telegram only lets bots download files up to 20 MB. Send a shorter clip or a compressed audio (OGG/M4A).`;
};
