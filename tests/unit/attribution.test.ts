import { describe, it, expect } from "vitest";
import {
  buildAttributionPrompt,
  applyAssignments,
  countAssignedKeys,
  ATTR_DEFAULT_MODEL,
} from "../../src/lib/attribution";

const seg = (start: number, end: number, text: string) => ({ start, end, text });

describe("buildAttributionPrompt", () => {
  it("includes the roster when speakers provided", () => {
    const { user } = buildAttributionPrompt({
      segments: [seg(0, 1, "hi")],
      speakers: [{ name: "Alice", description: "marketer" }, { name: "Bob" }],
    });
    expect(user).toContain("1. Alice — marketer");
    expect(user).toContain("2. Bob");
  });

  it("uses guess-and-label instructions when roster is empty", () => {
    const { system } = buildAttributionPrompt({ segments: [seg(0, 1, "hi")], speakers: [] });
    expect(system).toContain("infer how many distinct speakers");
    expect(system).toContain('"Speaker 1"');
    expect(system).toContain('"Speaker 2"');
  });

  it("locks to roster names when speakers are provided", () => {
    const { system } = buildAttributionPrompt({
      segments: [seg(0, 1, "hi")],
      speakers: [{ name: "Alice" }],
    });
    expect(system).toContain("ONLY speaker names from the roster");
  });

  it("numbers segments with indices and timestamps", () => {
    const { user } = buildAttributionPrompt({
      segments: [seg(0, 1.5, "foo"), seg(1.5, 3, "bar")],
      speakers: [{ name: "Alice" }],
    });
    expect(user).toContain("[0] 0.0-1.5s: foo");
    expect(user).toContain("[1] 1.5-3.0s: bar");
  });

  it("system prompt mandates JSON-only with assignments/ambiguous/notes", () => {
    const { system } = buildAttributionPrompt({ segments: [seg(0, 1, "x")], speakers: [] });
    expect(system).toContain("JSON only");
    expect(system).toContain("assignments");
    expect(system).toContain("ambiguous");
    expect(system).toContain("notes");
  });
});

describe("applyAssignments", () => {
  const s = [seg(0, 1, "first"), seg(1, 2, "second"), seg(2, 3, "third")];

  it("parses clean JSON with assignments + ambiguous + notes", () => {
    const raw = JSON.stringify({
      assignments: { "0": "Alice", "1": "Bob", "2": "Alice" },
      ambiguous: [1],
      notes: "Bob's turn was short.",
    });
    const r = applyAssignments(s, raw);
    expect(r.merged.map((m) => m.speaker)).toEqual(["Alice", "Bob", "Alice"]);
    expect(r.speakers).toEqual(["Alice", "Bob"]);
    expect(r.ambiguous).toEqual([1]);
    expect(r.notes).toContain("Bob's turn");
    expect(r.warning).toBeUndefined();
  });

  it("treats missing ambiguous/notes as empty", () => {
    const raw = JSON.stringify({ assignments: { "0": "X", "1": "Y", "2": "X" } });
    const r = applyAssignments(s, raw);
    expect(r.ambiguous).toEqual([]);
    expect(r.notes).toBe("");
  });

  it("filters invalid indices in ambiguous", () => {
    const raw = JSON.stringify({
      assignments: { "0": "A", "1": "B", "2": "A" },
      ambiguous: [99, -1, "x", 1, "0"],
    });
    const r = applyAssignments(s, raw);
    expect(r.ambiguous.sort()).toEqual([0, 1]);
  });

  it("strips markdown fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify({ assignments: { "0": "X", "1": "X", "2": "Y" }, ambiguous: [], notes: "" }) +
      "\n```";
    const r = applyAssignments(s, raw);
    expect(r.merged.map((m) => m.speaker)).toEqual(["X", "X", "Y"]);
    expect(r.warning).toBeUndefined();
  });

  it("recovers JSON from prose preamble", () => {
    const raw = `Sure! Here is the result:\n{"assignments": {"0": "A", "1": "B", "2": "A"}, "ambiguous": [], "notes": "ok"}`;
    const r = applyAssignments(s, raw);
    expect(r.merged.map((m) => m.speaker)).toEqual(["A", "B", "A"]);
    expect(r.notes).toBe("ok");
  });

  it("trims whitespace in speaker names", () => {
    const raw = JSON.stringify({
      assignments: { "0": "  Alice  ", "1": "Bob\n", "2": "Alice" },
    });
    const r = applyAssignments(s, raw);
    expect(r.merged.map((m) => m.speaker)).toEqual(["Alice", "Bob", "Alice"]);
  });

  it("auto-flags SPEAKER_?? segments as ambiguous", () => {
    const raw = JSON.stringify({ assignments: { "0": "Alice" } });
    const r = applyAssignments(s, raw);
    expect(r.merged.map((m) => m.speaker)).toEqual(["Alice", "SPEAKER_??", "SPEAKER_??"]);
    expect(r.ambiguous.sort()).toEqual([1, 2]);
  });

  it("falls back on malformed JSON with 'Speaker N' labels and marks all ambiguous", () => {
    const r = applyAssignments(s, "not json at all");
    expect(r.merged.map((m) => m.speaker)).toEqual(["Speaker 1", "Speaker 2", "Speaker 1"]);
    expect(r.ambiguous).toEqual([0, 1, 2]);
    expect(r.warning).toMatch(/unparseable/i);
  });

  it("falls back when assignments value is non-object", () => {
    const r = applyAssignments(s, JSON.stringify({ assignments: "broken" }));
    expect(r.warning).toBeDefined();
  });

  it("ignores empty-string assignments and uses SPEAKER_??", () => {
    const raw = JSON.stringify({ assignments: { "0": "Alice", "1": "", "2": "Bob" } });
    const r = applyAssignments(s, raw);
    expect(r.merged[1].speaker).toBe("SPEAKER_??");
    expect(r.ambiguous).toContain(1);
  });

  it("default model is deepseek-v4-flash", () => {
    expect(ATTR_DEFAULT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("countAssignedKeys", () => {
  it("counts integer assignment keys in complete JSON", () => {
    const raw = JSON.stringify({
      assignments: { "0": "A", "1": "B", "2": "A" },
      ambiguous: [1],
      notes: "x",
    });
    expect(countAssignedKeys(raw)).toBe(3);
  });

  it("counts keys in partial / mid-stream JSON", () => {
    const partial = '{"assignments": {"0": "Alice", "1": "Bob", "2": "Ali';
    expect(countAssignedKeys(partial)).toBe(3);
  });

  it("ignores ambiguous array numbers and notes prose", () => {
    const raw = '{"assignments": {"0": "A"}, "ambiguous": [1, 2, 3], "notes": "saw 5 things"}';
    expect(countAssignedKeys(raw)).toBe(1);
  });

  it("counts each index once even if a key repeats", () => {
    const raw = '{"assignments": {"0":"A","0":"A","1":"B"}}';
    expect(countAssignedKeys(raw)).toBe(2);
  });

  it("returns 0 when no integer keys present yet", () => {
    expect(countAssignedKeys('{"assignments": {')).toBe(0);
    expect(countAssignedKeys("")).toBe(0);
  });
});
