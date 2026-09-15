import { describe, it, expect } from "vitest";
import fs from "fs";
import { buildTranscriptPdf, resolveFont, DEJAVU_PATHS } from "../../src/telegram/pdf";

const meta = {
  model: "small",
  language: "en",
  duration: 83,
  date: new Date(2026, 8, 15, 14, 3, 9),
};

describe("buildTranscriptPdf", () => {
  it("produces a PDF buffer from a plain transcript with the builtin font", async () => {
    const buf = await buildTranscriptPdf(
      { title: "Team call", body: "hello world", meta },
      { fontPath: null },
    );
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(500);
  });

  it("paginates long bodies", async () => {
    const long = Array.from(
      { length: 400 },
      (_, i) => `Line ${i} lorem ipsum dolor sit amet consectetur.`,
    ).join(" ");
    const buf = await buildTranscriptPdf({ title: "Long", body: long, meta }, { fontPath: null });
    const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pages).toBeGreaterThan(1);
  });

  it("renders speaker-labelled bodies and survives non-Latin text", async () => {
    const buf = await buildTranscriptPdf(
      {
        title: "Chat",
        body: [
          { speaker: "Alice", text: "Привет — こんにちは" },
          { speaker: "Bob", text: "Hi", ambiguous: true },
          { text: "no speaker line" },
        ],
        meta,
      },
      { fontPath: null },
    );
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("uses a TTF font when one is available", async () => {
    const ttf = DEJAVU_PATHS.find((p) => fs.existsSync(p)) || process.env.TELEGRAM_PDF_FONT;
    if (!ttf || !fs.existsSync(ttf)) return; // no font on this machine; covered in Docker
    const buf = await buildTranscriptPdf({ title: "T", body: "Ünïcödé", meta }, { fontPath: ttf });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("resolveFont falls back to Helvetica when no TTF exists", () => {
    const r = resolveFont({ candidates: ["/nope/none.ttf"] });
    expect(r).toEqual({ builtin: "Helvetica" });
  });
});
