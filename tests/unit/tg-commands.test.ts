import { describe, it, expect } from "vitest";
import { parseSlash, BOT_COMMANDS } from "../../src/telegram/commands";

describe("parseSlash", () => {
  it("recognises the bot commands with optional @BotName suffix and args", () => {
    expect(parseSlash("/start")).toEqual({ kind: "start" });
    expect(parseSlash("/help@WhisperItBot")).toEqual({ kind: "help" });
    expect(parseSlash("/model")).toEqual({ kind: "model" });
    expect(parseSlash("/model large-v3")).toEqual({ kind: "model", arg: "large-v3" });
    expect(parseSlash("/language DE")).toEqual({ kind: "language", arg: "de" });
    expect(parseSlash("/diarize Alice and Bob")).toEqual({
      kind: "diarize",
      names: ["Alice", "Bob"],
    });
    expect(parseSlash("/DIARISE")).toEqual({ kind: "diarize", names: [] });
  });

  it("returns unknown for other slash commands and none for plain text", () => {
    expect(parseSlash("/frobnicate 1")).toEqual({ kind: "unknown", name: "frobnicate" });
    expect(parseSlash("hello there")).toEqual({ kind: "none" });
    expect(parseSlash("")).toEqual({ kind: "none" });
  });

  it("BOT_COMMANDS is valid for setMyCommands", () => {
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual([
      "start",
      "help",
      "model",
      "language",
      "diarize",
    ]);
  });
});
