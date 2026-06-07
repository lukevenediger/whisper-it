import { test, expect } from "@playwright/test";
import { clearHistory } from "./helpers";

// Value-only assertions: no transcription, so CI never triggers the ~670 MB
// Parakeet download. Real Parakeet transcription is covered by the opt-in
// integration test (PARAKEET_LIVE=1).
test.describe("model dropdown", () => {
  test("defaults to parakeet-v3", async ({ page }) => {
    await clearHistory(page);
    await page.goto("/");
    await expect(page.locator("#model")).toHaveValue("parakeet-v3");
  });

  test("offers Parakeet and all Whisper models", async ({ page }) => {
    await page.goto("/");
    const values = await page
      .locator("#model option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(["parakeet-v3", "tiny", "base", "small", "medium", "large-v3"]);
  });

  test("remembers the selected model across reloads", async ({ page }) => {
    await page.goto("/");
    await page.locator("#model").selectOption("small");
    await page.reload();
    await expect(page.locator("#model")).toHaveValue("small");
  });
});
