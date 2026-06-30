// Browser smoke for the server-rendered edit page's Coflat editor island.

import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-edit.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const PAGE_PATH = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "coflat-feature-showcase.md";
const BRANCH = process.env.COSHEAF_SMOKE_EDIT_BRANCH ?? `user/${USERNAME}/smoke-edit-check`;
const SELECTION_PATH = process.env.COSHEAF_FLOW_PATH ?? `smoke-edit-selection-${Date.now()}.md`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await signInIfNeeded(page, USERNAME, PASSWORD);

  const editUrl = new URL(
    `/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${PAGE_PATH}?mode=edit&edit_branch=${encodeURIComponent(BRANCH)}`,
    WEB_URL,
  ).toString();
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 15000 });
  await page.getByTestId("statusbar").waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "Source" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("heading", { name: /^(Outline|On this page)$/ }).waitFor({ state: "visible", timeout: 10000 });
  if (await page.getByTestId("document-theme-select").isVisible().catch(() => false)) {
    throw new Error("document theme selector should live in Settings, not the editor statusbar");
  }

  const stats = await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="editor"]');
    const cm = document.querySelector(".cm-editor");
    const outline = document.querySelector(".web-editor-outline");
    const statusbar = document.querySelector('[data-testid="statusbar"]');
    const breadcrumb = document.querySelector(".app-statusbar .status-path");
    const pathInput = document.querySelector('[data-testid="editor-path-input"]');
    const title = document.querySelector(".cf-doc-title");
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    };
    const titleStyle = title ? window.getComputedStyle(title) : null;
    return {
      editor: rect(editor),
      codeMirror: rect(cm),
      outline: rect(outline),
      title: rect(title),
      titleText: title?.textContent?.trim() ?? "",
      titleUserSelect: titleStyle?.userSelect ?? "",
      statusbar: statusbar?.textContent ?? "",
      breadcrumb: breadcrumb?.textContent ?? "",
      path: pathInput instanceof HTMLInputElement ? pathInput.value : "",
      activeElementRole: document.activeElement?.getAttribute("role") ?? null,
    };
  });

  if (!stats.editor || stats.editor.w < 600 || stats.editor.h < 400) {
    throw new Error(`editor surface too small or missing: ${JSON.stringify(stats.editor)}`);
  }
  if (!stats.codeMirror || stats.codeMirror.h < 400) {
    throw new Error(`CodeMirror did not mount correctly: ${JSON.stringify(stats.codeMirror)}`);
  }
  if (!stats.title || !stats.titleText || stats.titleUserSelect === "none") {
    throw new Error(`first rendered editor title line is not selectable: ${JSON.stringify({
      title: stats.title,
      text: stats.titleText,
      userSelect: stats.titleUserSelect,
    })}`);
  }
  // The branch lives in the breadcrumb now (#164); the filename is the rename
  // input, and the editor action slot no longer duplicates either.
  if (stats.path !== PAGE_PATH || !stats.breadcrumb.includes(BRANCH)) {
    throw new Error(`breadcrumb missing file/branch context: ${stats.breadcrumb} (statusbar: ${stats.statusbar})`);
  }

  const pat = await apiPat(context);
  const selectionDoc = [
    "---",
    "id: ztrcpji2",
    "---",
    "",
    "motivated by a workshop about order picking and crane scheduling",
    "",
    "The second paragraph remains selectable too.",
    "",
  ].join("\n");
  const putResponse = await page.request.put(
    new URL(
      `/api/v1/repos/${OWNER}/${WORKSPACE_SLUG}/file?path=${encodeURIComponent(SELECTION_PATH)}&branch=${encodeURIComponent(BRANCH)}`,
      WEB_URL,
    ).toString(),
    {
      headers: { authorization: `Bearer ${pat}` },
      data: { content: selectionDoc },
    },
  );
  if (!putResponse.ok()) {
    throw new Error(`failed to seed selection regression page: ${putResponse.status()} ${await putResponse.text()}`);
  }

  const selectionUrl = new URL(
    `/${OWNER}/${WORKSPACE_SLUG}/src/branch/${BRANCH}/${SELECTION_PATH}?mode=edit&edit_branch=${encodeURIComponent(BRANCH)}`,
    WEB_URL,
  ).toString();
  await page.goto(selectionUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 15000 });
  const firstParagraph = page.locator(".cm-line", {
    hasText: "motivated by a workshop",
  });
  await firstParagraph.waitFor({ state: "visible", timeout: 10000 });
  await dragBetweenText(page, firstParagraph, "motivated", "crane scheduling");
  const selected = await editorSelection(page);
  if (selected.empty) {
    throw new Error(`first post-frontmatter paragraph drag produced an empty selection: ${JSON.stringify(selected)}`);
  }

  if (badResponses.length > 0 || pageErrors.length > 0) {
    throw new Error("edit page emitted browser errors");
  }

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  console.log(JSON.stringify({
    ok: true,
    url: page.url(),
    stats,
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(0);
} catch (err) {
  await page.screenshot({ path: SCREENSHOT, fullPage: false }).catch(() => undefined);
  console.log(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    url: page.url(),
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}

async function apiPat(context) {
  const cookie = (await context.cookies(WEB_URL)).find((entry) => entry.name === "cosheaf_pat");
  if (!cookie?.value) throw new Error("missing cosheaf_pat cookie after sign-in");
  return cookie.value;
}

async function dragBetweenText(page, locator, startText, endText) {
  const start = await textRect(locator, startText);
  const end = await textRect(locator, endText);
  await page.mouse.move(start.left + 2, start.top + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.left + end.width - 2, end.top + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function textRect(locator, text) {
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

async function editorSelection(page) {
  return page.evaluate(() => {
    const debug = window.__cmDebug;
    const selection = typeof debug?.selection === "function" ? debug.selection() : null;
    const nativeText = window.getSelection()?.toString() ?? "";
    return {
      empty: selection ? selection.from === selection.to : nativeText.length === 0,
      nativeText,
      selection,
    };
  });
}
