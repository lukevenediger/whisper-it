import { describe, it, expect } from "vitest";
import { sanitizeZipName } from "../../src/lib/sanitize";

describe("sanitizeZipName", () => {
  it("returns input unchanged for clean names", () => {
    expect(sanitizeZipName("my_file.txt")).toBe("my_file.txt");
  });
  it("strips control characters", () => {
    expect(sanitizeZipName("ev\x00il\x1fname.txt")).toBe("evilname.txt");
  });
  it("replaces forward slashes", () => {
    expect(sanitizeZipName("a/b/c.txt")).toBe("a_b_c.txt");
  });
  it("replaces backslashes", () => {
    expect(sanitizeZipName("a\\b\\c.txt")).toBe("a_b_c.txt");
  });
  it("strips leading dots", () => {
    expect(sanitizeZipName("...evil.txt")).toBe("evil.txt");
  });
  it("falls back to default when name reduces to empty", () => {
    expect(sanitizeZipName("...")).toBe("transcript.txt");
    expect(sanitizeZipName("\x00\x01")).toBe("transcript.txt");
  });
  it("caps length at 200", () => {
    const long = "x".repeat(500) + ".txt";
    const out = sanitizeZipName(long);
    expect(out.length).toBe(200);
  });
  it("preserves spaces and unicode", () => {
    expect(sanitizeZipName("hola mundo.txt")).toBe("hola mundo.txt");
    expect(sanitizeZipName("ñoño.txt")).toBe("ñoño.txt");
  });
});
