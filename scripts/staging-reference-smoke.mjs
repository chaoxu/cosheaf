#!/usr/bin/env node

import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();
process.env.URL ??= process.env.COSHEAF_STAGING_URL ?? "https://cosheaf-test.lab/";

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-staging-reference-smoke.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const PAGE_PATH = process.env.COSHEAF_REFERENCE_SMOKE_PATH ?? "coflat-feature-showcase.md";
const BRANCH = process.env.COSHEAF_REFERENCE_SMOKE_BRANCH ?? `user/${USERNAME}/staging-reference-smoke`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await signInIfNeeded(page, USERNAME, PASSWORD);

  const readerUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${PAGE_PATH}`, WEB_URL).toString();
  await page.goto(readerUrl, { waitUntil: "domcontentloaded" });
  await page.locator(CF.reader).waitFor({ state: "visible", timeout: 15000 });
  const readerPreview = await hoverPreviewText(
    page,
    `${CF.reader} ${CF.referenceKey}, ${CF.reader} ${CF.referenceWidget} ${CF.referenceWidgetId}`,
  );

  const editUrl = new URL(
    `/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${PAGE_PATH}?mode=edit&edit_branch=${encodeURIComponent(BRANCH)}`,
    WEB_URL,
  ).toString();
  await page.goto(editUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 15000 });
  const editorPreview = await hoverPreviewText(
    page,
    `${CF.editorContent} ${CF.referenceWidget}, ${CF.editorContent} ${CF.referenceKey}, ${CF.editorContent} ${CF.referenceWidgetId}`,
  );

  if (badResponses.length > 0 || pageErrors.length > 0) {
    throw new Error("reference smoke emitted browser errors");
  }

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  console.log(JSON.stringify({
    ok: true,
    url: page.url(),
    readerPreview: readerPreview.slice(0, 160),
    editorPreview: editorPreview.slice(0, 160),
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

async function hoverPreviewText(page, selector) {
  const target = page.locator(selector).first();
  await target.waitFor({ state: "attached", timeout: 15000 });
  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: "visible", timeout: 5000 });
  await target.hover();
  const tooltip = page.locator(CF.hoverPreviewTooltip).first();
  await tooltip.waitFor({ state: "visible", timeout: 5000 });
  const text = (await tooltip.textContent())?.trim() ?? "";
  if (text.length < 20) throw new Error(`hover preview was too short for ${selector}: ${JSON.stringify(text)}`);
  return text;
}
