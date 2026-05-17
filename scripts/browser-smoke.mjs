// Headless browser smoke test for the cosheaf frontend.
// Usage: node scripts/browser-smoke.mjs
//
// Logs in, opens a workspace/page, captures the rendered editor state +
// screenshot, and prints page errors. Defaults match `pnpm setup:dev`.

import path from "node:path";
import { existsSync } from "node:fs";

// Resolve playwright from a global pnpm install if not in node_modules locally.
const candidates = [
  path.join(process.cwd(), "node_modules/playwright/index.js"),
  "/Users/chaoxu/Library/pnpm/global/5/node_modules/playwright/index.js",
];
const playwrightPath = candidates.find(existsSync);
if (!playwrightPath) {
  console.error("playwright not found; install via `pnpm add -g playwright` and `pnpm exec playwright install chromium`");
  process.exit(1);
}
const { chromium } = (await import(playwrightPath)).default;

const URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const WORKSPACE = process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const PAGE = process.env.COSHEAF_SMOKE_PAGE ?? "Hello";
const PAGE_PATH = process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
page.on("console", async (msg) => {
  const args = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => "[unserializable]")));
  consoleMessages.push(`[${msg.type()}] ${msg.text()} | ${JSON.stringify(args).slice(0, 400)}`);
});
page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? ""}`));

await page.goto(URL, { waitUntil: "networkidle" });

// Login if presented.
if (await page.locator('text=username').count() > 0) {
  const inputs = page.locator("input");
  await inputs.nth(0).fill(USERNAME);
  await inputs.nth(1).fill(PASSWORD);
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForSelector("aside", { timeout: 5000 }).catch(() => {});
}

// Click into the seeded workspace.
await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).click();
await page.waitForSelector("aside", { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(500);

// Open the seeded page.
await page.getByTestId(`file-${PAGE_PATH}`).click();
await page.waitForTimeout(2000);

const sizes = await page.evaluate(() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    "cm-host": get(".cm-host"),
    "cm-editor": get(".cm-editor"),
    "cm-content": get(".cm-content"),
    main: get("main"),
    aside: get("aside"),
    statusbar: get("[data-statusbar]"),
  };
});

const editorText = await page.locator(".cm-content").first().innerText().catch(() => "");
await page.screenshot({ path: SCREENSHOT, fullPage: false });

const ok = pageErrors.length === 0 && sizes["cm-content"] && editorText.length > 0;

console.log(JSON.stringify({
  ok,
  url: page.url(),
  workspace: WORKSPACE,
  page: PAGE,
  pagePath: PAGE_PATH,
  sizes,
  editorTextPreview: editorText.slice(0, 300),
  consoleSample: consoleMessages.slice(-10),
  pageErrors,
  screenshot: SCREENSHOT,
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
