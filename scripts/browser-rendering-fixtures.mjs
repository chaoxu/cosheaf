// Browser smoke for seeded long-form Markdown issue and PR rendering.

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-rendering-fixtures.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "cosheaf-admin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const ISSUE_TITLE = "Rendering fixture: long Markdown issue";
const COFLAT_SHOWCASE_ISSUE_TITLE = "Rendering fixture: Coflat feature showcase";
const PR_TITLE = "Rendering fixture: long Markdown PR";
const SIDE_BY_SIDE_PR_TITLE = "Rendering fixture: side-by-side Markdown PR";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

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

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/issues`, APP_URL).toString(), { waitUntil: "networkidle" });
  await page.getByText(ISSUE_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(ISSUE_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const issueView = page.locator(".thread");
  await issueView.getByText("Purpose").waitFor({ state: "visible", timeout: 10000 });
  await issueView.getByText("Checklist").waitFor({ state: "visible", timeout: 10000 });
  await issueView.getByText("seededRenderingFixture").waitFor({ state: "visible", timeout: 10000 });

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/issues`, APP_URL).toString(), { waitUntil: "networkidle" });
  await page.getByText(COFLAT_SHOWCASE_ISSUE_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(COFLAT_SHOWCASE_ISSUE_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const showcaseView = page.locator(".thread");
  await showcaseView.getByText("Coflat Feature Showcase").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Frontmatter and Structure Editing").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Labeled Display Math and Equation References").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Rich table for edit/display parity").waitFor({ state: "visible", timeout: 10000 });
  const readerSurface = await showcaseView.locator(".cf-doc-surface").count();
  if (readerSurface === 0) {
    throw new Error("coflat showcase issue did not use the full document reader surface");
  }

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, APP_URL).toString(), { waitUntil: "networkidle" });
  await page.getByText(PR_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(PR_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const prHeader = page.locator(".thread");
  await prHeader.getByText("Review focus").waitFor({ state: "visible", timeout: 10000 });
  await prHeader.getByText("rich diff rendering").waitFor({ state: "visible", timeout: 10000 });

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, APP_URL).toString(), { waitUntil: "networkidle" });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await page.getByText("This is the default development page").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("This branch version of the Flushing Coin hello page").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("sideBySideFixture").waitFor({ state: "visible", timeout: 10000 });

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    url: page.url(),
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
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
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
