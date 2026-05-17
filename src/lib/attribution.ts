export type AttrSegment = { start: number; end: number; text: string };
export type AttrSpeaker = { name: string; description?: string };

export const ATTR_MAX_SEGMENTS = 600;
export const ATTR_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export type AttrPromptInput = {
  segments: AttrSegment[];
  speakers: AttrSpeaker[];
  /** Expected number of distinct speakers. Pass `undefined` (or "auto") to let the model decide. */
  speakerCount?: number | "auto";
  /** Optional extra hints from earlier iterations: free-form context the user supplies on refinement. */
  extraContext?: string;
};

export function buildAttributionPrompt(input: AttrPromptInput): { system: string; user: string } {
  const { segments, speakers, speakerCount, extraContext } = input;

  const roster =
    speakers.length > 0
      ? speakers
          .map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`)
          .join("\n")
      : '(none provided — invent stable labels like "Speaker A", "Speaker B")';

  const seg = segments
    .map((s, i) => `[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}s: ${s.text}`)
    .join("\n");

  const countLine =
    typeof speakerCount === "number" && speakerCount > 0
      ? `Expected speaker count: ${speakerCount}. Do not invent more or fewer distinct speakers.`
      : "Expected speaker count: auto-detect from the dialogue.";

  const contextBlock =
    extraContext && extraContext.trim()
      ? `\n\nExtra context from the user:\n${extraContext.trim()}`
      : "";

  const system = [
    "You assign speakers to transcript segments.",
    "Inputs: (1) a roster of known speakers with optional context, (2) the expected speaker count, (3) numbered transcript segments, (4) optional extra context from the user.",
    'For each segment, decide which speaker is talking. Use semantic cues — names addressed ("Thanks Alice" → Bob is speaking), topical handoffs, style, and any roster context.',
    "Return ONLY a JSON object of the form:",
    '{"assignments": {"0": "Name", "1": "Name", ...}, "ambiguous": [<segment_index>, ...], "notes": "<short paragraph or empty string>"}',
    "- `assignments` MUST cover every segment index as a string key.",
    "- `ambiguous` is the list of segment indices you were not confident about (could be empty).",
    "- `notes` is a short human-readable explanation of how you resolved hard cases or what context would have helped (or empty string).",
    '- Use speaker names from the roster when provided. If no roster, invent stable labels like "Speaker A", "Speaker B".',
    "- Be consistent: re-use the same name for the same person across segments.",
    "- No prose outside the JSON. No markdown fences. JSON only.",
  ].join(" ");

  const user = `Speaker roster:\n${roster}\n\n${countLine}\n\nSegments:\n${seg}${contextBlock}\n\nReturn the JSON object now.`;
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
      speaker: `SPEAKER_${String(i % 2).padStart(2, "0")}`,
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
