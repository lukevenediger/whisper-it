import { test, expect } from "@playwright/test";
import { seedHistory, makeHistoryItem } from "./helpers";

test("seeded history survives page reload", async ({ page }) => {
  const item = makeHistoryItem({ title: "PersistMe", text: "persist this transcript" });
  await seedHistory(page, [item]);
  await page.goto("/");
  await expect(page.locator(".history-item-title").first()).toContainText("PersistMe");
  await page.reload();
  await expect(page.locator(".history-item-title").first()).toContainText("PersistMe");
});

test("seeded history renders speaker tags when speakers field present", async ({ page }) => {
  const item = makeHistoryItem({
    title: "Diarized",
    speakers: ["A", "B"],
    segments: [
      { start: 0, end: 2, text: "Hi I am Alice", speaker: "A" },
      { start: 2, end: 4, text: "Hi Alice I am Bob", speaker: "B" },
    ],
  });
  await seedHistory(page, [item]);
  await page.goto("/");
  await expect(page.locator(".speaker-tag").first()).toBeVisible();
});
