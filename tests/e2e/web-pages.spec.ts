import { expect, test } from "@playwright/test";

const webBase = "http://localhost:3030";
const owner = "cosheaf-admin";
const repo = "flushing-coin";

test("server-rendered Forgejo-like pages work end to end", async ({ page }) => {
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);
  await expect(page.locator(".global-header")).toContainText("chao");

  await page.getByRole("link", { name: "flushing-coin" }).click();
  await expect(page).toHaveURL(`${webBase}/${owner}/${repo}`);
  await expect(page.locator(".repo-tabs")).toContainText("Code");
  await expect(page.locator(".repo-tabs")).toContainText("Issues");
  await expect(page.locator(".repo-tabs")).toContainText("Pull Requests");

  await page.goto(`${webBase}/${owner}/${repo}/src/branch/main/hello.md`);
  await expect(page.locator(".file-toolbar")).toContainText("hello.md");
  await expect(page.locator(".cf-reader")).toContainText("Hello");

  await page.goto(`${webBase}/${owner}/${repo}/issues`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Issues");
  await page.locator('.list-row[href*="/issues/"]').first().click();
  await expect(page.locator(".thread-header")).toContainText("#");
  await expect(page.locator(".comment-form")).toBeVisible();

  await page.goto(`${webBase}/${owner}/${repo}/pulls`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Pull Requests");
  await page.locator('.list-row[href*="/pulls/"]').first().click();
  await expect(page.locator(".subtabs")).toContainText("Files changed");
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
  await page.getByTestId("view-shape-split").click();
  await expect(page.getByTestId("diff-pane-split")).toBeVisible();
  await expect(page.locator(".line-composer summary").first()).toBeVisible();
  await page.getByTestId("view-shape-after").click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();
  await expect(page.locator(".line-composer summary").first()).toBeVisible();
  await page.getByTestId("view-mode-rich").click();
  await expect(page).toHaveURL(/mode=rich/);
  await expect(page.getByTestId("view-shape-unified")).toHaveClass(/disabled/);
  await page.getByTestId("view-shape-split").click();
  await expect(page.getByTestId("diff-pane-split")).toBeVisible();
  await page.getByTestId("view-shape-after").click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();

  const branch = `user/chao/web-pages-${Date.now()}`;
  const path = "web-page-e2e.md";
  await page.goto(
    `${webBase}/${owner}/${repo}/_edit?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`,
  );
  await expect(page.locator(".edit-page")).toBeVisible();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("document-theme-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(".cm-content").fill(`# Web Page E2E\n\nThis was saved through a server-rendered editor.\n`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("saved");
  await page.goto(`${webBase}/${owner}/${repo}/src/branch/${branch}/${path}`);
  await expect(page.locator(".cf-reader")).toContainText("Web Page E2E");
});
