import { expect, test } from "@playwright/test";
import { changeStateInDb, createPrAsMeri, loginAs } from "./helpers";

// Each transition consumes a PR, so we publish a fresh one per test.
test.describe.serial("PR review state transitions", () => {
  test("Approve transitions a fresh PR to merged", async ({ page }) => {
    const { changeId } = await createPrAsMeri(page);

    await loginAs(page, "vera");
    await page.getByTestId("sidebar-tab-inbox").click();
    const queueItem = page.getByTestId(`review-queue-branch-${changeId}`);
    await expect(queueItem).toBeVisible({ timeout: 8000 });
    await queueItem.click();
    await expect(page.getByTestId("pr-header")).toBeVisible();
    await page.getByTestId("review-approve").click();
    await expect(page.getByTestId("pr-header")).toHaveCount(0, { timeout: 15000 });

    await expect.poll(() => changeStateInDb(changeId), { timeout: 5000 }).toBe("merged");
  });

  test("Request changes transitions a fresh PR to changes_requested", async ({ page }) => {
    const { changeId } = await createPrAsMeri(page);

    await loginAs(page, "vera");
    await page.getByTestId("sidebar-tab-inbox").click();
    const queueItem = page.getByTestId(`review-queue-branch-${changeId}`);
    await expect(queueItem).toBeVisible({ timeout: 8000 });
    await queueItem.click();
    await expect(page.getByTestId("pr-header")).toBeVisible();
    await page.getByTestId("review-comment").fill("Tighten the proof, please.");
    await page.getByTestId("review-request-changes").click();
    await expect(page.getByTestId("pr-header")).toHaveCount(0, { timeout: 15000 });

    await expect.poll(() => changeStateInDb(changeId), { timeout: 5000 }).toBe("changes_requested");
  });
});
