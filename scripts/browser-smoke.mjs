// Headless browser smoke test for the primary server-rendered web UI.
// Usage: node scripts/browser-smoke.mjs
//
// Logs in, opens a workspace/page, captures the rendered document state +
// screenshot, and prints page errors. Defaults match `pnpm setup:dev`.

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:3030/";
const WEB_URL = process.env.COSHEAF_WEB_URL ?? serverRenderedOrigin(APP_URL);
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const WORKSPACE = process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const PAGE = process.env.COSHEAF_SMOKE_PAGE ?? "Hello";
const PAGE_PATH = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md";

function serverRenderedOrigin(value) {
  const url = new URL(value);
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "5173") {
    url.port = "3030";
  }
  return url.toString();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

await page.goto(WEB_URL, { waitUntil: "networkidle" });
await signInIfNeeded(page, USERNAME, PASSWORD);

// Open the seeded page.
const fileUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${PAGE_PATH}`, WEB_URL).toString();
await page.goto(fileUrl, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: PAGE_PATH }).waitFor({ state: "visible", timeout: 10000 });
await page.getByText(PAGE).first().waitFor({ state: "visible", timeout: 10000 });

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

const documentText = await page.locator(".document").first().innerText().catch(() => "");
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
