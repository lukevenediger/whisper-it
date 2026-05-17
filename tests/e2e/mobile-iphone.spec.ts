import { test, expect } from "@playwright/test";

// Verifies the iOS file-picker fix: tapping the drop zone fires the native
// file-chooser dialog because the markup is <label for="fileInput"> (not a
// JS .click() on a display:none input).

test("tapping the drop zone opens the native file chooser", async ({ page }) => {
  await page.goto("/");
  const dropZone = page.locator("#dropZone");
  await expect(dropZone).toBeVisible();

  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 5_000 });
  await dropZone.tap();
  const chooser = await fileChooserPromise;
  expect(chooser).toBeTruthy();
});

test("page renders cleanly on iPhone width without script crash", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("h1")).toContainText(/whisper it/i);
  // Should not have crashed on `navigator.mediaDevices.addEventListener` even
  // when the API is missing in some webviews.
  expect(errors.filter((e) => /addEventListener/.test(e))).toHaveLength(0);
});
