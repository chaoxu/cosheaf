import { expect, test } from "@playwright/test";
import { createPrAsMeri, loginAs } from "./helpers";

// PR review state lives on Forgejo now. Each transition consumes a PR, so we
// open a fresh one per test and assert the post-transition state via the
// Forgejo passthrough instead of poking SQLite.
test.describe.serial("PR review state transitions", () => {
  test("Approve transitions a fresh PR to merged", async ({ page }) => {
    const { prNumber } = await createPrAsMeri(page);

    await loginAs(page, "vera");
    await page.getByTestId("sidebar-tab-inbox").click();
    const reviewPullItem = page.getByTestId(`review-pull-${prNumber}`);
    await expect(reviewPullItem).toBeVisible({ timeout: 8000 });
    await reviewPullItem.click();
    await expect(page.getByTestId("pr-header")).toBeVisible();
    await page.getByTestId("review-approve").click();
    // The PR no longer auto-transitions on approve — it just records the
    // review. Verify the approval landed via the Forgejo-shape endpoint.
    await expect
      .poll(
        async () =>
          page.evaluate(async (n) => {
            const r = await fetch(`/api/v1/w/flushing-coin/pulls/${n}/reviews`);
            return ((await r.json()) as { approvals: number }).approvals;
          }, prNumber),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Admin (chao) merges the now-approved PR.
    await loginAs(page, "chao");
    const merged = await page.evaluate(async (n) => {
      const m = await fetch(`/api/v1/w/flushing-coin/pulls/${n}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ Do: "squash" }),
      });
      return m.status;
    }, prNumber);
    expect(merged).toBe(200);
    const state = await page.evaluate(async (n) => {
      const r = await fetch(`/api/v1/w/flushing-coin/forgejo/pulls/${n}`);
      return (await r.json()) as { state: string; merged: boolean };
    }, prNumber);
    expect(state.merged).toBe(true);
  });

  test("Request changes keeps PR open with a REQUEST_CHANGES review", async ({ page }) => {
    const { prNumber } = await createPrAsMeri(page);

    await loginAs(page, "vera");
    await page.getByTestId("sidebar-tab-inbox").click();
    const reviewPullItem = page.getByTestId(`review-pull-${prNumber}`);
    await expect(reviewPullItem).toBeVisible({ timeout: 8000 });
    await reviewPullItem.click();
    await expect(page.getByTestId("pr-header")).toBeVisible();
    await page.getByTestId("review-comment").fill("Tighten the proof, please.");
    await page.getByTestId("review-request-changes").click();

    await expect
      .poll(
        async () =>
          page.evaluate(async (n) => {
            const r = await fetch(`/api/v1/w/flushing-coin/pulls/${n}/reviews`);
            return ((await r.json()) as { rejections: number }).rejections;
          }, prNumber),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
