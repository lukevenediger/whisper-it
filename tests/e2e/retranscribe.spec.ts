import { test, expect } from "@playwright/test";
import { clearHistory, uploadAudio, waitForFirstHistory } from "./helpers";

test.describe.configure({ retries: 2 });

test("re-transcribe adds a new history entry without re-upload", async ({ page }) => {
  await clearHistory(page);
  await page.goto("/");

  await page.locator("#model").selectOption("tiny");
  await page.locator("#language").selectOption("en");

  await uploadAudio(page, "short.wav");
  await waitForFirstHistory(page);
  await expect(page.locator(".history-list .history-item")).toHaveCount(1, { timeout: 120_000 });

  const panel = page.locator("#retranscribe");
  await expect(panel).toBeVisible();
  await page.locator("#retranscribeBtn").click();
  await expect(page.locator(".history-list .history-item")).toHaveCount(2, { timeout: 120_000 });
});
