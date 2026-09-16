import { describe, it, expect } from "vitest";
import { VALID_MODELS } from "../../src/lib/engine";
import { VALID_LANGUAGES } from "../../src/lib/languages";
import { splitNames } from "../../src/whatsapp/command-parser";

describe("shared model / language lists", () => {
  it("VALID_MODELS lists every whisper size plus parakeet", () => {
    expect([...VALID_MODELS]).toEqual([
      "parakeet-v3",
      "tiny",
      "base",
      "small",
      "medium",
      "large-v3",
    ]);
  });

  it("VALID_LANGUAGES contains auto and common ISO codes", () => {
    expect(VALID_LANGUAGES.has("auto")).toBe(true);
    expect(VALID_LANGUAGES.has("en")).toBe(true);
    expect(VALID_LANGUAGES.has("ja")).toBe(true);
    expect(VALID_LANGUAGES.has("xx")).toBe(false);
  });
});

describe("splitNames (exported)", () => {
  it("splits on commas, 'and', and '&'", () => {
    expect(splitNames("Alice, Bob and Carol & Dave")).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    expect(splitNames("")).toEqual([]);
  });
});
