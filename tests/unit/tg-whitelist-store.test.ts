import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { TelegramWhitelistStore, normalizeTelegramId } from "../../src/telegram/whitelist-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-wl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeTelegramId", () => {
  it("accepts positive integers in any reasonable form and rejects the rest", () => {
    expect(normalizeTelegramId(123)).toBe(123);
    expect(normalizeTelegramId(" 456 ")).toBe(456);
    expect(normalizeTelegramId("0")).toBeNull();
    expect(normalizeTelegramId("-5")).toBeNull();
    expect(normalizeTelegramId("12a")).toBeNull();
    expect(normalizeTelegramId("")).toBeNull();
    expect(normalizeTelegramId(null)).toBeNull();
    expect(normalizeTelegramId(1.5)).toBeNull();
  });
});

describe("TelegramWhitelistStore", () => {
  it("denies everyone by default", () => {
    const s = new TelegramWhitelistStore(dir);
    expect(s.list()).toEqual([]);
    expect(s.isAllowed(42)).toBe(false);
  });

  it("adds, removes, and persists numeric ids to telegram-whitelist.json", () => {
    const a = new TelegramWhitelistStore(dir);
    a.add("42");
    a.add(42);
    a.add("junk");
    expect(a.list()).toEqual([42]);
    expect(a.isAllowed(42)).toBe(true);
    expect(fs.existsSync(path.join(dir, "telegram-whitelist.json"))).toBe(true);
    const b = new TelegramWhitelistStore(dir);
    expect(b.isAllowed(42)).toBe(true);
    b.remove("42");
    expect(b.isAllowed(42)).toBe(false);
  });

  it("replace() swaps the whole list and drops junk", () => {
    const s = new TelegramWhitelistStore(dir);
    expect(s.replace([1, "2", "x", -3, 2])).toEqual([1, 2]);
  });
});
