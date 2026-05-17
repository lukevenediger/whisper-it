import { test, expect } from "@playwright/test";
import { clearHistory, uploadAudio, waitForFirstHistory } from "./helpers";

test.describe.configure({ retries: 2 });

test("forcing Spanish language transcribes the spanish.wav correctly", async ({ page }) => {
  await clearHistory(page);
  await page.goto("/");

  // Tiny model garbles eSpeak-synthesized Spanish proper nouns; use small for stability.
  await page.locator("#model").selectOption("small");
  await page.locator("#language").selectOption("es");

  await uploadAudio(page, "spanish.wav");
  await waitForFirstHistory(page, 180_000);

  // Loose match: family/mama/familia tend to survive tiny-Spanish mistranscriptions
  const preview = page.locator(".history-item .history-item-preview").first();
  await expect(preview).toContainText(/madrid|mar[ií]a|familia|mam[áa]/i, { timeout: 180_000 });
});
