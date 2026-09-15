import { describe, it, expect } from "vitest";
import {
  encodeCallback,
  decodeCallback,
  CALLBACK_MAX_BYTES,
} from "../../src/telegram/callback-data";
import type { CallbackAction } from "../../src/telegram/callback-data";
import { VALID_MODELS } from "../../src/lib/engine";
import { VALID_LANGUAGES } from "../../src/lib/languages";
import { ATTR_MODEL_OPTIONS } from "../../src/lib/attribution";

describe("callback data", () => {
  const samples: CallbackAction[] = [
    { kind: "menu", menu: "root" },
    { kind: "menu", menu: "retry" },
    { kind: "menu", menu: "lang" },
    { kind: "menu", menu: "diar" },
    { kind: "menu", menu: "llm" },
    { kind: "retry", model: "large-v3" },
    { kind: "lang", language: "de" },
    { kind: "lang", language: "auto" },
    { kind: "diar", mode: "guess" },
    { kind: "diar", mode: "names" },
    { kind: "llm", index: 2 },
    { kind: "pref", field: "model", value: "tiny" },
    { kind: "pref", field: "language", value: "ja" },
    { kind: "noop" },
  ];

  it("round-trips every action", () => {
    for (const a of samples) expect(decodeCallback(encodeCallback(a))).toEqual(a);
  });

  it("never exceeds Telegram's 64-byte limit", () => {
    for (const model of VALID_MODELS) {
      expect(Buffer.byteLength(encodeCallback({ kind: "retry", model }))).toBeLessThanOrEqual(
        CALLBACK_MAX_BYTES,
      );
      expect(
        Buffer.byteLength(encodeCallback({ kind: "pref", field: "model", value: model })),
      ).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
    }
    for (const language of VALID_LANGUAGES) {
      expect(Buffer.byteLength(encodeCallback({ kind: "lang", language }))).toBeLessThanOrEqual(
        CALLBACK_MAX_BYTES,
      );
    }
    ATTR_MODEL_OPTIONS.forEach((_, index) => {
      expect(Buffer.byteLength(encodeCallback({ kind: "llm", index }))).toBeLessThanOrEqual(
        CALLBACK_MAX_BYTES,
      );
    });
  });

  it("rejects junk, unknown versions, unknown models/languages, and out-of-range llm indexes", () => {
    expect(decodeCallback("")).toBeNull();
    expect(decodeCallback("garbage")).toBeNull();
    expect(decodeCallback("t9:menu:root")).toBeNull();
    expect(decodeCallback("t1:retry:gpt-9")).toBeNull();
    expect(decodeCallback("t1:lang:xx")).toBeNull();
    expect(decodeCallback("t1:llm:99")).toBeNull();
    expect(decodeCallback("t1:llm:-1")).toBeNull();
    expect(decodeCallback("t1:pref:colour:red")).toBeNull();
    expect(decodeCallback("t1:menu:nope")).toBeNull();
  });
});
