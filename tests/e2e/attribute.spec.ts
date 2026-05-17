import { test, expect } from "@playwright/test";
import { seedHistory, makeHistoryItem } from "./helpers";

test.describe.configure({ retries: 1 });

// Cloud attribution — modal-driven on the main page, hits real OpenRouter.
// CI sets OPENROUTER_API_KEY as a secret. Skipped when no key configured.

test("attribute modal labels a seeded transcript via real OpenRouter", async ({
  page,
  request,
}) => {
  const version = await (await request.get("/api/version")).json();
  test.skip(!version.hasServerKey, "server has no OPENROUTER_API_KEY configured");

  const item = makeHistoryItem({
    title: "Two speakers",
    segments: [
      { start: 0, end: 2, text: "Hi everyone, my name is Alice and I run product marketing." },
      { start: 2, end: 4, text: "Hi Alice, nice to meet you. I am Bob, engineering lead." },
      { start: 4, end: 6, text: "So Bob, what brings you to product reviews?" },
      { start: 6, end: 8, text: "Mostly the cross-team alignment, Alice." },
    ],
  });
  await seedHistory(page, [item]);
  await page.goto("/");

  // Click Attribute on the history item — opens modal
  await page
    .locator(".history-item-actions")
    .first()
    .getByRole("button", { name: /attribute/i })
    .click();
  await expect(page.locator("#attrModal")).toBeVisible();

  // Fill speaker rows
  const rows = page.locator("#attrSpeakerRows .speaker-row");
  await rows.nth(0).locator("input").first().fill("Alice");
  await rows.nth(0).locator("input").nth(1).fill("product marketing manager");

  await page.locator("#attrAddSpeakerBtn").click();
  await rows.nth(1).locator("input").first().fill("Bob");
  await rows.nth(1).locator("input").nth(1).fill("engineering lead");

  // Default model is fine; explicitly select to be safe.
  await page.locator("#attrModelInput").selectOption("deepseek/deepseek-v4-flash");

  await page.locator("#attrSubmitBtn").click();

  await expect(page.locator("#attrResultBlock")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#attrResultPreview")).toContainText(/alice|bob/i);

  // Save the attributed result
  await page.locator("#attrSaveBtn").click();

  // Modal closes, new entry appears at top of history
  await expect(page.locator("#attrModal")).toBeHidden();
  const titles = page.locator(".history-item-title");
  await expect(titles.first()).toContainText(/attributed/i);
});

test("attribute modal opens with empty roster + closes on Escape", async ({ page, request }) => {
  const version = await (await request.get("/api/version")).json();
  test.skip(!version.hasServerKey, "server has no OPENROUTER_API_KEY configured");

  const item = makeHistoryItem({
    title: "Quick check",
    segments: [{ start: 0, end: 1, text: "hi" }],
  });
  await seedHistory(page, [item]);
  await page.goto("/");

  await page
    .locator(".history-item-actions")
    .first()
    .getByRole("button", { name: /attribute/i })
    .click();
  await expect(page.locator("#attrModal")).toBeVisible();

  // Escape closes
  await page.keyboard.press("Escape");
  await expect(page.locator("#attrModal")).toBeHidden();
});
