import { expect, test } from "@playwright/test";

const webBase = "http://localhost:3030";
const owner = "cosheaf-admin";
const repo = "flushing-coin";
const repoBase = `${webBase}/${repo}`;

test("server-rendered Forgejo-like pages work end to end", async ({ page }) => {
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);
  await expect(page.locator(".global-header")).toContainText("chao");
  await expect(page.locator(".global-header")).toHaveCSS("position", "static");

  await page.getByRole("link", { name: "flushing-coin" }).click();
  await expect(page).toHaveURL(repoBase);
  await expect(page.locator(".repo-tabs")).toContainText("Files");
  await expect(page.locator(".repo-tabs")).toContainText("Issues");
  await expect(page.locator(".repo-tabs")).toContainText("Pull Requests");
  await expect(page.locator(".repo-tabs")).toContainText("Notifications");
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Files");
  await expect(page.locator(".repo-body")).toContainText("hello.md");
  await expect(page.locator(".repo-body")).not.toContainText("Pull requests");

  await expect(page.locator(".repo-header")).not.toContainText(owner);
  await page.getByRole("link", { name: "chao" }).click();
  await expect(page).toHaveURL(`${webBase}/account/settings`);
  await expect(page.getByTestId("settings-user-preferences")).toBeVisible();
  await page.getByTestId("settings-document-theme-select").selectOption("blueprint-book");
  await page.getByTestId("settings-diff-mode-select").selectOption("rich");
  await page.getByTestId("settings-diff-shape-select").selectOption("after");
  await page.goto(`${repoBase}/settings`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Settings");
  await expect(page.getByTestId("settings-user-preferences")).toHaveCount(0);
  await expect(page.locator(".repo-body")).toContainText("Review policy");
  await expect(page.locator(".repo-body")).toContainText("Access");
  await expect(page.getByTestId("settings-access")).toBeVisible();
  const labelName = `web-label-${Date.now()}`;
  const milestoneName = `web-milestone-${Date.now()}`;
  await expect(page.getByTestId("settings-labels")).toBeVisible();
  await page.getByTestId("settings-label-name").fill(labelName);
  await page.getByTestId("settings-label-color").fill("2f6fed");
  await page.getByTestId("settings-label-submit").click();
  await expect(page.getByTestId("settings-labels")).toContainText(labelName);
  await expect(page.getByTestId("settings-milestones")).toBeVisible();
  await page.getByTestId("settings-milestone-title").fill(milestoneName);
  await page.getByTestId("settings-milestone-submit").click();
  await expect(page.getByTestId("settings-milestones")).toContainText(milestoneName);

  await page.goto(`${webBase}/${owner}/${repo}/src/branch/main/hello.md`);
  await expect(page).toHaveURL(`${repoBase}/src/branch/main/hello.md`);
  await expect(page.locator(".file-toolbar")).toContainText("hello.md");
  await expect(page.locator(".cf-reader")).toContainText("Hello");
  await expect(page.getByRole("link", { name: "Branches" })).toBeVisible();

  const branchToDelete = `user/chao/delete-me-${Date.now()}`;
  await page.goto(`${repoBase}/branches`);
  await expect(page.getByTestId("branch-create-form")).toBeVisible();
  await page.getByTestId("branch-create-name").fill(branchToDelete);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page).toHaveURL(`${repoBase}/src/branch/${branchToDelete}`);
  await expect(page.getByRole("link", { name: "Open pull request" })).toBeVisible();
  await page.goto(`${repoBase}/branches`);
  const createdBranchRow = page.locator(".branch-row", { hasText: branchToDelete });
  await expect(createdBranchRow).toBeVisible();
  await createdBranchRow.getByTestId("branch-delete").click();
  await expect(page.locator(".branch-row", { hasText: branchToDelete })).toHaveCount(0);

  await page.goto(`${repoBase}/notifications`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Notifications");
  await expect(page.getByTestId("notification-list")).toBeVisible();

  await page.goto(`${repoBase}/issues`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Issues");
  await expect(page.locator(".repo-body")).not.toContainText(owner);
  await expect(page.getByTestId("issue-filters")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("State filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Label filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Milestone filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Author filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Assignee filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Search issues")).toBeVisible();
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(page.getByTestId("issue-create-form")).toBeVisible();
  const issueTitle = `Web issue ${Date.now()}`;
  await page.getByTestId("issue-create-title").fill(issueTitle);
  await page.getByTestId("issue-create-body").fill("Created from the server-rendered new issue form.");
  await page.getByTestId("issue-create-submit").click();
  const issuePath = new URL(page.url()).pathname;
  await expect(page.locator(".thread-header")).toContainText(issueTitle);
  await expect(page.locator(".thread-header")).toContainText("#");
  await expect(page.getByTestId("issue-edit-form")).toBeVisible();
  await expect(page.getByTestId("issue-label-form")).toBeVisible();
  await expect(page.getByTestId("issue-relations")).toBeVisible();
  await expect(page.getByTestId("issue-toggle-pin")).toHaveText("Pin issue");
  await page.getByTestId("issue-toggle-pin").click();
  await expect(page.getByTestId("issue-toggle-pin")).toHaveText("Unpin");
  await expect(page.getByTestId("issue-toggle-state")).toHaveText("Close issue");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${issuePath}/state`) && res.request().method() === "POST"),
    page.getByTestId("issue-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${issuePath}`);
  await expect(page.getByTestId("issue-toggle-state")).toHaveText("Reopen");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${issuePath}/state`) && res.request().method() === "POST"),
    page.getByTestId("issue-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${issuePath}`);
  await expect(page.getByTestId("issue-toggle-state")).toHaveText("Close issue");
  await page.locator('input[aria-label="Depends on issue number"]').fill("1");
  await page.locator('form[action$="/dependencies"]').filter({ hasText: "Add" }).first().getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("issue-relations")).toContainText("#1");
  await expect(page.locator('form.comment-form[action$="/comments"]')).toBeVisible();
  await page.locator('form.comment-form[action$="/comments"] textarea[name="body"]').fill("issue comment before edit");
  await page.locator('form.comment-form[action$="/comments"]').getByRole("button", { name: "Comment" }).click();
  await expect(page.locator(".comment").filter({ hasText: "issue comment before edit" })).toBeVisible();
  await page.getByTestId("issue-comment-actions").last().locator("summary").click();
  await page.getByTestId("issue-comment-actions").last().locator('textarea[name="body"]').fill("issue comment after edit");
  await page.getByTestId("issue-comment-actions").last().getByRole("button", { name: "Save comment" }).click();
  await expect(page.locator(".comment").filter({ hasText: "issue comment after edit" })).toBeVisible();

  await page.goto(`${repoBase}/pulls`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Pull Requests");
  await expect(page.getByRole("link", { name: "New pull request" })).toHaveAttribute("href", "/flushing-coin/pulls/new");
  await page.getByRole("link", { name: "New pull request" }).click();
  await expect(page.getByTestId("pull-create-form")).toBeVisible();
  await expect(page.getByTestId("pull-create-base")).toBeVisible();
  await expect(page.getByTestId("pull-create-head")).toBeVisible();
  await page.goto(`${repoBase}/pulls`);
  await expect(page.getByTestId("pull-filters")).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("State filter")).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("Label filter")).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("Milestone filter")).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("Author filter")).toBeVisible();
  await page.locator('.list-row[href*="/pulls/"]', { hasText: "e2e demo PR" }).click();
  const demoPrPath = new URL(page.url()).pathname;
  await expect(page.locator(".subtabs")).toContainText("Files changed");
  await expect(page.getByTestId("pull-edit-form")).toBeVisible();
  await expect(page.getByTestId("pull-label-form")).toBeVisible();
  await expect(page.getByTestId("pull-review-requests")).toBeVisible();
  await expect(page.locator(".thread")).toContainText("pushed commit");
  await expect(page.getByRole("link", { name: "View branch output" })).toBeVisible();
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Close pull request");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${demoPrPath}/state`) && res.request().method() === "POST"),
    page.getByTestId("pull-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${demoPrPath}`);
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Reopen pull request");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${demoPrPath}/state`) && res.request().method() === "POST"),
    page.getByTestId("pull-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${demoPrPath}`);
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Close pull request");
  await page.locator('.subtabs a[href$="/files"]').click();
  await expect(page.locator(".changed-files")).toBeVisible();
  await expect(page.locator(".diff-panel")).toBeVisible();
  await expect(page.locator(".review-bottom")).toBeVisible();
  await expect(page.locator(".review-bottom")).toContainText("Review");
  await expect(page.getByTestId("view-mode-source")).toBeVisible();
  await expect(page.getByTestId("view-mode-rich")).toBeVisible();
  await expect(page.getByTestId("view-shape-unified")).toBeVisible();
  await expect(page.getByTestId("view-mode-rich")).toHaveClass(/active/);
  await expect(page.getByTestId("view-shape-after")).toHaveClass(/active/);
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();
  await page.getByTestId("view-mode-source").click();
  await page.getByTestId("view-shape-unified").click();
  await expect(page.getByTestId("diff-pane-unified")).toBeVisible();
  await expect(page.locator(".changed-files a").first()).toHaveAttribute("href", /mode=source&shape=unified/);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(0);
  await page.getByTestId("view-shape-split").click();
  await expect(page.getByTestId("diff-pane-split")).toBeVisible();
  await expect(page.locator(".line-composer summary").first()).toBeVisible();
  await page.getByTestId("view-shape-after").click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();
  await expect(page.locator(".line-composer summary").first()).toBeVisible();
  await page.getByTestId("view-mode-rich").click();
  await expect(page).toHaveURL(/mode=rich/);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(1);
  await expect(page.getByTestId("view-shape-unified")).toHaveClass(/disabled/);
  await page.getByTestId("view-shape-split").click();
  await expect(page.getByTestId("diff-pane-split")).toBeVisible();
  await page.getByTestId("view-shape-after").click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();

  const branch = `user/chao/web-pages-${Date.now()}`;
  const path = "web-page-e2e.md";
  await page.goto(
    `${repoBase}/_edit?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`,
  );
  await expect(page.locator(".edit-page")).toBeVisible();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("document-theme-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(".cm-content").fill(`# Web Page E2E\n\nThis was saved through a server-rendered editor.\n`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("saved");
  await page.goto(`${repoBase}/src/branch/${branch}/${path}`);
  await expect(page.locator(".cf-reader")).toContainText("Web Page E2E");
  await expect(page.getByRole("link", { name: "Open pull request" })).toBeVisible();
  await page.getByRole("link", { name: "Open pull request" }).click();
  await expect(page.getByTestId("pull-create-form")).toBeVisible();
  await expect(page.getByTestId("pull-create-head")).toHaveValue(branch);
  const prTitle = `Web PR ${Date.now()}`;
  await page.getByTestId("pull-create-title").fill(prTitle);
  await page.getByTestId("pull-create-body").fill("Opened from the server-rendered new pull request form.");
  await page.getByTestId("pull-create-submit").click();
  await expect(page).toHaveURL(/\/pulls\/\d+$/);
  await expect(page.locator(".thread-header")).toContainText(prTitle);
  await expect(page.getByRole("link", { name: "Files changed" })).toBeVisible();

  await page.goto(`${repoBase}/activity`);
  const headerTop = await page.locator(".global-header").boundingBox().then((box) => box?.y);
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(async () => page.locator(".global-header").boundingBox().then((box) => box?.y)).toBeLessThan(headerTop ?? 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByTestId("activity-row").filter({ hasText: "reopened" }).first().locator(`a[href$="${issuePath}"]`)).toBeVisible();
  await expect
    .poll(async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      return page.getByTestId("activity-row").filter({ hasText: branch }).count();
    })
    .toBeGreaterThan(0);
  const saveActivity = page.getByTestId("activity-row").filter({ hasText: branch }).first();
  await expect(saveActivity).toBeVisible();
  await expect(saveActivity.locator(`a[href$="/src/branch/${branch}"]`)).toBeVisible();
  await page.locator('a[href*="/commits/"]').first().click();
  await expect(page.locator(".commit-card")).toBeVisible();
});
