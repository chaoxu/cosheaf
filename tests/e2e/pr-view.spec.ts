import { expect, test } from "@playwright/test";
import { loginAs, openReview } from "./helpers";

// One serial flow: walking the PR review surface as vera, then as meri
// (author, restricted), verifying every visible affordance.
test.describe.serial("PR review surface", () => {
  test("vera walks the review surface end-to-end", async ({ page }) => {
    await loginAs(page, "vera");
    await openReview(page);

    await expect(page.locator('[data-testid="comment-thread"]')).not.toHaveCount(0);

    for (const id of ["unified", "split", "rendered"] as const) {
      await page.getByTestId(`spike-${id}`).click();
      await expect(page.getByTestId(`spike-${id}-pane`)).toBeVisible({ timeout: 5000 });
      if (id === "split") {
        await expect(page.locator('[data-testid="spike-split-pane"] .cm-content').first()).toBeVisible({
          timeout: 8000,
        });
        await expect(page.locator('[data-testid="spike-split-pane"] >> text=Loading')).toHaveCount(0);
      } else if (id === "rendered") {
        await expect(page.locator('[data-testid="spike-rendered-pane"] .cm-content').first()).toBeVisible({
          timeout: 8000,
        });
      }
    }

    // Back to unified for composer tests.
    await page.getByTestId("spike-unified").click();
    await expect(page.getByTestId("spike-unified-pane")).toBeVisible();

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
    await expect(page.getByTestId("spike-unified-pane")).toBeVisible();

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
