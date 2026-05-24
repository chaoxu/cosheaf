// Browser smoke for the issue sidebar and browser history behavior.

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-issues-nav.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "cosheaf-admin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const VIEWPORT = { width: 1280, height: 800 };

const browser = await chromium.launch({ headless: true });
let context = await browser.newContext({ viewport: VIEWPORT });
let page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
const navigations = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) navigations.push(frame.url());
});
let targetFileUrl = "";
let postLoginUrl = "";

async function ensureSignedIn() {
  const signIn = page.locator('button:has-text("Sign in")');
  if (await signIn.isVisible().catch(() => false)) {
    const inputs = page.locator("input");
    await inputs.nth(0).fill(USERNAME);
    await inputs.nth(1).fill(PASSWORD);
    await signIn.click();
  }
  await page.getByRole("link", { name: new RegExp(`^${WORKSPACE_SLUG}\\b`) }).waitFor({ state: "visible", timeout: 10000 });
}

try {
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await ensureSignedIn();
  postLoginUrl = page.url();

  const storageState = await context.storageState();
  await context.close();
  context = await browser.newContext({ viewport: VIEWPORT, storageState });
  page = await context.newPage();
  attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  targetFileUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}/issues`, APP_URL).toString();
  await page.goto(targetFileUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Issues" }).waitFor({ state: "visible", timeout: 10000 });
  const firstIssue = page.locator(".list-row").first();
  await firstIssue.waitFor({ state: "visible", timeout: 10000 });
  await firstIssue.click();
  await page.waitForURL(new RegExp(`/${OWNER}/${WORKSPACE_SLUG}/issues/\\d+$`), { timeout: 10000 });
  await page.locator(".thread").waitFor({ state: "visible", timeout: 8000 });
  const issueUrl = page.url();

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Issues" }).waitFor({ state: "visible", timeout: 12000 });
  const backUrl = page.url();
  const issueCount = await page.locator(".list-row").count();

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok =
    pageErrors.length === 0 &&
    badResponses.length === 0 &&
    /\/issues\/\d+$/.test(new URL(issueUrl).pathname) &&
    new URL(backUrl).pathname.endsWith(`/${WORKSPACE_SLUG}/issues`) &&
    issueCount > 0;

  console.log(JSON.stringify({
    ok,
    issueUrl,
    backUrl,
    issueCount,
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    navigations,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  await page.screenshot({ path: SCREENSHOT, fullPage: false }).catch(() => undefined);
  console.log(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    url: page.url(),
    targetFileUrl,
    postLoginUrl,
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    navigations,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
