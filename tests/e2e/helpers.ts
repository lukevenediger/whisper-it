import { Page, expect } from "@playwright/test";
import path from "path";

export const FIXTURES = path.resolve("tests/fixtures/audio");

export async function clearHistory(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {}
  });
}

export async function uploadAudio(page: Page, filename: string) {
  const file = path.join(FIXTURES, filename);
  const input = page.locator("#fileInput");
  await input.setInputFiles(file);
}

export async function waitForFirstHistory(page: Page, timeoutMs = 120_000) {
  const first = page.locator(".history-item").first();
  await first.waitFor({ state: "visible", timeout: timeoutMs });
  return first;
}

export async function expectTranscriptContains(page: Page, substr: string) {
  const preview = page.locator(".history-item .history-item-preview").first();
  await expect(preview).toContainText(new RegExp(substr, "i"), { timeout: 120_000 });
}

export async function seedHistory(page: Page, items: any[]) {
  // Persist via a one-time visit to the origin, then write directly to localStorage.
  // addInitScript would re-seed on every navigation and clobber newly-saved entries.
  await page.goto("/");
  await page.evaluate((payload) => {
    localStorage.setItem("whisper-it-history", JSON.stringify(payload));
  }, items);
}

export function makeHistoryItem(over: any = {}) {
  return {
    id: over.id || "fixture-" + Math.random().toString(36).slice(2, 8),
    createdAt: Date.now(),
    text: "Hi everyone my name is Alice. Hi Alice nice to meet you I am Bob.",
    language: "en",
    duration: 8,
    model: "small",
    words: 14,
    segments: [
      { start: 0, end: 4, text: "Hi everyone my name is Alice." },
      { start: 4, end: 8, text: "Hi Alice nice to meet you I am Bob." },
    ],
    title: "Test transcript",
    sourceFilename: "test.wav",
    isRecording: false,
    batchId: null,
    batchIndex: null,
    batchSize: null,
    ...over,
  };
}
