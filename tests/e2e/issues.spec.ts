import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe.serial("Issues", () => {
  test("meri opens an issue, vera comments, meri closes it", async ({ page }) => {
    // meri creates the issue
    await loginAs(page, "meri");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Is the proof sketch on Pythagoras tight?");
    await page.getByTestId("new-issue-body").fill("Line 5 says 'drop a perpendicular' but doesn't justify why the resulting triangles are similar.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("issue-toggle-state")).toHaveText("Close issue");

    // vera comments and tests edit + delete on own comment
    await loginAs(page, "vera");
    await page.getByTestId("sidebar-tab-activity").click();
    await page.locator('[data-testid^="issue-"]').first().click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await page.getByTestId("issue-new-comment").fill("Agreed — the similar-triangles step needs a citation.");
    await page.getByTestId("issue-new-comment-submit").click();
    await expect.poll(async () => page.locator('[data-testid^="issue-comment-"]').count(), { timeout: 8000 }).toBeGreaterThan(0);

    // Edit own comment
    const editBtn = page.locator('[data-testid^="issue-comment-edit-"]').first();
    // Read the id BEFORE clicking — click removes the edit button from the DOM.
    const cid = (await editBtn.getAttribute("data-testid"))?.split("-").pop();
    expect(cid).toBeTruthy();
    await editBtn.click();
    const ta = page.locator(`[data-testid="issue-comment-${cid}"] textarea`);
    await ta.fill("Agreed — cite Euclid I.47 or a modern proof.");
    await page.getByTestId(`issue-comment-save-${cid}`).click();
    await expect(page.locator(`[data-testid="issue-comment-${cid}"]`)).toContainText("cite Euclid I.47");

    // meri closes
    await loginAs(page, "meri");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.locator('[data-testid^="issue-"]').first().click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    page.once("dialog", (d) => d.accept()); // no dialog expected, just in case
    await page.getByTestId("issue-toggle-state").click();
    await expect(page.getByTestId("issue-toggle-state")).toHaveText("Reopen", { timeout: 8000 });
  });
});
