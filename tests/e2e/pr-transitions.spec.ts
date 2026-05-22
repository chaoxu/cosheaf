import { expect, test } from "@playwright/test";
import { authedApiFetch, authedApiJson, createPrAsMeri, loginAs } from "./helpers";

// PR review state lives in the backing forge. Each transition consumes a PR,
// so we open a fresh one per test and assert the post-transition state via the
// typed Cosheaf API instead of poking SQLite.
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
    // review. Verify the approval landed via the typed API.
    await expect
      .poll(
        async () => {
          const reviews = await authedApiJson<{ approvals: number }>(
            page,
            `/api/v1/w/flushing-coin/pulls/${prNumber}/reviews`,
          );
          return reviews.approvals;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);

    // Admin (chao) merges the now-approved PR.
    await loginAs(page, "chao");
    const merged = await authedApiFetch(page, `/api/v1/w/flushing-coin/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: "squash" }),
    }).then((result) => result.status);
    expect(merged).toBe(200);
    const { pull: state } = await authedApiJson<{ pull: { state: string; merged: boolean } }>(
      page,
      `/api/v1/w/flushing-coin/pulls/${prNumber}`,
    );
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
        async () => {
          const reviews = await authedApiJson<{ rejections: number }>(
            page,
            `/api/v1/w/flushing-coin/pulls/${prNumber}/reviews`,
          );
          return reviews.rejections;
        },
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
