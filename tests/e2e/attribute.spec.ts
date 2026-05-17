import { test, expect } from "@playwright/test";
import { seedHistory, makeHistoryItem } from "./helpers";

test.describe.configure({ retries: 1 });

// Cloud attribution — hits real OpenRouter. CI sets OPENROUTER_API_KEY as a secret.
// If the server has no key configured, this test is a no-op.

test("attribute screen labels a seeded transcript via real OpenRouter", async ({
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
  await page.goto(`/attribute.html?id=${item.id}`);

  // Fill speaker rows
  const rows = page.locator(".speaker-row");
  await rows.nth(0).locator("input").first().fill("Alice");
  await rows.nth(0).locator("input").nth(1).fill("product marketing manager");

  // Add second speaker
  await page.locator("#addSpeakerBtn").click();
  await rows.nth(1).locator("input").first().fill("Bob");
  await rows.nth(1).locator("input").nth(1).fill("engineering lead");

  // Tell the model how many speakers to expect
  await page.locator("#speakerCountInput").fill("2");

  // Use server key (already on since hasServerKey is true)
  await page.locator("#keyServer").check();

  // Use cheap model
  await page.locator("#modelInput").fill("anthropic/claude-haiku-4-5");

  await page.locator("#submitBtn").click();

  // Wait for result block to appear
  await expect(page.locator("#resultBlock")).toBeVisible({ timeout: 90_000 });
  // Result preview should contain at least one of the names
  await expect(page.locator("#resultPreview")).toContainText(/alice|bob/i);

  // Save as new history entry
  await page.locator("#saveBtn").click();
  await page.waitForURL("**/");

  const titles = page.locator(".history-item-title");
  await expect(titles.first()).toContainText(/attributed/i);
});
