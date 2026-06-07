// Engine routing: Parakeet v3 (onnx-asr) is the default engine; faster-whisper
// models are alternates. Parakeet auto-detects across 25 European languages and
// ignores manual language hints. If a user forces a language Parakeet can't do,
// we transparently fall back to a Whisper model.

export const PARAKEET_MODEL = "parakeet-v3";

// The 25 languages nvidia/parakeet-tdt-0.6b-v3 supports (ISO 639-1).
export const PARAKEET_LANGS = new Set([
  "bg",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "hu",
  "it",
  "lv",
  "lt",
  "mt",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "es",
  "sv",
  "ru",
  "uk",
]);

export interface EngineResolution {
  /** The model to actually run (may differ from the requested one on fallback). */
  model: string;
  engine: "parakeet" | "whisper";
  /** Present only when a Parakeet request was downgraded to Whisper. */
  fallback?: { from: string; to: string; reason: string };
}

/**
 * Decide which engine/model actually runs for a requested model + language.
 *
 * @param model        requested model (already validated by the caller)
 * @param language     requested language ("auto", "" or an ISO 639-1 code)
 * @param fallbackModel Whisper model to use when Parakeet can't serve the language
 */
export function resolveEngine(
  model: string,
  language: string,
  fallbackModel = "small",
): EngineResolution {
  const lang = (language || "").toLowerCase().trim();
  const isAuto = lang === "" || lang === "auto";

  if (model === PARAKEET_MODEL) {
    if (isAuto || PARAKEET_LANGS.has(lang)) {
      return { model: PARAKEET_MODEL, engine: "parakeet" };
    }
    return {
      model: fallbackModel,
      engine: "whisper",
      fallback: {
        from: PARAKEET_MODEL,
        to: fallbackModel,
        reason: `Parakeet v3 doesn't support language '${lang}'`,
      },
    };
  }

  return { model, engine: "whisper" };
}
