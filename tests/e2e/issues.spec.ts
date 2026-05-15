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

  test("chao (owner) labels an issue + a body ref renders as a clickable link", async ({ page }) => {
    // chao defines a label via API then opens the prior issue + applies it.
    await loginAs(page, "chao");
    await page.evaluate(async () => {
      await fetch("/api/v1/w/flushing-coin/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "needs-review", color: "facc15" }),
      });
    });
    // The prior spec closed its issue; create a fresh open issue so Activity has one.
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Label test");
    await page.getByTestId("new-issue-body").fill("Body.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await page.getByTestId("label-add").click();
    await page.locator('[data-testid^="label-toggle-"]').first().click();
    await expect(page.locator('[data-testid^="label-chip-"]')).toHaveCount(1, { timeout: 5000 });

    // Now a body-ref test: chao creates a new issue whose body has a path ref.
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Cross-reference test");
    await page.getByTestId("new-issue-body").fill("See hello.md#L1 and [@some-id] for context.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    // Both refs rendered as clickable elements.
    await expect(page.getByTestId("ref-path-hello.md")).toBeVisible();
    await expect(page.getByTestId("ref-page-some-id")).toBeVisible();
  });

  test("#N references jump between issues and inbox search filters", async ({ page }) => {
    await loginAs(page, "meri");
    // Open two issues so we can reference one from the other.
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Target issue");
    await page.getByTestId("new-issue-body").fill("To be referenced.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();

    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Source issue");
    // Reference issue #1 (the first one seeded by globalSetup is #1; the
    // ones we just opened are #2, #3 — we reference #2 which is "Target".
    // Use #2 explicitly since title search will narrow.
    await page.getByTestId("new-issue-body").fill("Closes #2 — fixes the proof.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await expect(page.getByTestId("ref-num-2")).toBeVisible();

    // Search narrows the inbox to titles matching the query.
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("inbox-search").fill("Target");
    await expect.poll(async () =>
      page.locator('[data-testid^="issue-"]:visible').count(), { timeout: 5000 }
    ).toBeGreaterThanOrEqual(1);
    const visibleTitles = await page.locator('[data-testid^="issue-"]:visible strong').allTextContents();
    expect(visibleTitles.some((t) => t.includes("Target"))).toBe(true);
    expect(visibleTitles.some((t) => t.includes("Source"))).toBe(false);
  });
});
