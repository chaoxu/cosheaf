import { expect, test } from "@playwright/test";
import { loginAs, openReview } from "./helpers";

// One serial flow: walking the PR review surface as vera, then as meri
// (author, restricted), verifying every visible affordance.
test.describe.serial("PR review surface", () => {
  test("vera walks the review surface end-to-end", async ({ page }) => {
    await loginAs(page, "vera");
    await openReview(page);

    await expect(page.locator('[data-testid="comment-thread"]')).not.toHaveCount(0);

    // Walk the five reachable (mode, shape) combinations.
    const combos: Array<{ mode: "source" | "rich"; shape: "unified" | "split" | "after"; testId: string }> = [
      { mode: "source", shape: "unified", testId: "diff-pane-unified" },
      { mode: "source", shape: "split", testId: "diff-pane-split" },
      { mode: "source", shape: "after", testId: "diff-pane-after" },
      { mode: "rich", shape: "split", testId: "diff-pane-split" },
      { mode: "rich", shape: "after", testId: "diff-pane-after" },
    ];
    for (const { mode, shape, testId } of combos) {
      await page.getByTestId(`view-mode-${mode}`).click();
      await page.getByTestId(`view-shape-${shape}`).click();
      await expect(page.getByTestId(testId)).toBeVisible({ timeout: 5000 });
      if (shape !== "unified") {
        // Source mode → react-diff-view (.diff table); Rich mode → reader
        // HTML wrapped in `.cf-rich-diff` with `[data-source-line]` per block.
        const contentSelector =
          mode === "source"
            ? `[data-testid="${testId}"] .diff`
            : `[data-testid="${testId}"] .cf-rich-diff`;
        await expect(page.locator(contentSelector).first()).toBeVisible({ timeout: 8000 });
      }
    }
    // Rich + Unified should be disabled.
    await page.getByTestId("view-mode-rich").click();
    await expect(page.getByTestId("view-shape-unified")).toBeDisabled();

    // Back to Source + Unified for composer tests.
    await page.getByTestId("view-mode-source").click();
    await page.getByTestId("view-shape-unified").click();
    await expect(page.getByTestId("diff-pane-unified")).toBeVisible();

    // Add a single-shot comment.
    await page.locator('[data-testid^="comment-add-new-"]').first().click({ force: true });
    const composer = page.getByTestId("inline-composer");
    await expect(composer).toBeVisible();
    await composer.locator("textarea").fill("single-shot from e2e");
    await composer.locator('button:has-text("Add comment")').click();
    await expect(composer).toBeHidden({ timeout: 5000 });

    // Edit own.
    await page.waitForTimeout(800);
    const editButtons = page.locator('[data-testid^="comment-edit-"]');
    expect(await editButtons.count()).toBeGreaterThan(0);
    await editButtons.first().click();
    const cid = (await editButtons.first().getAttribute("data-testid"))?.split("-").pop();
    expect(cid).toBeTruthy();
    const textarea = page.getByTestId(`comment-edit-body-${cid}`);
    await expect(textarea).toBeVisible();
    await textarea.fill("edited from e2e");
    await page.getByTestId(`comment-edit-save-${cid}`).click();
    await expect(textarea).toBeHidden({ timeout: 5000 });

    // Delete via inline confirm.
    const deleteButtons = page.locator(
      '[data-testid^="comment-delete-"]:not([data-testid*="confirm"])',
    );
    const beforeDelete = await deleteButtons.count();
    expect(beforeDelete).toBeGreaterThan(0);
    await deleteButtons.first().click();
    await page.locator('[data-testid^="comment-delete-confirm-"]').first().click();
    await expect
      .poll(
        async () =>
          (await page
            .locator('[data-testid^="comment-delete-"]:not([data-testid*="confirm"])')
            .count()) < beforeDelete,
        { timeout: 8000 },
      )
      .toBe(true);

    // Draft-review batched flow.
    await page.getByTestId("review-toggle-draft").click();
    await expect(
      page.locator('[data-testid="review-toggle-draft"]:has-text("Draft active")'),
    ).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid^="comment-add-new-"]').first().click({ force: true });
    await composer.locator("textarea").fill("batched 1");
    await composer.locator('button:has-text("Add comment")').click();
    await expect(composer).toBeHidden({ timeout: 5000 });
    await page.locator('[data-testid="review-comment"]').fill("submitting batch as comment-only");
    await page.getByTestId("review-comment-submit").click();
    await expect(
      page.locator('[data-testid="review-toggle-draft"]:has-text("Start a review")'),
    ).toBeVisible({ timeout: 5000 });

    // Switch files.
    const files = page.locator('[data-testid^="pr-file-"]');
    expect(await files.count()).toBeGreaterThanOrEqual(2);
    await files.nth(1).click();
    await expect(page.getByTestId("diff-pane-unified")).toBeVisible();

    // Exit + re-enter.
    await page.getByTestId("review-exit").click();
    await expect(page.getByTestId("pr-header")).toHaveCount(0);
    await openReview(page);

    // Plain comment submit.
    await page.locator('[data-testid="review-comment"]').fill("plain comment, no batch");
    await page.getByTestId("review-comment-submit").click();
  });

  test("meri (author) is gated from reviewing her own change", async ({ page }) => {
    await loginAs(page, "meri");
    await openReview(page);

    await expect(page.getByTestId("review-approve")).toBeDisabled();
    await expect(page.getByTestId("review-comment")).toBeDisabled();
    await expect(page.locator('[data-testid^="comment-add-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="comment-edit-"]')).toHaveCount(0);
  });
});
