import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PrefsStore, DEFAULTS } from "../../src/telegram/prefs-store";
import { ATTR_DEFAULT_MODEL, ATTR_MODEL_OPTIONS } from "../../src/lib/attribution";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-prefs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PrefsStore", () => {
  it("starts from sane defaults", () => {
    const p = new PrefsStore(dir);
    expect(p.getDefaults()).toEqual({
      model: "small",
      language: "auto",
      diarizeEnabled: true,
      attrModel: ATTR_DEFAULT_MODEL,
    });
    expect(DEFAULTS.model).toBe("small");
  });

  it("validates admin defaults and persists them to telegram-prefs.json", () => {
    const p = new PrefsStore(dir);
    p.setDefaults({
      model: "gpt-9",
      language: " De ",
      diarizeEnabled: false,
      attrModel: ATTR_MODEL_OPTIONS[2],
    });
    expect(p.getDefaults()).toEqual({
      model: "small",
      language: "de",
      diarizeEnabled: false,
      attrModel: ATTR_MODEL_OPTIONS[2],
    });
    p.setDefaults({ model: "medium", language: "" });
    expect(p.getDefaults().model).toBe("medium");
    expect(p.getDefaults().language).toBe("auto");
    expect(fs.existsSync(path.join(dir, "telegram-prefs.json"))).toBe(true);
    expect(new PrefsStore(dir).getDefaults().model).toBe("medium");
  });

  it("resolves per-user overrides on top of defaults; diarizeEnabled and attrModel stay global", () => {
    const p = new PrefsStore(dir);
    p.setUser(7, { model: "tiny" });
    expect(p.resolve(7)).toEqual({
      model: "tiny",
      language: "auto",
      diarizeEnabled: true,
      attrModel: ATTR_DEFAULT_MODEL,
    });
    expect(p.resolve(8).model).toBe("small");
    p.setUser(7, { language: "fr" });
    expect(p.getUser(7)).toEqual({ model: "tiny", language: "fr" });
    p.setUser(7, { model: "bogus" });
    expect(p.getUser(7).model).toBe("tiny");
    p.clearUser(7);
    expect(p.getUser(7)).toEqual({});
    expect(p.listUsers()).toEqual({});
  });

  it("persists user overrides across instances", () => {
    new PrefsStore(dir).setUser(9, { model: "base" });
    expect(new PrefsStore(dir).resolve(9).model).toBe("base");
  });
});
