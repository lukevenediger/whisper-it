import { test, expect } from "@playwright/test";
import { clearHistory, uploadAudio, waitForFirstHistory } from "./helpers";

// Only meaningful when the server has WHISPER_DIARIZE=1 + HF_TOKEN.
// CI nightly workflow sets these. Locally, also set them before `make run`.

test.describe.configure({ retries: 1 });

test("on-device diarization labels multispeaker audio with >= 2 speakers", async ({
  page,
  request,
}) => {
  const version = await (await request.get("/api/version")).json();
  test.skip(!version.hasDiarize, "server has WHISPER_DIARIZE=0; skipping diarization E2E");

  await clearHistory(page);
  await page.goto("/");

  await page.locator("#model").selectOption("tiny");
  await page.locator("#language").selectOption("en");

  // Enable diarize toggle
  await page.locator("#diarizeCheckbox").check();

  await uploadAudio(page, "multispeaker.wav");

  // Diarization is slow; allow up to 3 minutes
  await waitForFirstHistory(page, 180_000);

  // Speaker chips must appear
  const chips = page.locator(".speaker-tag");
  await expect(chips.first()).toBeVisible({ timeout: 180_000 });

  // Distinct speakers >= 2
  const seen = new Set<string>();
  const count = await chips.count();
  for (let i = 0; i < count; i++) {
    seen.add(((await chips.nth(i).textContent()) || "").trim());
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
});
