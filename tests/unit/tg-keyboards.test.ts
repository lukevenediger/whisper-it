import { describe, it, expect } from "vitest";
import {
  transcriptKeyboard,
  modelPicker,
  languagePicker,
  diarizeMenu,
  llmPicker,
  shortLlmName,
  LANGUAGES,
} from "../../src/telegram/keyboards";
import { decodeCallback } from "../../src/telegram/callback-data";
import { VALID_LANGUAGES } from "../../src/lib/languages";
import { ATTR_MODEL_OPTIONS } from "../../src/lib/attribution";

const flat = (kb: { inline_keyboard: { text: string; callback_data: string }[][] }) =>
  kb.inline_keyboard.flat();

describe("keyboards", () => {
  it("transcript keyboard shows Retry/Diarize/Language, hides Diarize when unavailable, Retry only when failed", () => {
    expect(flat(transcriptKeyboard({ diarize: true })).map((b) => b.text)).toEqual([
      "Retry",
      "Diarize",
      "Language",
    ]);
    expect(flat(transcriptKeyboard({ diarize: false })).map((b) => b.text)).toEqual([
      "Retry",
      "Language",
    ]);
    expect(flat(transcriptKeyboard({ diarize: true, failed: true })).map((b) => b.text)).toEqual([
      "Retry",
    ]);
  });

  it("model picker excludes the current model and ends with a Back button", () => {
    const buttons = flat(modelPicker("small", "retry"));
    const actions = buttons.map((b) => decodeCallback(b.callback_data));
    expect(actions).not.toContainEqual({ kind: "retry", model: "small" });
    expect(actions).toContainEqual({ kind: "retry", model: "large-v3" });
    expect(actions[actions.length - 1]).toEqual({ kind: "menu", menu: "root" });
    // pref flavour emits pref actions and a noop cancel
    const pref = flat(modelPicker("small", "pref")).map((b) => decodeCallback(b.callback_data));
    expect(pref).toContainEqual({ kind: "pref", field: "model", value: "medium" });
    expect(pref[pref.length - 1]).toEqual({ kind: "noop" });
  });

  it("language picker only offers valid codes and marks the current one", () => {
    for (const l of LANGUAGES) expect(VALID_LANGUAGES.has(l.code)).toBe(true);
    const buttons = flat(languagePicker("de", "lang"));
    const current = buttons.find(
      (b) => decodeCallback(b.callback_data)?.kind === "lang" && b.text.includes("Deutsch"),
    );
    expect(current?.text).toMatch(/✓/);
    expect(buttons.map((b) => decodeCallback(b.callback_data))).toContainEqual({
      kind: "lang",
      language: "auto",
    });
  });

  it("diarize menu offers guess / names / llm / back, and llm picker lists every curated model", () => {
    const menu = flat(diarizeMenu(ATTR_MODEL_OPTIONS[0])).map((b) =>
      decodeCallback(b.callback_data),
    );
    expect(menu).toEqual([
      { kind: "diar", mode: "guess" },
      { kind: "diar", mode: "names" },
      { kind: "menu", menu: "llm" },
      { kind: "menu", menu: "root" },
    ]);
    const llm = flat(llmPicker(ATTR_MODEL_OPTIONS[1]));
    expect(llm.filter((b) => decodeCallback(b.callback_data)?.kind === "llm")).toHaveLength(
      ATTR_MODEL_OPTIONS.length,
    );
    expect(llm[1].text).toMatch(/✓/);
  });

  it("every button's callback data decodes", () => {
    const all = [
      transcriptKeyboard({ diarize: true }),
      modelPicker("tiny", "retry"),
      languagePicker("auto", "pref"),
      diarizeMenu(ATTR_MODEL_OPTIONS[0]),
      llmPicker(ATTR_MODEL_OPTIONS[0]),
    ];
    for (const kb of all)
      for (const b of flat(kb)) expect(decodeCallback(b.callback_data)).not.toBeNull();
  });

  it("shortLlmName strips the provider prefix", () => {
    expect(shortLlmName("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(shortLlmName("plain")).toBe("plain");
  });
});
