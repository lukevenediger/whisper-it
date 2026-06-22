import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SettingsStore } from "../../src/whatsapp/settings-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-set-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("defaults to small / auto / diarize enabled", () => {
    const s = new SettingsStore(dir).get();
    expect(s.model).toBe("small");
    expect(s.language).toBe("auto");
    expect(s.diarizeEnabled).toBe(true);
  });

  it("merges partial updates and clamps unknown models", () => {
    const store = new SettingsStore(dir);
    store.set({ model: "large-v3", language: "es" });
    expect(store.get()).toMatchObject({ model: "large-v3", language: "es", diarizeEnabled: true });
    store.set({ model: "bogus" });
    expect(store.get().model).toBe("small"); // invalid model falls back to default
  });

  it("persists across instances", () => {
    new SettingsStore(dir).set({ diarizeEnabled: false });
    expect(new SettingsStore(dir).get().diarizeEnabled).toBe(false);
  });
});
