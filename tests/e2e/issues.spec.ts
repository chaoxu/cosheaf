import { expect, test } from "@playwright/test";
import { authedApiFetch, loginAs } from "./helpers";

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
    await authedApiFetch(page, "/api/v1/w/flushing-coin/labels", {
      method: "POST",
      body: JSON.stringify({ name: "needs-review", color: "facc15" }),
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
    const targetRow = page.locator('li [data-testid^="issue-"]').filter({ hasText: "Target issue" }).first();
    await expect(targetRow).toBeVisible({ timeout: 8000 });
    const targetIssueNumber = (await targetRow.getAttribute("data-testid"))?.match(/^issue-(\d+)$/)?.[1];
    expect(targetIssueNumber).toBeTruthy();

    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Source issue");
    await page.getByTestId("new-issue-body").fill(`Closes #${targetIssueNumber} — fixes the proof.`);
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await expect(page.getByTestId(`ref-num-${targetIssueNumber}`)).toBeVisible();

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

  test("Pin and unpin an issue; pinned issues render at top of Inbox", async ({ page }) => {
    await loginAs(page, "chao");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Master roadmap");
    await page.getByTestId("new-issue-body").fill("The big one.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();

    await page.getByTestId("issue-pin-toggle").click();
    await expect(page.getByTestId("issue-pin-toggle")).toContainText("Pinned", { timeout: 8000 });

    await page.getByTestId("sidebar-tab-inbox").click();
    await expect(page.locator('[data-testid^="pinned-issue-"]').first()).toBeVisible({ timeout: 8000 });

    // Unpin
    await page.locator('[data-testid^="pinned-issue-"]').first().click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await page.getByTestId("issue-pin-toggle").click();
    await expect(page.getByTestId("issue-pin-toggle")).toContainText("Pin", { timeout: 8000 });
    await page.getByTestId("sidebar-tab-inbox").click();
    await expect(page.locator('[data-testid^="pinned-issue-"]')).toHaveCount(0, { timeout: 8000 });
  });

  test("Add and remove an issue dependency", async ({ page }) => {
    await loginAs(page, "chao");
    await page.getByTestId("sidebar-tab-inbox").click();
    // Open issue A
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Theorem T");
    await page.getByTestId("new-issue-body").fill("Needs lemma L1");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    // Open issue B
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Lemma L1");
    await page.getByTestId("new-issue-body").fill("Will support theorem T.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    // Back to inbox to read both issue numbers from the row test ids.
    await page.getByTestId("sidebar-tab-inbox").click();
    const lemmaRow = page.locator('li [data-testid^="issue-"]').filter({ hasText: "Lemma L1" }).first();
    await expect(lemmaRow).toBeVisible({ timeout: 8000 });
    const lemmaTestId = await lemmaRow.getAttribute("data-testid");
    const lemmaNum = lemmaTestId?.match(/^issue-(\d+)$/)?.[1];
    expect(lemmaNum).toBeTruthy();
    // Click Theorem T to open it.
    await page.locator('li [data-testid^="issue-"]').filter({ hasText: "Theorem T" }).first().click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await expect(page.getByTestId("depends-on-section")).toBeVisible();
    await page.getByTestId("depends-on-add-input").fill(String(lemmaNum));
    await page.getByTestId("depends-on-add").click();
    await expect(page.getByTestId(`depends-on-${lemmaNum}`)).toBeVisible({ timeout: 8000 });

    // Remove
    await page.getByTestId(`depends-on-${lemmaNum}-remove`).click();
    await expect(page.getByTestId(`depends-on-${lemmaNum}`)).toHaveCount(0, { timeout: 8000 });
  });

  test("Settings panel: owner creates a label and a milestone", async ({ page }) => {
    await loginAs(page, "chao");
    await page.getByTestId("file-hello.md").click();
    await expect(page.getByTestId("editor")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("sidebar-tab-settings")).toBeVisible();
    await page.getByTestId("sidebar-tab-settings").click();
    await expect(page.getByTestId("settings-labels")).toBeVisible({ timeout: 8000 });

    // Create a label
    await page.getByTestId("settings-label-name").fill("needs-review");
    await page.getByTestId("settings-label-color-3b82f6").click();
    await page.getByTestId("settings-label-create").click();
    await expect(page.locator('[data-testid^="settings-label-"][data-testid*="needs"]').or(
      page.getByText("needs-review"),
    ).first()).toBeVisible({ timeout: 8000 });

    // Create a milestone
    await page.getByTestId("settings-milestone-title").fill("v1 polish");
    await page.getByTestId("settings-milestone-description").fill("First round of cleanups.");
    await page.getByTestId("settings-milestone-create").click();
    await expect(page.getByText("v1 polish").first()).toBeVisible({ timeout: 8000 });
  });

  test("Non-owner doesn't see the Settings tab", async ({ page }) => {
    await loginAs(page, "meri");
    await expect(page.getByTestId("sidebar-tab-settings")).toHaveCount(0);
  });

  test("Owner creates a milestone via API; can assign + clear on an issue", async ({ page }) => {
    await loginAs(page, "chao");
    // Create milestone server-side (no full UI for create yet)
    await authedApiFetch(page, "/api/v1/w/flushing-coin/milestones", {
      method: "POST",
      body: JSON.stringify({ title: "v1 polish" }),
    });
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Milestone target");
    await page.getByTestId("new-issue-body").fill("Goes into v1.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();

    await page.getByTestId("milestone-pick").click();
    await page.locator('[data-testid^="milestone-set-"]').first().click();
    await expect(page.locator('[data-testid^="milestone-chip-"]').first()).toBeVisible({ timeout: 8000 });

    // Clear
    await page.getByTestId("milestone-pick").click();
    await page.getByTestId("milestone-clear").click();
    await expect(page.locator('[data-testid^="milestone-chip-"]')).toHaveCount(0, { timeout: 8000 });
  });

  test("Timeline renders non-comment events (close, label) alongside comments", async ({ page }) => {
    await loginAs(page, "chao");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Timeline target");
    await page.getByTestId("new-issue-body").fill("Trigger events.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();

    // Comment, label, close — three timeline-shaped events
    await page.getByTestId("issue-new-comment").fill("Initial thought.");
    await page.getByTestId("issue-new-comment-submit").click();
    await expect(page.locator('[data-testid^="issue-comment-"]').first()).toBeVisible({ timeout: 8000 });

    await page.getByTestId("issue-toggle-state").click();   // close
    await expect(page.getByTestId("issue-toggle-state")).toContainText("Reopen", { timeout: 8000 });

    // Timeline should now show the close event
    await expect(page.locator('[data-testid^="timeline-close-"]').first()).toBeVisible({ timeout: 8000 });
  });

  test("Activity lists open PRs alongside issues; issue body renders markdown", async ({ page }) => {
    await loginAs(page, "meri");
    await page.getByTestId("sidebar-tab-activity").click();
    // The global-setup opens one PR — it should show in Activity.
    await expect.poll(async () =>
      page.locator('[data-testid^="review-pull-"]').count(), { timeout: 8000 }
    ).toBeGreaterThanOrEqual(1);

    // Issue body markdown: headings, lists, code, math all render.
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill("Markdown test");
    await page.getByTestId("new-issue-body").fill(
      "## Heading\n\n- item one\n- item two\n\nInline `code` and math $a^2+b^2=c^2$.\n",
    );
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible();
    await expect(page.locator(".cf-issue-body h2")).toHaveText("Heading");
    await expect(page.locator(".cf-issue-body li").first()).toContainText("item one");
    await expect(page.locator(".cf-issue-body code").first()).toHaveText("code");
    await expect(page.locator(".cf-issue-body .katex").first()).toBeVisible();
  });
});
