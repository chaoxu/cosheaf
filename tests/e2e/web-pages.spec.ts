import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  COFLAT_BROWSER_ATTRIBUTES as CFA,
  COFLAT_BROWSER_SELECTORS as CF,
} from "@chaoxu/coflat/browser-test-utils";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";
import { ensureSignedIn } from "./auth";

const webBase = defaultWebUrl();
const owner = "chao";
const repo = "flushing-coin";
const repoBase = `${webBase}/${owner}/${repo}`;

async function triggerCompose(scope: Locator): Promise<Locator | null> {
  const compose = scope.locator("[data-coflat-compose]").first();
  if (!await compose.count()) return null;
  await compose.dispatchEvent("pointerdown");
  return compose;
}

// On coflat workspaces (the fixture format) a compose textarea is enhanced by
// the web-comment-editor island: the textarea is hidden and a CodeMirror editor
// mirrors its value back. Type into the rich editor when it mounted, else fall
// back to the plain textarea when the island is not yet mounted.
async function fillCompose(scope: Locator, text: string): Promise<void> {
  const compose = await triggerCompose(scope);
  if (compose) {
    const content = compose.locator(CF.editorContent);
    const mounted = await content.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    if (mounted) {
      await content.click();
      await content.fill(text);
      // Wait for the island to mirror the value into the hidden form field.
      await expect(compose.locator("textarea")).toHaveValue(text);
      return;
    }
    await compose.locator("textarea").fill(text);
    return;
  }
  await scope.locator('textarea[name="body"]').fill(text);
}

async function expectComposeEditor(scope: Locator): Promise<void> {
  const compose = await triggerCompose(scope);
  if (!compose) throw new Error("Expected a Coflat compose field");
  await expect(compose.locator(CF.editorRoot).first()).toBeVisible();
}

async function expectRichComposerRevealsOnHover(page: Page): Promise<void> {
  const composer = page.locator(".rich-line-composer summary").first();
  await expect(composer).toBeVisible();
  await expect.poll(() => visibleRichComposerCount(page)).toBe(0);
  await page.locator(".rich-commentable:visible").first().hover();
  await expect.poll(() => visibleRichComposerCount(page)).toBeGreaterThan(0);
}

async function visibleRichComposerCount(page: Page): Promise<number> {
  return page.locator(".rich-line-composer summary").evaluateAll((summaries) =>
    summaries.filter((summary) => getComputedStyle(summary).opacity === "1").length,
  );
}

test("rich PR diffs expose comment composers on generated bibliography entries", async ({ page }) => {
  await ensureSignedIn(page, webBase);
  const token = (await page.context().cookies(webBase)).find((cookie) => cookie.name === "cosheaf_pat")?.value;
  expect(token).toBeTruthy();

  const branch = `codex/bib-comment-${Date.now()}`;
  const path = "notes/bib-comment-fixture.md";
  const apiHeaders = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const branchRes = await page.request.post(`${webBase}/api/v1/repos/${owner}/${repo}/branches`, {
    headers: apiHeaders,
    data: { name: branch },
  });
  expect(branchRes.ok()).toBe(true);
  const writeRes = await page.request.put(
    `${webBase}/api/v1/repos/${owner}/${repo}/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`,
    {
      headers: apiHeaders,
      data: {
        content: [
          "---",
          "bibliography: ../reference.bib",
          "---",
          "",
          "# Bibliography Comment Fixture",
          "",
          "A citation appears here [@cormen2009].",
          "",
        ].join("\n"),
      },
    },
  );
  expect(writeRes.ok()).toBe(true);
  const prRes = await page.request.post(`${webBase}/api/v1/repos/${owner}/${repo}/pulls`, {
    headers: apiHeaders,
    data: { head: branch, base: "main", title: "Bibliography comment fixture" },
  });
  expect(prRes.ok()).toBe(true);
  const pr = await prRes.json() as { number: number };

  await page.goto(`${repoBase}/pulls/${pr.number}/files?file=${encodeURIComponent(path)}&mode=rich&shape=after`);
  await expect(page.locator(".cf-bibliography-entry")).toContainText("Introduction to Algorithms");
  const bibliographyComposer = page.locator('.cf-bibliography-entry + .rich-line-composer summary[aria-label*="reference cormen2009"]');
  await expect(bibliographyComposer).toHaveCount(1);
  await expect(bibliographyComposer).toHaveCSS("opacity", "0");
  await page.locator(".cf-bibliography-entry.rich-commentable").hover();
  await expect(bibliographyComposer).toHaveCSS("opacity", "1");
});

test("rich PR diff comment composers preserve Coflat section disclosure adjacency", async ({ page }) => {
  await ensureSignedIn(page, webBase);

  await page.goto(`${repoBase}/pulls/3/files?mode=rich&shape=after`);
  await expect(page.locator(".cf-doc-section-heading-collapsible").first()).toBeVisible();
  await expect(page.locator(".rich-line-composer-before + .cf-doc-section-heading-collapsible").first()).toBeVisible();

  const brokenAdjacency = await page.locator(".cf-doc-section-heading-collapsible").evaluateAll((headings) =>
    headings
      .map((heading) => ({
        text: heading.textContent?.replace(/\s+/g, " ").trim() ?? "",
        nextClass: heading.nextElementSibling?.className?.toString() ?? "",
      }))
      .filter((entry) => !entry.nextClass.split(/\s+/).includes("cf-section-disclosure-body")),
  );
  expect(brokenAdjacency).toEqual([]);

  const headingComposer = page.locator(".rich-line-composer-before summary").first();
  await expect(headingComposer).toHaveCSS("opacity", "0");
  await page.locator(".rich-line-composer-before + .cf-doc-section-heading-collapsible").first().hover();
  await expect(headingComposer).toHaveCSS("opacity", "1");
});

test("server-rendered Forgejo-like pages work end to end", async ({ page }) => {
  test.setTimeout(90_000);
  await ensureSignedIn(page, webBase);
  await expect(page.locator(".sidebar-identity-link")).toContainText("chao");
  await expect(page.locator(".app-sidebar")).toContainText("Workspaces");

  await page.getByRole("link", { name: `${owner}/${repo}` }).click();
  await expect(page).toHaveURL(repoBase);
  // Owner-qualified URLs are canonical; the ownerless rewrite is gone.
  const ownerlessRepo = await page.request.get(`${webBase}/${repo}`, { maxRedirects: 0 });
  expect(ownerlessRepo.status()).toBe(404);
  await expect(page.locator(".repo-tabs")).toContainText("Files");
  await expect(page.locator(".repo-tabs")).toContainText("Issues");
  await expect(page.locator(".repo-tabs")).toContainText("PRs");
  await expect(page.locator(".repo-tabs")).toContainText("Notifications");
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Files");
  await expect(page.locator(`.app-sidebar a[title="hello.md"]`)).toHaveAttribute("data-read-href", `/${owner}/${repo}/src/branch/main/hello.md`);
  await expect(page.locator(`.app-sidebar a[title="cross-file-theorem.md"]`)).toHaveAttribute("data-read-href", `/${owner}/${repo}/src/branch/main/theory/cross-file-theorem.md`);
  await expect(page.locator(`.app-sidebar a[title="plain-text.txt"]`)).toHaveAttribute("data-read-href", `/${owner}/${repo}/src/branch/main/notes/plain-text.txt`);
  await expect(page.locator(`.app-sidebar a[href="/${owner}/${repo}/src/branch/main/docs/sample.pdf"]`)).toHaveCount(1);
  await expect(page.locator(".repo-body")).not.toContainText("Pull requests");

  // The repo sidebar names the workspace by its full owner/repo identity,
  // and the status bar path includes an owner crumb.
  await expect(page.locator(".app-sidebar")).toContainText(`${owner}/${repo}`);
  await expect(page.locator(".app-statusbar .status-path")).toContainText(owner);
  await page.locator(".settings-gear").click();
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
  await expect(page.getByTestId("settings-access")).toHaveCount(1);
  const labelName = `web-label-${Date.now()}`;
  const milestoneName = `web-milestone-${Date.now()}`;
  await expect(page.getByTestId("settings-labels")).toBeVisible();
  await page.getByTestId("settings-labels").locator(".add-disclosure > summary").click();
  await page.getByTestId("settings-label-name").fill(labelName);
  await page.getByTestId("settings-label-color").fill("2f6fed");
  await page.getByTestId("settings-label-submit").click();
  await expect(page.getByTestId("settings-labels")).toContainText(labelName);
  await expect(page.getByTestId("settings-milestones")).toBeVisible();
  await page.getByTestId("settings-milestones").locator(".add-disclosure > summary").click();
  await page.getByTestId("settings-milestone-title").fill(milestoneName);
  await page.getByTestId("settings-milestone-submit").click();
  await expect(page.getByTestId("settings-milestones")).toContainText(milestoneName);

  await page.goto(`${repoBase}/src/branch/main/hello.md`);
  await expect(page).toHaveURL(`${repoBase}/src/branch/main/hello.md`);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  const crossFileTheorem = page.getByRole("link", { name: "Theorem 1" });
  await expect(crossFileTheorem).toBeVisible();
  await expect(crossFileTheorem).toHaveAttribute(
    "href",
    `/${owner}/${repo}/src/branch/main/theory/cross-file-theorem.md#thm%3Acoin-conservation`,
  );
  await expect(page.getByRole("link", { name: "Branches" })).toHaveCount(0);

  await page.goto(`${repoBase}/src/branch/main/hello.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.getByTestId("editor")).toBeVisible();
  const editorCrossFileTheorem = page.locator(`${CF.editorContent} [${CFA.referenceKey}="thm:coin-conservation"]`);
  await expect(editorCrossFileTheorem).toContainText("Theorem 1");
  await expect(editorCrossFileTheorem.locator("a").first()).toHaveAttribute(
    "href",
    `/${owner}/${repo}/src/branch/user/chao/web-edit/theory/cross-file-theorem.md#thm%3Acoin-conservation`,
  );
  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect
    .poll(async () =>
      // CodeMirror virtualizes content, so scan the document instead of relying
      // on a fixed scroll offset (the showcase layout shifts as it evolves).
      page.evaluate(async (selector) => {
        const scroller = document.querySelector(selector.editorScroller);
        if (!scroller) return { unresolved: -1, tableText: "" };
        const step = Math.max(400, Math.floor(scroller.clientHeight / 2));
        let tableText = "";
        for (let top = 0; top <= scroller.scrollHeight; top += step) {
          scroller.scrollTop = top;
          await new Promise((resolve) => window.setTimeout(resolve, 150));
          tableText = [...document.querySelectorAll(selector.tableWidget)].map((el) => el.textContent ?? "").join("\n");
          if (tableText.includes("[1]")) break;
        }
        return {
          unresolved: document.querySelectorAll(
            `${selector.editorContent} ${selector.unresolvedCrossref}, ${selector.editorContent} ${selector.unresolvedCitation}`,
          ).length,
          tableText,
        };
      }, CF),
    )
    .toEqual(expect.objectContaining({ unresolved: 0, tableText: expect.stringContaining("[1]") }));

  await page.goto(`${repoBase}/src/branch/main/notes/plain-text.txt`);
  const plainTextRawPath = `/${owner}/${repo}/raw/branch/main/notes/plain-text.txt`;
  const plainTextRawHref = `${webBase}${plainTextRawPath}`;
  await expect(page.getByTestId("file-preview-text-raw")).toHaveAttribute("data", plainTextRawPath);
  const plainTextRaw = await page.request.get(plainTextRawHref);
  expect(plainTextRaw.ok()).toBe(true);
  expect(await plainTextRaw.text()).toContain("intentionally not Markdown");
  await expect(page.locator(CF.reader)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit text" })).toBeVisible();

  await page.goto(`${repoBase}/src/branch/main/docs/sample.pdf`);
  await expect(page.getByTestId("file-preview-pdf")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit text" })).toHaveCount(0);

  const textBranch = `user/chao/text-file-${Date.now()}`;
  await page.goto(
    `${repoBase}/src/branch/main/notes/plain-text.txt?mode=edit&edit_branch=${encodeURIComponent(textBranch)}`,
  );
  await expect(page.getByTestId("text-edit-form")).toBeVisible();
  await page.getByTestId("text-edit-form").locator('textarea[name="content"]').fill("Updated plain text fixture.\n");
  await page.getByTestId("text-edit-form").getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${repoBase}/src/branch/${textBranch}/notes/plain-text.txt`);
  const updatedTextRawPath = `/${owner}/${repo}/raw/branch/${textBranch}/notes/plain-text.txt`;
  const updatedTextRawHref = `${webBase}${updatedTextRawPath}`;
  await expect(page.getByTestId("file-preview-text-raw")).toHaveAttribute("data", updatedTextRawPath);
  const updatedTextRaw = await page.request.get(updatedTextRawHref);
  expect(updatedTextRaw.ok()).toBe(true);
  expect(await updatedTextRaw.text()).toContain("Updated plain text fixture.");
  await expect(page.getByRole("link", { name: "Open PR" })).toBeVisible();

  const branchToDelete = `user/chao/delete-me-${Date.now()}`;
  await page.goto(`${repoBase}/branches`);
  await expect(page.getByTestId("branch-create-form")).toBeVisible();
  await page.getByTestId("branch-create-name").fill(branchToDelete);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page).toHaveURL(`${repoBase}/src/branch/${branchToDelete}`);
  await expect(page.getByRole("link", { name: "Open PR" })).toBeVisible();
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
  // Authors render as real Forgejo usernames (no "repository" masking): the
  // seeded fixture issues were opened by the local Forgejo admin account.
  await expect(page.locator(".repo-body")).toContainText("cosheaf-admin");
  await expect(page.getByTestId("issue-filters")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("State filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Search issues")).toBeVisible();
  await page.getByTestId("issue-filters").locator("summary").click();
  await expect(page.getByTestId("issue-filters").getByRole("button", { name: "Label filter" })).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByRole("button", { name: "Milestone filter" })).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Author filter")).toBeVisible();
  await expect(page.getByTestId("issue-filters").getByLabel("Assignee filter")).toBeVisible();
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(page.getByTestId("issue-create-form")).toBeVisible();
  const issueTitle = `Web issue ${Date.now()}`;
  await page.getByTestId("issue-create-title").fill(issueTitle);
  await fillCompose(page.getByTestId("issue-create-form"), "Created from the server-rendered new issue form.");
  await page.getByTestId("issue-create-submit").click();
  const issuePath = new URL(page.url()).pathname;
  await expect(page.locator(".thread-header")).toContainText(issueTitle);
  await expect(page.locator(".thread-header")).toContainText("#");
  await expect(page.locator(".thread-header")).toContainText(`by ${owner}`);
  await expect(page.getByTestId("issue-edit-button")).toBeVisible();
  await page.getByTestId("issue-edit-button").click();
  await expect(page).toHaveURL(/\/issues\/\d+\/edit$/);
  await expect(page.getByTestId("issue-edit-form")).toBeVisible();
  // The body field is enhanced by the coflat editor island on coflat workspaces;
  // the rich editor is the visible compose surface (textarea is hidden behind it).
  await expectComposeEditor(page.getByTestId("issue-edit-form"));
  await page.goto(`${webBase}${issuePath}`);
  await expect(page.getByTestId("thread-labels")).toBeVisible();
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
  await page
    .getByTestId("issue-relations")
    .locator(".relation-card", { hasText: "Depends on" })
    .locator(".add-disclosure > summary")
    .click();
  await page.locator('input[aria-label="Depends on issue number"]').fill("1");
  await page.locator('form[action$="/dependencies"]').filter({ hasText: "Add" }).first().getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("issue-relations")).toContainText("#1");
  await expect(page.locator('form.comment-form[action$="/comments"]')).toBeVisible();
  await fillCompose(page.locator('form.comment-form[action$="/comments"]'), "issue comment before edit");
  await page.locator('form.comment-form[action$="/comments"]').getByRole("button", { name: "Comment" }).click();
  await expect(page.locator(".comment").filter({ hasText: "issue comment before edit" })).toBeVisible();
  await page.getByTestId("issue-comment-actions").last().locator("summary").click();
  await fillCompose(page.getByTestId("issue-comment-actions").last(), "issue comment after edit");
  await page.getByTestId("issue-comment-actions").last().getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".comment").filter({ hasText: "issue comment after edit" })).toBeVisible();

  await page.goto(`${repoBase}/pulls`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("PRs");
  await expect(page.getByRole("link", { name: "New PR" })).toHaveAttribute("href", `/${owner}/${repo}/pulls/new`);
  await page.getByRole("link", { name: "New PR" }).click();
  await expect(page.getByTestId("pull-create-form")).toBeVisible();
  await expect(page.getByTestId("pull-create-base")).toBeVisible();
  await expect(page.getByTestId("pull-create-head")).toBeVisible();
  await page.goto(`${repoBase}/pulls`);
  await expect(page.getByTestId("pull-filters")).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("State filter")).toBeVisible();
  await page.getByTestId("pull-filters").locator("summary").click();
  await expect(page.getByTestId("pull-filters").getByRole("button", { name: "Label filter" })).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByRole("button", { name: "Milestone filter" })).toBeVisible();
  await expect(page.getByTestId("pull-filters").getByLabel("Author filter")).toBeVisible();
  await page.getByRole("link", { name: /e2e demo PR #\d+/ }).click();
  const demoPrPath = new URL(page.url()).pathname;
  await expect(page.locator(".subtabs")).toContainText("Files changed");
  await expect(page.getByTestId("pull-edit-link")).toBeVisible();
  await expect(page.getByTestId("thread-labels")).toBeVisible();
  await expect(page.getByTestId("pull-review-requests")).toBeVisible();
  await page.getByTestId("pull-edit-link").click();
  await expect(page.getByTestId("pull-edit-form")).toBeVisible();
  await expectComposeEditor(page.getByTestId("pull-edit-form"));
  await page.goto(demoPrPath.startsWith("http") ? demoPrPath : `${webBase}${demoPrPath}`);
  await expect(page.locator(".thread")).toContainText(/pushed \d+ commits?/);
  await expect(page.getByRole("link", { name: "View branch output" })).toBeVisible();
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Close PR");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${demoPrPath}/state`) && res.request().method() === "POST"),
    page.getByTestId("pull-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${demoPrPath}`);
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Reopen PR");
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith(`${demoPrPath}/state`) && res.request().method() === "POST"),
    page.getByTestId("pull-toggle-state").click(),
  ]);
  await page.goto(`${webBase}${demoPrPath}`);
  await expect(page.getByTestId("pull-toggle-state")).toHaveText("Close PR");
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
  await expect(page.locator(".diff-change-nav")).toBeVisible();
  await page.locator(".patch tr.add, .patch tr.del").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".diff-change-nav")).toBeInViewport();
  await expect(page.locator(".changed-files a").first()).toHaveAttribute("href", /mode=source&shape=unified/);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(1);
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
  await expectRichComposerRevealsOnHover(page);
  await expect(page.locator(".rich-review-comment").first()).toBeVisible();
  await page.getByTestId("view-shape-after").click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();
  await expectRichComposerRevealsOnHover(page);

  const branch = `user/chao/web-pages-${Date.now()}`;
  const path = "web-page-e2e.md";
  await page.goto(
    `${repoBase}/src/branch/main/${encodeURIComponent(path)}?mode=edit&edit_branch=${encodeURIComponent(branch)}`,
  );
  await expect(page.locator(".edit-page")).toBeVisible();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("document-theme-select")).toHaveCount(0);
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(CF.editorContent).fill(`# Web Page E2E\n\nThis was saved through a server-rendered editor.\n`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("Saved");
  await page.goto(`${repoBase}/src/branch/${branch}/${path}`);
  await expect(page.locator(CF.reader)).toContainText("Web Page E2E");
  await page.goto(`${repoBase}/pulls/new?head=${encodeURIComponent(branch)}&base=main`);
  await expect(page.getByTestId("pull-create-form")).toBeVisible();
  await expect(page.getByTestId("pull-create-head")).toHaveValue(branch);
  const prTitle = `Web PR ${Date.now()}`;
  await page.getByTestId("pull-create-title").fill(prTitle);
  await fillCompose(page.getByTestId("pull-create-form"), "Opened from the server-rendered new pull request form.");
  await page.getByTestId("pull-create-submit").click();
  await expect(page).toHaveURL(/\/pulls\/\d+$/);
  await expect(page.locator(".thread-header")).toContainText(prTitle);
  await expect(page.getByRole("link", { name: "Files changed" })).toBeVisible();

  await page.goto(`${repoBase}/activity`);
  const statusbarTop = await page.locator(".app-statusbar").boundingBox().then((box) => box?.y);
  await page.locator(".app-content").evaluate((el) => el.scrollTo(0, 200));
  await expect.poll(async () => page.locator(".app-statusbar").boundingBox().then((box) => box?.y)).toBe(statusbarTop);
  await page.locator(".app-content").evaluate((el) => el.scrollTo(0, 0));
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
