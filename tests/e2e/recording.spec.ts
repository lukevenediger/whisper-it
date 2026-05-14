import { test, expect } from "@playwright/test";
import { clearHistory, waitForFirstHistory } from "./helpers";

test.describe.configure({ retries: 2 });

// Note: only runs under the chromium-fake-audio project where launchOptions feed
// short.wav into getUserMedia via --use-file-for-fake-audio-capture.

test("recording captures fake audio and produces a transcript", async ({ page, context }) => {
  await context.grantPermissions(["microphone"], { origin: "http://localhost:4000" });
  await clearHistory(page);
  await page.goto("/");

  await page.locator("#model").selectOption("tiny");
  await page.locator("#language").selectOption("en");

  const recordBtn = page.locator("#recordBtn");
  await recordBtn.click();
  // Record ~4s of fake audio
  await page.waitForTimeout(4000);
  await recordBtn.click();

  // Wait for transcription to complete and appear in history
  const item = await waitForFirstHistory(page, 180_000);
  const preview = item.locator(".history-item-preview");
  await expect(preview).toContainText(/fox|jump/i, { timeout: 180_000 });
});
