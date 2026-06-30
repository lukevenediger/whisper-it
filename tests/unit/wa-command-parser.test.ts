import { describe, it, expect } from "vitest";
import { parseCommand, extractDiarize } from "../../src/whatsapp/command-parser";

describe("parseCommand", () => {
  it("treats empty / whitespace text as no command", () => {
    expect(parseCommand("").kind).toBe("none");
    expect(parseCommand("   ").kind).toBe("none");
  });

  it("recognizes 'help' (case-insensitive, trimmed)", () => {
    expect(parseCommand("help").kind).toBe("help");
    expect(parseCommand("  HELP ").kind).toBe("help");
  });

  it("recognizes a bare diarize/diarise with no names", () => {
    expect(parseCommand("diarize")).toEqual({ kind: "diarize", names: [] });
    expect(parseCommand("diarise")).toEqual({ kind: "diarize", names: [] });
    expect(parseCommand("Diarize")).toEqual({ kind: "diarize", names: [] });
  });

  it("parses comma- and 'and'-separated names, preserving case", () => {
    expect(parseCommand("diarize Alice, Bob").names).toEqual(["Alice", "Bob"]);
    expect(parseCommand("diarise Alice and Bob").names).toEqual(["Alice", "Bob"]);
    expect(parseCommand("diarize Alice & Bob, Carol").names).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("does not treat arbitrary text as a command", () => {
    expect(parseCommand("please transcribe this").kind).toBe("none");
    expect(parseCommand("undiarize").kind).toBe("none");
  });
});

describe("extractDiarize (caption anywhere)", () => {
  it("finds the keyword anywhere in a caption", () => {
    expect(extractDiarize("can you diarize this please").found).toBe(true);
    expect(extractDiarize("DIARISE Alice, Bob").found).toBe(true);
  });

  it("returns no match when the keyword is absent", () => {
    expect(extractDiarize("just transcribe").found).toBe(false);
    expect(extractDiarize("").found).toBe(false);
  });

  it("pulls names that follow the keyword", () => {
    expect(extractDiarize("diarize Alice, Bob").names).toEqual(["Alice", "Bob"]);
  });
});
