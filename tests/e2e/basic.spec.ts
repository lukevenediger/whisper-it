import { test, expect } from "@playwright/test";
import {
  clearHistory,
  uploadAudio,
  waitForFirstHistory,
  expectTranscriptContains,
} from "./helpers";

test.describe.configure({ retries: 2 });

test("upload short.wav transcribes with default model", async ({ page }) => {
  await clearHistory(page);
  await page.goto("/");

  // Pick tiny for speed
  await page.locator("#model").selectOption("tiny");
  await page.locator("#language").selectOption("en");

  await uploadAudio(page, "short.wav");
  await waitForFirstHistory(page);
  await expectTranscriptContains(page, "fox|jump");
});

test("page loads with no transcription history", async ({ page }) => {
  await clearHistory(page);
  await page.goto("/");
  await expect(page.locator("h1")).toContainText(/whisper it/i);
  await expect(page.locator(".history-list .history-item")).toHaveCount(0);
});

test("version endpoint returns expected fields", async ({ request }) => {
  const res = await request.get("/api/version");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body).toMatchObject({
    commit: expect.any(String),
    hasServerKey: expect.any(Boolean),
    hasDebugFixtures: expect.any(Boolean),
  });
});
