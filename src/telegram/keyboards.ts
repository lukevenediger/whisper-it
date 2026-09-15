// Inline keyboard builders. Pure; every button's callback_data round-trips
// through callback-data.ts.
import { VALID_MODELS } from "../lib/engine";
import { ATTR_MODEL_OPTIONS } from "../lib/attribution";
import { encodeCallback } from "./callback-data";
import type { CallbackAction } from "./callback-data";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./types";

/** Curated picker languages (all must be in VALID_LANGUAGES). "/language xx" accepts any valid code. */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "af", label: "Afrikaans" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "ru", label: "Русский" },
  { code: "uk", label: "Українська" },
  { code: "tr", label: "Türkçe" },
  { code: "sv", label: "Svenska" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
];

const btn = (text: string, action: CallbackAction): InlineKeyboardButton => ({
  text,
  callback_data: encodeCallback(action),
});

function rows(buttons: InlineKeyboardButton[], perRow: number): InlineKeyboardButton[][] {
  const out: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) out.push(buttons.slice(i, i + perRow));
  return out;
}

const BACK = btn("« Back", { kind: "menu", menu: "root" });
const CANCEL = btn("Cancel", { kind: "noop" });

export function transcriptKeyboard(o: {
  diarize: boolean;
  failed?: boolean;
}): InlineKeyboardMarkup {
  const row: InlineKeyboardButton[] = [btn("Retry", { kind: "menu", menu: "retry" })];
  if (!o.failed) {
    if (o.diarize) row.push(btn("Diarize", { kind: "menu", menu: "diar" }));
    row.push(btn("Language", { kind: "menu", menu: "lang" }));
  }
  return { inline_keyboard: [row] };
}

export function modelPicker(current: string, prefix: "retry" | "pref"): InlineKeyboardMarkup {
  const buttons = VALID_MODELS.filter((m) => m !== current).map((m) =>
    btn(
      m,
      prefix === "retry" ? { kind: "retry", model: m } : { kind: "pref", field: "model", value: m },
    ),
  );
  return { inline_keyboard: [...rows(buttons, 3), [prefix === "retry" ? BACK : CANCEL]] };
}

export function languagePicker(current: string, prefix: "lang" | "pref"): InlineKeyboardMarkup {
  const buttons = LANGUAGES.map((l) =>
    btn(
      l.code === current ? `✓ ${l.label}` : l.label,
      prefix === "lang"
        ? { kind: "lang", language: l.code }
        : { kind: "pref", field: "language", value: l.code },
    ),
  );
  return { inline_keyboard: [...rows(buttons, 3), [prefix === "lang" ? BACK : CANCEL]] };
}

export function shortLlmName(model: string): string {
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

export function diarizeMenu(attrModel: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        btn("Guess speakers", { kind: "diar", mode: "guess" }),
        btn("Enter names", { kind: "diar", mode: "names" }),
      ],
      [btn(`LLM: ${shortLlmName(attrModel)} ▸`, { kind: "menu", menu: "llm" })],
      [BACK],
    ],
  };
}

export function llmPicker(current: string): InlineKeyboardMarkup {
  const buttons = ATTR_MODEL_OPTIONS.map((m, index) =>
    btn(m === current ? `✓ ${shortLlmName(m)}` : shortLlmName(m), { kind: "llm", index }),
  );
  return {
    inline_keyboard: [...rows(buttons, 1), [btn("« Back", { kind: "menu", menu: "diar" })]],
  };
}
