import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  fmtDuration,
  footer,
  transcriptReply,
  attributedReply,
  pdfCaption,
  progressText,
  pdfFilename,
  NOT_AUTHORISED,
  TG_TEXT_MAX,
  TG_CAPTION_MAX,
} from "../../src/telegram/format";
import type { TranscriptState } from "../../src/telegram/types";

const state = (text: string, extra: Partial<TranscriptState> = {}): TranscriptState => ({
  chatId: 1,
  userId: 1,
  userMessageId: 1,
  audio: { kind: "voice", fileId: "F" },
  requestedModel: "small",
  model: "small",
  language: "auto",
  detectedLanguage: "en",
  duration: 83,
  text,
  segments: [],
  attrModel: "deepseek/deepseek-v4-flash",
  ...extra,
});

describe("format", () => {
  it("escapeHtml touches only & < >", () => {
    expect(escapeHtml(`a & b <c> "d" 'e'`)).toBe(`a &amp; b &lt;c&gt; "d" 'e'`);
  });

  it("fmtDuration renders seconds and minutes", () => {
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(187)).toBe("3m 7s");
  });

  it("footer is italic meta with an optional fallback note", () => {
    expect(footer({ language: "en", model: "small", duration: 83 })).toBe(
      "<i>en · small · 1m 23s</i>",
    );
    expect(
      footer({
        language: "ja",
        model: "small",
        duration: 5,
        fallback: { from: "parakeet-v3", to: "small", reason: "x" },
      }),
    ).toBe("<i>ja · small · 5s · fell back from parakeet-v3</i>");
  });

  it("transcriptReply escapes the text and decides text vs PDF by rendered length", () => {
    const short = transcriptReply(state("hello <world>"), { cutoff: 100 });
    expect(short.fitsText).toBe(true);
    expect(short.html).toBe("hello &lt;world&gt;\n\n<i>en · small · 1m 23s</i>");
    expect(transcriptReply(state("x".repeat(101)), { cutoff: 100 }).fitsText).toBe(false);
    expect(transcriptReply(state("x".repeat(5000))).fitsText).toBe(false); // hard cap
    expect(transcriptReply(state("   ")).html).toContain("(no speech detected)");
  });

  it("attributedReply bolds speakers, merges runs, marks ambiguous, and appends notes", () => {
    const r = attributedReply(
      {
        merged: [
          { speaker: "Alice", text: "Hi" },
          { speaker: "Alice", text: "there" },
          { speaker: "Bob", text: "Yo <b>" },
          { speaker: "Alice", text: "?" },
        ],
        speakers: ["Alice", "Bob"],
        ambiguous: [3],
        notes: "Guessed 2 speakers",
        model: "m",
      },
      { language: "en", model: "small", duration: 10 },
      { cutoff: 1000 },
    );
    expect(r.html).toBe(
      "<b>Alice</b>: Hi there\n<b>Bob</b>: Yo &lt;b&gt;\n<b>Alice</b> ⚠️: ?\n\n<i>Guessed 2 speakers</i>\n\n<i>en · small · 10s</i>",
    );
    expect(r.plain).toBe("Alice: Hi there\nBob: Yo <b>\nAlice ⚠️: ?");
    expect(r.fitsText).toBe(true);
  });

  it("pdfCaption stays within the caption limit even with heavy escaping", () => {
    const cap = pdfCaption("&".repeat(2000), "<i>meta</i>");
    expect(cap.length).toBeLessThanOrEqual(TG_CAPTION_MAX);
    expect(cap.endsWith("<i>meta</i>")).toBe(true);
    expect(cap).toContain("…");
    expect(TG_TEXT_MAX).toBe(4096);
  });

  it("progressText maps transcription events to short status lines", () => {
    expect(progressText({ status: "loading_model" }, "small")).toBe("⏳ Loading small…");
    expect(progressText({ status: "downloading", progress: 42 }, "small")).toBe(
      "⬇️ Downloading small… 42%",
    );
    expect(progressText({ status: "transcribing", chunk: 2, total: 7 }, "small")).toBe(
      "🎙 Transcribing (small)… chunk 2/7",
    );
    expect(progressText({ status: "transcribing" }, "small")).toBe("🎙 Transcribing (small)…");
    expect(progressText({ status: "chunking", duration: 100 }, "small")).toBe(
      "✂️ Splitting long audio…",
    );
    expect(progressText({ status: "weird" }, "small")).toBeNull();
  });

  it("pdfFilename derives from the source file name or a Recording stamp", () => {
    const d = new Date(2026, 8, 15, 14, 3, 9);
    expect(
      pdfFilename(
        state("x", { audio: { kind: "audio", fileId: "F", fileName: "Team call.mp3" } }),
        { now: d },
      ),
    ).toBe("Team call.pdf");
    expect(pdfFilename(state("x"), { now: d })).toBe("Recording 2026-09-15 14-03-09.pdf");
    expect(pdfFilename(state("x"), { now: d, speakers: true })).toBe(
      "Recording 2026-09-15 14-03-09 - speakers.pdf",
    );
  });

  it("NOT_AUTHORISED includes the id in a code span", () => {
    expect(NOT_AUTHORISED(123)).toContain("<code>123</code>");
  });
});
