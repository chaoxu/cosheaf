import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { expect, type Page, test } from "@playwright/test";
import { attachPageListeners, browserWebUrl, smokeDefaults } from "../../scripts/browser-utils.mjs";
import { smokeChecks } from "../../scripts/smoke-manifest.mjs";

const WEB_URL = browserWebUrl();
const defaults = smokeDefaults();
const OWNER = defaults.owner;
const WORKSPACE_SLUG = defaults.workspaceSlug;
const repoBase = new URL(`/${OWNER}/${WORKSPACE_SLUG}`, WEB_URL).toString().replace(/\/$/, "");

interface Diagnostics {
  consoleMessages: string[];
  pageErrors: string[];
  badResponses: string[];
  expectClean(): void;
}

function title(name: string): string {
  const check = smokeChecks.find((item) => item.name === name);
  if (!check) throw new Error(`missing smoke manifest entry: ${name}`);
  return `${check.name} ${check.grep}`;
}

function diagnostics(page: Page, label: string): Diagnostics {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  attachPageListeners(page, { label, consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });
  return {
    consoleMessages,
    pageErrors,
    badResponses,
    expectClean() {
      expect(pageErrors, `${label} page errors`).toEqual([]);
      expect(badResponses, `${label} bad responses`).toEqual([]);
    },
  };
}

async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(new URL("/api/v1/login", WEB_URL).toString(), {
    data: {
      username: defaults.username,
      password: defaults.password,
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json() as { pat: string };
  const url = new URL(WEB_URL);
  await page.context().addCookies([{
    name: "cosheaf_pat",
    value: body.pat,
    domain: url.hostname,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  }]);
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: new RegExp(`^${OWNER}/${WORKSPACE_SLUG}\\b`) })).toBeVisible();
}

function repoUrl(path = ""): string {
  return `${repoBase}${path}`;
}

function apiUrl(path: string): string {
  return new URL(`/api/v1/repos/${OWNER}/${WORKSPACE_SLUG}${path}`, WEB_URL).toString();
}

function isBoundedProseColumn(stats: { width?: number; readerWidth?: number; maxWidth: string; paddingInline: string[]; paragraphWhiteSpace: string | null }, available: number): boolean {
  const maxWidthPx = Number.parseInt(stats.maxWidth, 10);
  const width = stats.width ?? stats.readerWidth ?? 0;
  return (
    Number.isFinite(maxWidthPx) &&
    maxWidthPx >= 400 &&
    maxWidthPx <= 1300 &&
    width >= 400 &&
    width <= available + 4 &&
    stats.paddingInline.join("/") === "0px/0px" &&
    (stats.paragraphWhiteSpace === null || stats.paragraphWhiteSpace === "normal" || stats.paragraphWhiteSpace === "break-spaces")
  );
}

test(title("smoke"), async ({ page }) => {
  const diag = diagnostics(page, "smoke");
  await signIn(page);

  const fileUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${defaults.pagePath}`, WEB_URL);
  fileUrl.searchParams.set("mode", "read");
  await page.goto(fileUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect(page.getByText(defaults.pagePath).first()).toBeVisible();
  const renderedSurface = page.locator(".cf-reader, [data-testid=file-preview-markdown] .markdown-body").first();
  await expect(renderedSurface).toBeVisible();
  await expect(renderedSurface.getByText(defaults.page).first()).toBeVisible();

  const sizes = await page.evaluate(() => {
    const get = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return { document: get(".document"), reader: get(".cf-reader"), main: get("main") };
  });
  const documentText = await renderedSurface.textContent();
  expect(sizes.document ?? sizes.reader).toBeTruthy();
  expect(documentText?.length ?? 0).toBeGreaterThan(0);
  diag.expectClean();
});

test(title("repo-home"), async ({ page }) => {
  const diag = diagnostics(page, "repo-home");
  await signIn(page);
  await page.goto(repoUrl(), { waitUntil: "domcontentloaded" });

  const cloneInput = page.getByLabel("SSH clone URL");
  await expect(cloneInput).toBeVisible();
  const cloneUrl = await cloneInput.inputValue();
  const expectedCloneUrl = process.env.COSHEAF_EXPECTED_CLONE_URL;
  const expectedSuffix = `/${OWNER}/${WORKSPACE_SLUG}.git`;
  expect(expectedCloneUrl ? cloneUrl === expectedCloneUrl : cloneUrl.startsWith("ssh://") && cloneUrl.endsWith(expectedSuffix)).toBe(true);
  await expect(page.getByTestId("repo-clone")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(page.getByRole("link", { name: "SSH keys" })).toBeVisible();
  diag.expectClean();
});

test(title("issues-nav"), async ({ page }) => {
  const diag = diagnostics(page, "issues-nav");
  await signIn(page);
  await page.goto(repoUrl("/issues"), { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  const firstIssue = page.getByRole("link", { name: /#\d+$/ }).first();
  await expect(firstIssue).toBeVisible();
  await firstIssue.click();
  await page.waitForURL(new RegExp(`/${OWNER}/${WORKSPACE_SLUG}/issues/\\d+$`), { timeout: 10_000 });
  await expect(page.locator(".thread")).toBeVisible();
  const issueUrl = page.url();

  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  expect(new URL(issueUrl).pathname).toMatch(/\/issues\/\d+$/);
  expect(new URL(page.url()).pathname).toBe(`/${OWNER}/${WORKSPACE_SLUG}/issues`);
  await expect(page.locator(".list-row").first()).toBeVisible();
  diag.expectClean();
});

test(title("rendering-fixtures"), async ({ page }) => {
  test.setTimeout(90_000);
  const diag = diagnostics(page, "rendering-fixtures");
  await signIn(page);

  await page.goto(repoUrl("/issues"), { waitUntil: "domcontentloaded" });
  await page.getByText("Rendering fixture: long Markdown issue").click();
  const issueView = page.locator(".thread");
  await expect(issueView).toContainText("Purpose");
  await expect(issueView).toContainText("Checklist");
  await expect(issueView).toContainText("seededRenderingFixture");

  await page.goto(repoUrl("/issues"), { waitUntil: "domcontentloaded" });
  await page.getByText("Rendering fixture: Coflat feature showcase").click();
  const showcaseView = page.locator(".thread");
  await expect(showcaseView).toContainText("Frontmatter and Structure Editing");
  await expect(showcaseView).toContainText("Labeled Display Math and Equation References");
  await expect(showcaseView.locator(CF.readerSurface).first()).toBeVisible();
  const showcaseIssueStats = await showcaseView.locator(CF.compactReader).first().evaluate((el, selector) => {
    const paragraph = el.querySelector(selector.paragraphOrNative);
    const styles = getComputedStyle(el);
    const parent = el.parentElement;
    return {
      width: Math.round(el.getBoundingClientRect().width),
      availableWidth: parent ? Math.round(parent.getBoundingClientRect().width) : 0,
      maxWidth: styles.maxWidth,
      paddingInline: [styles.paddingLeft, styles.paddingRight],
      paragraphWhiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : null,
    };
  }, CF);
  expect(isBoundedProseColumn(showcaseIssueStats, showcaseIssueStats.availableWidth), JSON.stringify(showcaseIssueStats)).toBe(true);

  await page.goto(repoUrl("/pulls"), { waitUntil: "domcontentloaded" });
  await page.getByText("Rendering fixture: long Markdown PR").click();
  const prHeader = page.locator(".thread");
  await expect(prHeader.locator(CF.readerSurface).first()).toBeVisible();
  await expect(prHeader.locator(CF.readerSurface).first()).toContainText("Review focus");

  await page.goto(repoUrl("/pulls"), { waitUntil: "domcontentloaded" });
  await page.getByText("Rendering fixture: side-by-side Markdown PR").click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await expect(page.getByTestId("diff-pane-after")).toBeVisible();
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-diff-mode-select").selectOption("source");
  await page.getByTestId("settings-diff-shape-select").selectOption("split");
  await page.goto(repoUrl("/pulls"), { waitUntil: "domcontentloaded" });
  await page.getByText("Rendering fixture: side-by-side Markdown PR").click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await expect(page.getByTestId("view-mode-source")).toBeVisible();
  await expect(page.getByTestId("diff-pane-split")).toBeVisible();
  expect(page.url()).toContain("mode=source");
  expect(page.url()).toContain("shape=split");
  diag.expectClean();
});

test(title("reader-editor-parity"), async ({ page }) => {
  test.setTimeout(90_000);
  const diag = diagnostics(page, "reader-editor-parity");
  await signIn(page);

  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-document-theme-select").selectOption("default");
  await page.getByTestId("settings-reading-width-select").selectOption("normal");

  await page.goto(repoUrl("/src/branch/main/coflat-feature-showcase.md?mode=read"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(CF.reader)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Frontmatter and Structure Editing" }).first()).toBeVisible();
  const readerStats = await page.locator(CF.reader).first().evaluate((el, selector) => {
    const root = el.closest(selector.themeScope);
    const styles = getComputedStyle(el);
    return {
      rootClass: root?.className ?? "",
      width: Math.round(el.getBoundingClientRect().width),
      maxWidth: styles.maxWidth,
      mathErrors: el.querySelectorAll(selector.mathError).length,
      unresolvedCrossrefs: el.querySelectorAll(`${selector.unresolvedCrossref}${selector.referenceKey}`).length,
      citations: [...el.querySelectorAll(selector.citation)].map((node) => node.textContent ?? ""),
    };
  }, CF);
  expect(readerStats.rootClass).toContain("cf-theme-scope");
  expect(readerStats.mathErrors).toBe(0);
  expect(readerStats.unresolvedCrossrefs).toBe(0);
  expect(readerStats.citations).toContain("[1]");

  const editBranch = `user/${defaults.username}/web-edit`;
  await page.goto(repoUrl(`/src/branch/main/coflat-feature-showcase.md?mode=edit&edit_branch=${encodeURIComponent(editBranch)}`), { waitUntil: "domcontentloaded" });
  await expect(page.locator(CF.editorContent)).toBeVisible();
  const editorStats = await page.locator(CF.editorContent).first().evaluate((el, selector) => {
    const root = el.closest(selector.themeScope);
    return {
      rootClass: root?.className ?? "",
      width: Math.round(el.getBoundingClientRect().width),
      text: el.textContent?.slice(0, 2_000) ?? "",
    };
  }, CF);
  expect(editorStats.rootClass).toContain("cf-theme-scope");
  expect(editorStats.text).toContain("Frontmatter and Structure Editing");
  expect(Math.abs(readerStats.width - editorStats.width)).toBeLessThanOrEqual(80);

  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-document-theme-select").selectOption("blueprint-book");
  await page.goto(repoUrl("/src/branch/main/coflat-feature-showcase.md?mode=read"), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cf-theme-blueprint-book").first()).toBeVisible();
  await page.goto(repoUrl(`/src/branch/main/coflat-feature-showcase.md?mode=edit&edit_branch=${encodeURIComponent(editBranch)}`), { waitUntil: "domcontentloaded" });
  await expect(page.locator(".cf-theme-blueprint-book").first()).toBeVisible();
  diag.expectClean();
});

test(title("edit-island"), async ({ page }) => {
  test.setTimeout(90_000);
  const diag = diagnostics(page, "edit-island");
  await signIn(page);

  const pagePath = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "coflat-feature-showcase.md";
  const branch = process.env.COSHEAF_SMOKE_EDIT_BRANCH ?? `user/${defaults.username}/smoke-edit-check`;
  await page.goto(repoUrl(`/src/branch/main/${pagePath}?mode=edit&edit_branch=${encodeURIComponent(branch)}`), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("statusbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Source" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^(Outline|On this page)$/ })).toBeVisible();
  await expect(page.getByTestId("document-theme-select")).toHaveCount(0);

  const stats = await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="editor"]');
    const cm = document.querySelector(".cm-editor");
    const breadcrumb = document.querySelector(".app-statusbar .status-path");
    const pathInput = document.querySelector('[data-testid="editor-path-input"]');
    const title = document.querySelector(".cf-doc-title");
    const rect = (el: Element | null) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    };
    return {
      editor: rect(editor),
      codeMirror: rect(cm),
      title: rect(title),
      titleText: title?.textContent?.trim() ?? "",
      titleUserSelect: title ? window.getComputedStyle(title).userSelect : "",
      breadcrumb: breadcrumb?.textContent ?? "",
      path: pathInput instanceof HTMLInputElement ? pathInput.value : "",
    };
  });
  expect(stats.editor?.w ?? 0).toBeGreaterThan(600);
  expect(stats.editor?.h ?? 0).toBeGreaterThan(400);
  expect(stats.codeMirror?.h ?? 0).toBeGreaterThan(400);
  expect(stats.titleText).toBeTruthy();
  expect(stats.titleUserSelect).not.toBe("none");
  expect(stats.path).toBe(pagePath);
  expect(stats.breadcrumb).toContain(branch);

  const token = (await page.context().cookies(WEB_URL)).find((entry) => entry.name === "cosheaf_pat")?.value;
  expect(token).toBeTruthy();
  const selectionPath = process.env.COSHEAF_FLOW_PATH ?? `smoke-edit-selection-${Date.now()}.md`;
  const putResponse = await page.request.put(apiUrl(`/file?path=${encodeURIComponent(selectionPath)}&branch=${encodeURIComponent(branch)}`), {
    headers: { authorization: `Bearer ${token}`, origin: new URL(WEB_URL).origin },
    data: {
      content: [
        "---",
        "id: ztrcpji2",
        "---",
        "",
        "motivated by a workshop about order picking and crane scheduling",
        "",
        "The second paragraph remains selectable too.",
        "",
      ].join("\n"),
    },
  });
  expect(putResponse.ok()).toBe(true);

  await page.goto(repoUrl(`/src/branch/${branch}/${selectionPath}?mode=edit&edit_branch=${encodeURIComponent(branch)}`), { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("editor")).toBeVisible({ timeout: 15_000 });
  const firstParagraph = page.locator(".cm-line", { hasText: "motivated by a workshop" });
  await expect(firstParagraph).toBeVisible();
  await dragBetweenText(page, firstParagraph, "motivated", "crane scheduling");
  const selected = await editorSelection(page);
  expect(selected.empty).toBe(false);
  diag.expectClean();
});

test(title("math-macros"), async ({ page }) => {
  const diag = diagnostics(page, "math-macros");
  await signIn(page);

  const ts = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const branch = `smoke-math-${ts}`;
  const doc = `smoke-math-${ts}.md`;
  let createdBranch = false;
  try {
    const branchResponse = await page.request.post(apiUrl("/branches"), {
      headers: { "content-type": "application/json", origin: new URL(WEB_URL).origin },
      data: { name: branch },
    });
    createdBranch = branchResponse.ok();
    expect(branchResponse.ok()).toBe(true);
    const cfgResponse = await page.request.put(apiUrl(`/file?path=${encodeURIComponent("cosheaf.yaml")}&branch=${encodeURIComponent(branch)}`), {
      headers: { "content-type": "application/json", origin: new URL(WEB_URL).origin },
      data: { content: "math:\n  \\RepoMac: \\operatorname{RepoMac}\n" },
    });
    const docResponse = await page.request.put(apiUrl(`/file?path=${encodeURIComponent(doc)}&branch=${encodeURIComponent(branch)}`), {
      headers: { "content-type": "application/json", origin: new URL(WEB_URL).origin },
      data: {
        content: [
          "---",
          "title: Macro smoke",
          "math:",
          "  \\DecRank: \\text{Rank-}k\\text{-Reduction}",
          "---",
          "",
          "Frontmatter macro $\\DecRank$ and repo-wide macro $\\RepoMac$ must both expand.",
          "",
        ].join("\n"),
      },
    });
    expect(cfgResponse.ok()).toBe(true);
    expect(docResponse.ok()).toBe(true);

    await page.goto(repoUrl(`/src/branch/${branch}/${doc}?mode=read`), { waitUntil: "domcontentloaded" });
    const reader = page.locator(CF.reader).first();
    await expect(reader.locator(CF.katex).first()).toBeVisible({ timeout: 15_000 });
    const text = (await reader.innerText()).replace(/\s+/g, " ");
    expect(await reader.locator(".katex-error, .cf-math-error").count()).toBe(0);
    expect(text).toContain("Rank-");
    expect(text).toContain("Reduction");
    expect(text).toContain("RepoMac");
    expect(text).not.toContain("\\DecRank");
    expect(text).not.toContain("\\RepoMac");
    diag.expectClean();
  } finally {
    if (createdBranch) {
      await page.request.delete(apiUrl(`/branches/${encodeURIComponent(branch)}`), {
        headers: { origin: new URL(WEB_URL).origin },
      }).catch(() => undefined);
    }
  }
});

async function dragBetweenText(page: Page, locator: ReturnType<Page["locator"]>, startText: string, endText: string): Promise<void> {
  const start = await textRect(locator, startText);
  const end = await textRect(locator, endText);
  await page.mouse.move(start.left + 2, start.top + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.left + end.width - 2, end.top + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function textRect(locator: ReturnType<Page["locator"]>, text: string): Promise<{ left: number; top: number; width: number; height: number }> {
  return locator.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.textContent?.indexOf(needle) ?? -1;
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        }
      }
      node = walker.nextNode();
    }
    throw new Error(`missing text target: ${needle}`);
  }, text);
}

async function editorSelection(page: Page): Promise<{ empty: boolean; nativeText: string; selection: unknown }> {
  return page.evaluate(() => {
    const debug = (window as Window & { __cmDebug?: { selection?: () => { from: number; to: number } } }).__cmDebug;
    const selection = typeof debug?.selection === "function" ? debug.selection() : null;
    const nativeText = window.getSelection()?.toString() ?? "";
    return {
      empty: selection ? selection.from === selection.to : nativeText.length === 0,
      nativeText,
      selection,
    };
  });
}
