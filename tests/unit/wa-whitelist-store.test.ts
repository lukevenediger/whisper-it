import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { WhitelistStore, normalizeNumber, jidToNumber } from "../../src/whatsapp/whitelist-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-wl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeNumber / jidToNumber", () => {
  it("strips non-digits", () => {
    expect(normalizeNumber("+27 82 123 4567")).toBe("27821234567");
    expect(normalizeNumber("(27) 82-123-4567")).toBe("27821234567");
  });
  it("extracts the number from a chat JID", () => {
    expect(jidToNumber("27821234567@c.us")).toBe("27821234567");
  });
});

describe("WhitelistStore", () => {
  it("denies everyone when the list is empty (deny-by-default)", () => {
    const wl = new WhitelistStore(dir);
    expect(wl.isAllowed("27821234567@c.us")).toBe(false);
  });

  it("allows a number after it is added (normalized match)", () => {
    const wl = new WhitelistStore(dir);
    wl.add("+27 82 123 4567");
    expect(wl.isAllowed("27821234567@c.us")).toBe(true);
    expect(wl.list()).toEqual(["27821234567"]);
  });

  it("dedupes and removes", () => {
    const wl = new WhitelistStore(dir);
    wl.add("27821234567");
    wl.add("+27821234567");
    expect(wl.list()).toEqual(["27821234567"]);
    wl.remove("27821234567");
    expect(wl.list()).toEqual([]);
    expect(wl.isAllowed("27821234567@c.us")).toBe(false);
  });

  it("persists across instances", () => {
    new WhitelistStore(dir).add("27821234567");
    const wl2 = new WhitelistStore(dir);
    expect(wl2.isAllowed("27821234567@c.us")).toBe(true);
  });

  it("ignores group JIDs", () => {
    const wl = new WhitelistStore(dir);
    wl.add("27821234567");
    expect(wl.isAllowed("1234567890-123456@g.us")).toBe(false);
  });
});
