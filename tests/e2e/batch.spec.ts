import { test, expect } from "@playwright/test";
import path from "path";
import { clearHistory, FIXTURES } from "./helpers";

test.describe.configure({ retries: 2 });

test("uploading two files queues and transcribes both", async ({ page }) => {
  await clearHistory(page);
  await page.goto("/");

  await page.locator("#model").selectOption("tiny");
  await page.locator("#language").selectOption("en");

  await page
    .locator("#fileInput")
    .setInputFiles([path.join(FIXTURES, "short.wav"), path.join(FIXTURES, "silence-padded.wav")]);

  // Both items end up in history
  await expect(page.locator(".history-list .history-item")).toHaveCount(2, { timeout: 180_000 });

  // Batch badge should be visible on at least one
  const badges = page.locator(".batch-badge");
  await expect(badges.first()).toBeVisible();
});
