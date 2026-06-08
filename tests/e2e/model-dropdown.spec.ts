import { test, expect } from "@playwright/test";
import { clearHistory } from "./helpers";

// Value-only assertions: no transcription, so CI never triggers the ~670 MB
// Parakeet download. Real Parakeet transcription is covered by the opt-in
// integration test (PARAKEET_LIVE=1).
test.describe("model dropdown", () => {
  test("defaults to small", async ({ page }) => {
    await clearHistory(page);
    await page.goto("/");
    await expect(page.locator("#model")).toHaveValue("small");
  });

  test("offers all Whisper models plus Parakeet", async ({ page }) => {
    await page.goto("/");
    const values = await page
      .locator("#model option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(["tiny", "base", "small", "medium", "large-v3", "parakeet-v3"]);
  });

  test("remembers the selected model across reloads", async ({ page }) => {
    await page.goto("/");
    await page.locator("#model").selectOption("parakeet-v3");
    await page.reload();
    await expect(page.locator("#model")).toHaveValue("parakeet-v3");
  });
});
