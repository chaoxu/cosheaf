// Browser smoke for the server-rendered edit page's Coflat editor island.

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:5173/";
const WEB_URL = process.env.COSHEAF_WEB_URL ?? serverRenderedOrigin(APP_URL);
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-edit.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "cosheaf-admin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const PAGE_PATH = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "coflat-feature-showcase.md";
const BRANCH = process.env.COSHEAF_SMOKE_EDIT_BRANCH ?? `user/${USERNAME}/smoke-edit-check`;

function serverRenderedOrigin(value) {
  const url = new URL(value);
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "5173") {
    url.port = "3030";
  }
  return url.toString();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

try {
  await page.goto(WEB_URL, { waitUntil: "networkidle" });
  await signInIfNeeded(page, USERNAME, PASSWORD);

  const editUrl = new URL(
    `/${OWNER}/${WORKSPACE_SLUG}/_edit?branch=${encodeURIComponent(BRANCH)}&path=${encodeURIComponent(PAGE_PATH)}`,
    WEB_URL,
  ).toString();
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 15000 });
  await page.getByTestId("statusbar").waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "Source" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("heading", { name: "Outline" }).waitFor({ state: "visible", timeout: 10000 });
  if (await page.getByTestId("document-theme-select").isVisible().catch(() => false)) {
    throw new Error("document theme selector should live in Settings, not the editor statusbar");
  }

  const stats = await page.evaluate(() => {
    const editor = document.querySelector('[data-testid="editor"]');
    const cm = document.querySelector(".cm-editor");
    const outline = document.querySelector(".web-editor-outline");
    const statusbar = document.querySelector('[data-testid="statusbar"]');
    const pathInput = document.querySelector('[data-testid="editor-path-input"]');
    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { w: Math.round(box.width), h: Math.round(box.height) };
    };
    return {
      editor: rect(editor),
      codeMirror: rect(cm),
      outline: rect(outline),
      statusbar: statusbar?.textContent ?? "",
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
  if (stats.path !== PAGE_PATH || !stats.statusbar.includes(BRANCH)) {
    throw new Error(`statusbar missing file/branch context: ${stats.statusbar}`);
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
