import { describe, it, expect } from "vitest";
import { countWords } from "../../src/lib/words";

describe("countWords", () => {
  it("counts simple words", () => {
    expect(countWords("hello world")).toBe(2);
  });
  it("returns 0 for empty string", () => {
    expect(countWords("")).toBe(0);
  });
  it("returns 0 for whitespace-only", () => {
    expect(countWords("   \t\n  ")).toBe(0);
  });
  it("collapses multiple spaces", () => {
    expect(countWords("a   b\t\tc")).toBe(3);
  });
  it("handles leading/trailing whitespace", () => {
    expect(countWords("  hello world  ")).toBe(2);
  });
  it("handles unicode", () => {
    expect(countWords("hola, ¿cómo estás?")).toBe(3);
  });
  it("counts contractions as one word", () => {
    expect(countWords("don't can't won't")).toBe(3);
  });
});
