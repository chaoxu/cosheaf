// Browser regression for Coflat editor-rich vs full reader document surfaces.

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const chromium = await loadChromium();

const APP_URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-reader-editor-parity.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const SHOWCASE_PATH = "coflat-feature-showcase.md";
const SHOWCASE_ISSUE_TITLE = "Rendering fixture: Coflat feature showcase";

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
  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).waitFor({ state: "visible", timeout: 10000 });
}

async function editorStats() {
  return page.locator(".cm-content").first().evaluate((el) => {
    const h = el.querySelector(".cf-doc-heading, h1, h2");
    return {
      width: Math.round(el.getBoundingClientRect().width),
      padding: getComputedStyle(el).padding,
      font: getComputedStyle(el).fontFamily,
      fontSize: getComputedStyle(el).fontSize,
      headingSize: h ? getComputedStyle(h).fontSize : null,
      text: el.textContent?.slice(0, 160) ?? "",
    };
  });
}

async function readerStats() {
  return page.locator('[data-reader-surface="document"]').first().evaluate((el) => {
    const h = el.querySelector(".cf-doc-heading, h1, h2");
    const ul = el.querySelector(".cf-doc-list--unordered, ul");
    const root = el.closest(".cf-theme-scope");
    return {
      rootClass: root?.className ?? "",
      width: Math.round(el.getBoundingClientRect().width),
      padding: getComputedStyle(el).padding,
      font: getComputedStyle(el).fontFamily,
      fontSize: getComputedStyle(el).fontSize,
      headingSize: h ? getComputedStyle(h).fontSize : null,
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      text: el.textContent?.slice(0, 160) ?? "",
    };
  });
}

function px(value) {
  if (!value?.endsWith("px")) return Number.NaN;
  return Number(value.slice(0, -2));
}

function assertClose(label, actual, expected, tolerance = 1) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} differs: actual=${actual} expected=${expected}`);
  }
}

try {
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await ensureSignedIn();
  await page.goto(`${APP_URL.replace(/\/$/, "")}/w/${WORKSPACE_SLUG}/${SHOWCASE_PATH}`, { waitUntil: "domcontentloaded" });
  if (await page.locator('button:has-text("Rich")').isVisible().catch(() => false)) {
    await page.locator('button:has-text("Rich")').click();
  }
  await page.locator(".cm-content").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("Frontmatter and Structure Editing").waitFor({ state: "visible", timeout: 10000 });
  const editor = await editorStats();

  await page.getByTestId("sidebar-tab-issues").click();
  await page.getByRole("button", { name: "All" }).click();
  await page.getByText(SHOWCASE_ISSUE_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(SHOWCASE_ISSUE_TITLE).click();
  await page.locator('[data-reader-surface="document"]').waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("Frontmatter and Structure Editing").waitFor({ state: "visible", timeout: 10000 });

  const defaultReader = await readerStats();
  assertClose("document width", defaultReader.width, editor.width);
  assertClose("base font size", px(defaultReader.fontSize), px(editor.fontSize));
  assertClose("heading size", px(defaultReader.headingSize), px(editor.headingSize));
  if (!defaultReader.font.includes("KaTeX_Main") || !editor.font.includes("KaTeX_Main")) {
    throw new Error(`unexpected document font: editor=${editor.font} reader=${defaultReader.font}`);
  }
  if (defaultReader.listStyle !== "disc") {
    throw new Error(`reader list markers missing: ${defaultReader.listStyle}`);
  }

  await page.getByTestId("document-theme-select").selectOption("blueprint-book");
  await page.waitForTimeout(100);
  const blueprintReader = await readerStats();
  if (!blueprintReader.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error("Blueprint theme class was not applied");
  }
  if (blueprintReader.width >= defaultReader.width) {
    throw new Error(`Blueprint theme did not change reader width: default=${defaultReader.width} blueprint=${blueprintReader.width}`);
  }

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    editor,
    defaultReader,
    blueprintReader,
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
