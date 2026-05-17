export type AttrSegment = { start: number; end: number; text: string };
export type AttrSpeaker = { name: string; description?: string };

export const ATTR_MAX_SEGMENTS = 600;
export const ATTR_DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

/** Curated options surfaced in the attribute modal dropdown. Server still accepts any string. */
export const ATTR_MODEL_OPTIONS = [
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.5-flash-02-23",
  "google/gemma-4-31b-it",
  "google/gemma-4-26b-a4b-it",
] as const;

export type AttrPromptInput = {
  segments: AttrSegment[];
  /** Optional roster of named speakers. If empty, the model is asked to guess speaker count and use "Speaker 1", "Speaker 2", ... labels. */
  speakers: AttrSpeaker[];
};

export function buildAttributionPrompt(input: AttrPromptInput): { system: string; user: string } {
  const { segments, speakers } = input;
  const hasRoster = speakers.length > 0;

  const roster = hasRoster
    ? speakers
        .map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n")
    : "(no roster provided)";

  const seg = segments
    .map((s, i) => `[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}s: ${s.text}`)
    .join("\n");

  const labellingRule = hasRoster
    ? "Use ONLY speaker names from the roster above. Be consistent: reuse the same name for the same person across segments."
    : 'There is no roster. First infer how many distinct speakers are talking from the dialogue, then label them "Speaker 1", "Speaker 2", "Speaker 3", ... in the order they first appear. Use those exact labels.';

  const system = [
    "You assign speakers to transcript segments.",
    "Inputs: (1) a roster of known speakers (possibly empty), (2) numbered transcript segments.",
    'For each segment, decide which speaker is talking using semantic cues — names addressed ("Thanks Alice" → Bob is speaking), topical handoffs, style, and any roster context.',
    labellingRule,
    "Return ONLY a JSON object of the form:",
    '{"assignments": {"0": "Name", "1": "Name", ...}, "ambiguous": [<segment_index>, ...], "notes": "<short paragraph or empty string>"}',
    "- `assignments` MUST cover every segment index as a string key.",
    "- `ambiguous` is the list of segment indices you were not confident about (could be empty).",
    "- `notes` is a short human-readable explanation of how you resolved hard cases or what context would have helped (or empty string).",
    "- No prose outside the JSON. No markdown fences. JSON only.",
  ].join(" ");

  const user = `Speaker roster:\n${roster}\n\nSegments:\n${seg}\n\nReturn the JSON object now.`;
  return { system, user };
}

export type AttrResult = {
  merged: any[];
  speakers: string[];
  ambiguous: number[];
  notes: string;
  warning?: string;
};

export function applyAssignments(segments: AttrSegment[], raw: string): AttrResult {
  let json = raw.trim();
  if (json.startsWith("```")) {
    json = json
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
  }
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    const match = json.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  const assignments =
    parsed && typeof parsed === "object"
      ? parsed.assignments ||
        (parsed.assignments === undefined && !parsed.notes && !parsed.ambiguous ? parsed : null)
      : null;

  if (!assignments || typeof assignments !== "object") {
    const merged = segments.map((s, i) => ({
      ...s,
      speaker: `Speaker ${(i % 2) + 1}`,
    }));
    const speakers = Array.from(new Set(merged.map((s) => s.speaker)));
    return {
      merged,
      speakers,
      ambiguous: segments.map((_, i) => i),
      notes: "",
      warning:
        "Model returned unparseable output — using fallback labels and marking all segments ambiguous.",
    };
  }

  const seen: string[] = [];
  const merged = segments.map((s, i) => {
    const v = assignments[String(i)];
    const speaker = typeof v === "string" && v.trim() ? v.trim() : `SPEAKER_??`;
    if (speaker !== "SPEAKER_??" && !seen.includes(speaker)) seen.push(speaker);
    return { ...s, speaker };
  });

  const ambiguousRaw = parsed && Array.isArray(parsed.ambiguous) ? parsed.ambiguous : [];
  const ambiguous = ambiguousRaw
    .map((v: any) => (typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN))
    .filter((n: number) => Number.isInteger(n) && n >= 0 && n < segments.length);

  // Also flag any segments left as SPEAKER_?? as ambiguous, dedup.
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].speaker === "SPEAKER_??" && !ambiguous.includes(i)) ambiguous.push(i);
  }

  const notes = parsed && typeof parsed.notes === "string" ? parsed.notes.trim() : "";

  return { merged, speakers: seen, ambiguous, notes };
}
