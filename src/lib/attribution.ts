export type AttrSegment = { start: number; end: number; text: string };
export type AttrSpeaker = { name: string; description?: string };

export const ATTR_MAX_SEGMENTS = 600;
export const ATTR_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export function buildAttributionPrompt(
  segments: AttrSegment[],
  speakers: AttrSpeaker[],
): { system: string; user: string } {
  const roster =
    speakers.length > 0
      ? speakers
          .map((s, i) => `${i + 1}. ${s.name}${s.description ? ` — ${s.description}` : ""}`)
          .join("\n")
      : '(none provided — invent stable labels like "Speaker A", "Speaker B")';

  const seg = segments
    .map((s, i) => `[${i}] ${s.start.toFixed(1)}-${s.end.toFixed(1)}s: ${s.text}`)
    .join("\n");

  const system = [
    "You assign speakers to transcript segments.",
    "You are given (1) a roster of known speakers with optional context and (2) numbered transcript segments.",
    "For each segment, decide which speaker is talking, using the context provided to map style/topic/role to names.",
    'Return ONLY a JSON object of the form {"assignments": {"0": "Name", "1": "Name", ...}}.',
    "Keys are segment indices as strings. Values are speaker names from the roster (or your invented labels if no roster).",
    "Do not return any prose, explanation, or markdown — JSON only.",
    "Be consistent: re-use the same name for the same person across segments.",
  ].join(" ");

  const user = `Speaker roster:\n${roster}\n\nSegments:\n${seg}\n\nReturn the JSON object now.`;
  return { system, user };
}

export function applyAssignments(
  segments: AttrSegment[],
  raw: string,
): { merged: any[]; speakers: string[]; warning?: string } {
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
  const assignments = parsed && typeof parsed === "object" ? parsed.assignments || parsed : null;
  if (!assignments || typeof assignments !== "object") {
    const merged = segments.map((s, i) => ({
      ...s,
      speaker: `SPEAKER_${String(i % 2).padStart(2, "0")}`,
    }));
    const speakers = Array.from(new Set(merged.map((s) => s.speaker)));
    return {
      merged,
      speakers,
      warning: "Model returned unparseable output — using fallback labels.",
    };
  }
  const seen: string[] = [];
  const merged = segments.map((s, i) => {
    const v = assignments[String(i)];
    const speaker = typeof v === "string" && v.trim() ? v.trim() : `SPEAKER_??`;
    if (speaker !== "SPEAKER_??" && !seen.includes(speaker)) seen.push(speaker);
    return { ...s, speaker };
  });
  return { merged, speakers: seen };
}
