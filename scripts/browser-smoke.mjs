// Headless browser smoke test for the primary server-rendered web UI.
// Usage: node scripts/browser-smoke.mjs
//
// Logs in, opens a workspace/page, captures the rendered document state +
// screenshot, and prints page errors. Defaults match `pnpm setup:dev`.

import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const WORKSPACE = process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const PAGE = process.env.COSHEAF_SMOKE_PAGE ?? "Hello";
const PAGE_PATH = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
await signInIfNeeded(page, USERNAME, PASSWORD);

// Open the seeded page.
const fileUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${PAGE_PATH}`, WEB_URL).toString();
await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
await page.getByText(PAGE_PATH).first().waitFor({ state: "visible", timeout: 10000 });
const renderedSurface = page.locator(".cf-reader, [data-testid=file-preview-markdown] .markdown-body").first();
await renderedSurface.waitFor({ state: "visible", timeout: 10000 });
await renderedSurface.getByText(PAGE).first().waitFor({ state: "visible", timeout: 10000 });

const sizes = await page.evaluate(() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    document: get(".document"),
    reader: get(".cf-reader"),
    main: get("main"),
  };
});

const documentText = await renderedSurface.textContent().catch(() => "");
await page.screenshot({ path: SCREENSHOT, fullPage: false });

const ok = pageErrors.length === 0 && badResponses.length === 0 && sizes.document && documentText.length > 0;

console.log(JSON.stringify({
  ok,
  url: page.url(),
  workspace: WORKSPACE,
  page: PAGE,
  pagePath: PAGE_PATH,
  sizes,
  documentTextPreview: documentText.slice(0, 300),
  consoleSample: consoleMessages.slice(-10),
  badResponses,
  pageErrors,
  screenshot: SCREENSHOT,
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
