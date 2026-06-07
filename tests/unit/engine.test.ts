import { describe, it, expect } from "vitest";
import { resolveEngine, PARAKEET_MODEL, PARAKEET_LANGS } from "../../src/lib/engine";

describe("PARAKEET_LANGS", () => {
  it("covers the 25 supported European languages", () => {
    expect(PARAKEET_LANGS.size).toBe(25);
    for (const code of ["en", "fr", "de", "es", "it", "ru", "uk", "pl", "nl", "mt"]) {
      expect(PARAKEET_LANGS.has(code)).toBe(true);
    }
  });
});

describe("resolveEngine", () => {
  it("uses Parakeet for auto-detect", () => {
    const r = resolveEngine(PARAKEET_MODEL, "auto");
    expect(r.engine).toBe("parakeet");
    expect(r.model).toBe(PARAKEET_MODEL);
    expect(r.fallback).toBeUndefined();
  });

  it("uses Parakeet for a supported language", () => {
    const r = resolveEngine(PARAKEET_MODEL, "fr");
    expect(r.engine).toBe("parakeet");
    expect(r.model).toBe(PARAKEET_MODEL);
    expect(r.fallback).toBeUndefined();
  });

  it("falls back to Whisper for an unsupported language", () => {
    const r = resolveEngine(PARAKEET_MODEL, "ja");
    expect(r.engine).toBe("whisper");
    expect(r.model).toBe("small");
    expect(r.fallback).toEqual({
      from: PARAKEET_MODEL,
      to: "small",
      reason: expect.stringContaining("ja"),
    });
  });

  it("honors a custom fallback model", () => {
    const r = resolveEngine(PARAKEET_MODEL, "zh", "base");
    expect(r.engine).toBe("whisper");
    expect(r.model).toBe("base");
    expect(r.fallback?.to).toBe("base");
  });

  it("passes Whisper models through unchanged (no fallback even for non-Parakeet langs)", () => {
    expect(resolveEngine("small", "en")).toEqual({ model: "small", engine: "whisper" });
    expect(resolveEngine("medium", "ja")).toEqual({ model: "medium", engine: "whisper" });
  });

  it("normalizes language case and whitespace", () => {
    expect(resolveEngine(PARAKEET_MODEL, "FR ").engine).toBe("parakeet");
    expect(resolveEngine(PARAKEET_MODEL, " ").engine).toBe("parakeet"); // blank == auto
    expect(resolveEngine(PARAKEET_MODEL, "").engine).toBe("parakeet");
  });
});
