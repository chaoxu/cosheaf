// Browser regression for the server-rendered Coflat full reader surface.

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:5173/";
const WEB_URL = process.env.COSHEAF_WEB_URL ?? serverRenderedOrigin(APP_URL);
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-reader-editor-parity.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "cosheaf-admin";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const SHOWCASE_PATH = "coflat-feature-showcase.md";

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

async function readerStats() {
  return page.locator(".cf-reader").first().evaluate((el) => {
    const h = el.querySelector(".cf-doc-heading, h1, h2");
    const ul = el.querySelector(".cf-doc-list--unordered, ul");
    const root = el.closest(".cf-theme-scope");
    const document = el.closest(".document");
    return {
      rootClass: root?.className ?? "",
      documentWidth: document ? Math.round(document.getBoundingClientRect().width) : 0,
      width: Math.round(el.getBoundingClientRect().width),
      padding: getComputedStyle(el).padding,
      font: getComputedStyle(el).fontFamily,
      fontSize: getComputedStyle(el).fontSize,
      headingSize: h ? getComputedStyle(h).fontSize : null,
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      mathErrors: el.querySelectorAll(".cf-math-error").length,
      unresolvedCrossrefs: [...el.querySelectorAll(".cf-crossref-unresolved[data-ref-key]")].map((node) =>
        node.getAttribute("data-ref-key")
      ),
      citations: [...el.querySelectorAll(".cf-citation")].slice(0, 5).map((node) => node.textContent ?? ""),
      redSample: [...el.querySelectorAll('[class*="error"], [class*="unresolved"]')]
        .slice(0, 8)
        .map((node) => node.textContent?.slice(0, 80) ?? ""),
      text: el.textContent?.slice(0, 160) ?? "",
    };
  });
}

try {
  await page.goto(WEB_URL, { waitUntil: "networkidle" });
  await ensureSignedIn();
  await page.goto(`${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${SHOWCASE_PATH}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cf-reader").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("Frontmatter and Structure Editing").waitFor({ state: "visible", timeout: 10000 });

  const defaultReader = await readerStats();
  if (defaultReader.documentWidth < 900) {
    throw new Error(`document width too narrow: document=${defaultReader.documentWidth}`);
  }
  if (defaultReader.width < defaultReader.documentWidth * 0.9) {
    throw new Error(`reader is not using document width: ${JSON.stringify(defaultReader)}`);
  }
  if (!defaultReader.rootClass.includes("cf-theme-scope")) {
    throw new Error(`missing document theme scope: ${defaultReader.rootClass}`);
  }
  if (defaultReader.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`default reader should match the editor default theme: ${defaultReader.rootClass}`);
  }
  if (!defaultReader.fontSize || !defaultReader.headingSize) {
    throw new Error(`missing document typography: ${JSON.stringify(defaultReader)}`);
  }
  if (defaultReader.listStyle !== "disc") {
    throw new Error(`reader list markers missing: ${defaultReader.listStyle}`);
  }
  if (defaultReader.mathErrors !== 0) {
    throw new Error(`reader has math render errors: ${JSON.stringify(defaultReader)}`);
  }
  if (defaultReader.unresolvedCrossrefs.length !== 0) {
    throw new Error(`reader has unresolved local crossrefs: ${JSON.stringify(defaultReader)}`);
  }
  if (!defaultReader.citations.includes("[1]")) {
    throw new Error(`reader did not resolve bibliography citations: ${JSON.stringify(defaultReader)}`);
  }
  if (defaultReader.redSample.length !== 0) {
    throw new Error(`reader still exposes unresolved/error markup: ${JSON.stringify(defaultReader)}`);
  }

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    defaultReader,
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
