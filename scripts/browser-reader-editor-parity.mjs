// Browser regression for the server-rendered Coflat full reader surface.

import { attachPageListeners, browserWebUrl, loadChromium } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-reader-editor-parity.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const SHOWCASE_PATH = "coflat-feature-showcase.md";

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
  await page.getByRole("link", { name: new RegExp(`^${OWNER}/${WORKSPACE_SLUG}\\b`) }).waitFor({ state: "visible", timeout: 10000 });
}

async function readerStats() {
  return page.locator(".cf-reader").first().evaluate((el) => {
    const h = el.querySelector(".cf-doc-heading, h1, h2");
    const paragraph = el.querySelector(".cf-doc-paragraph, p");
    const ul = el.querySelector(".cf-doc-list--unordered, ul");
    const displayMath = el.querySelector(".cf-doc-display-math");
    const katex = displayMath?.querySelector(".katex");
    const katexDisplay = displayMath?.querySelector(".katex-display");
    const root = el.closest(".cf-theme-scope");
    const document = el.closest(".document");
    const styles = getComputedStyle(el);
    return {
      rootClass: root?.className ?? "",
      documentWidth: document ? Math.round(document.getBoundingClientRect().width) : 0,
      width: Math.round(el.getBoundingClientRect().width),
      maxWidth: styles.maxWidth,
      padding: styles.padding,
      paddingTop: styles.paddingTop,
      paddingInline: [styles.paddingLeft, styles.paddingRight],
      font: styles.fontFamily,
      fontSize: styles.fontSize,
      lineHeight: styles.lineHeight,
      displayMathSize: displayMath ? getComputedStyle(displayMath).fontSize : null,
      katexSize: katex ? getComputedStyle(katex).fontSize : null,
      katexDisplayMargin: katexDisplay ? getComputedStyle(katexDisplay).margin : null,
      headingSize: h ? getComputedStyle(h).fontSize : null,
      paragraphWhiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : null,
      headingNumber: h?.getAttribute("data-section-number") ?? null,
      headingNumbers: [...el.querySelectorAll(".cf-doc-heading")]
        .slice(0, 8)
        .map((node) => node.getAttribute("data-section-number")),
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      listMarkers: el.querySelectorAll(".cf-list-bullet, .cf-list-number").length,
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

async function editorStats() {
  return page.locator(".cm-content").first().evaluate((el) => {
    const h = el.querySelector(".cf-doc-heading, h1, h2");
    const ul = el.querySelector(".cf-doc-list--unordered, ul");
    const displayMath = el.querySelector(".cf-doc-display-math");
    const katex = displayMath?.querySelector(".katex");
    const katexDisplay = displayMath?.querySelector(".katex-display");
    const root = el.closest(".cf-theme-scope");
    const styles = getComputedStyle(el);
    return {
      rootClass: root?.className ?? "",
      width: Math.round(el.getBoundingClientRect().width),
      maxWidth: styles.maxWidth,
      padding: styles.padding,
      paddingTop: styles.paddingTop,
      paddingInline: [styles.paddingLeft, styles.paddingRight],
      font: styles.fontFamily,
      fontSize: styles.fontSize,
      lineHeight: styles.lineHeight,
      displayMathSize: displayMath ? getComputedStyle(displayMath).fontSize : null,
      katexSize: katex ? getComputedStyle(katex).fontSize : null,
      katexDisplayMargin: katexDisplay ? getComputedStyle(katexDisplay).margin : null,
      headingNumber: h?.getAttribute("data-section-number") ?? null,
      headingNumbers: [...el.querySelectorAll(".cf-doc-heading")]
        .slice(0, 8)
        .map((node) => node.getAttribute("data-section-number")),
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      listMarkers: el.querySelectorAll(".cf-list-bullet, .cf-list-number").length,
      text: el.textContent?.slice(0, 160) ?? "",
    };
  });
}

function assertReaderEditorParity(reader, editor) {
  const comparable = ["paddingTop", "fontSize", "lineHeight"];
  for (const key of comparable) {
    if (reader[key] !== editor[key]) {
      throw new Error(`reader/editor ${key} mismatch: ${JSON.stringify({ reader, editor })}`);
    }
  }
  if (!editor.maxWidth.includes("1200px")) {
    throw new Error(`editor package max-width contract mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  if (!reader.font.includes("KaTeX_Main") || !editor.font.includes("KaTeX_Main")) {
    throw new Error(`reader/editor content font mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  if (reader.katexSize !== reader.displayMathSize) {
    throw new Error(`reader display math size mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  if (editor.katexSize && reader.katexSize !== editor.katexSize) {
    throw new Error(`reader/editor display math size mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  if (editor.katexDisplayMargin && reader.katexDisplayMargin !== editor.katexDisplayMargin) {
    throw new Error(`reader/editor display math margin mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  const readerNumbers = reader.headingNumbers.filter(Boolean).slice(0, 4);
  const editorNumbers = editor.headingNumbers.filter(Boolean).slice(0, readerNumbers.length);
  if (readerNumbers.join("/") !== editorNumbers.join("/")) {
    throw new Error(`reader/editor heading numbering mismatch: ${JSON.stringify({ reader, editor })}`);
  }
  if (editor.listMarkers === 0) {
    throw new Error(`editor package list markers missing: ${JSON.stringify({ reader, editor })}`);
  }
}

try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await ensureSignedIn();
  await page.goto(`${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${SHOWCASE_PATH}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cf-reader").waitFor({ state: "visible", timeout: 10000 });
  // Scope to the heading: the reader now renders an outline whose TOC link
  // carries the same text, so a bare getByText is ambiguous (strict-mode).
  await page.getByRole("heading", { name: "Frontmatter and Structure Editing" }).first().waitFor({ state: "visible", timeout: 10000 });

  const defaultReader = await readerStats();
  if (defaultReader.documentWidth < 900) {
    throw new Error(`document width too narrow: document=${defaultReader.documentWidth}`);
  }
  // The document-page reader uses coflat's default reading measure (a bounded
  // prose column within the wider document container) — cosheaf only widens it
  // for the "wide" reading-width pref. Assert the bounded invariant, not
  // coflat's exact measure (36rem today; coflat owns and may tune it).
  const readerMaxWidthPx = Number.parseInt(defaultReader.maxWidth, 10);
  if (
    !Number.isFinite(readerMaxWidthPx) ||
    readerMaxWidthPx < 400 ||
    readerMaxWidthPx > 1300 ||
    defaultReader.width < 400 ||
    defaultReader.width > defaultReader.documentWidth + 4
  ) {
    throw new Error(`reader is not using a bounded document measure: ${JSON.stringify(defaultReader)}`);
  }
  if (defaultReader.paddingInline.join("/") !== "0px/0px") {
    throw new Error(`reader should not add horizontal document padding: ${JSON.stringify(defaultReader)}`);
  }
  if (defaultReader.paragraphWhiteSpace !== "normal") {
    throw new Error(`reader prose should flow source-wrapped lines normally: ${JSON.stringify(defaultReader)}`);
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
  if (defaultReader.listStyle !== "none" || defaultReader.listMarkers === 0) {
    throw new Error(`reader package list markers missing: ${JSON.stringify(defaultReader)}`);
  }
  if (!defaultReader.headingNumber) {
    throw new Error(`reader heading numbering missing: ${JSON.stringify(defaultReader)}`);
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

  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  const themeSelect = page.getByTestId("settings-document-theme-select");
  await themeSelect.waitFor({ state: "visible", timeout: 10000 });
  await themeSelect.selectOption("blueprint-book");
  await page.goto(`${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${SHOWCASE_PATH}`, { waitUntil: "domcontentloaded" });
  await page.locator(".cf-reader").waitFor({ state: "visible", timeout: 10000 });
  const blueprintReader = await readerStats();
  if (!blueprintReader.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`settings-selected theme did not apply to reader: ${blueprintReader.rootClass}`);
  }
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-document-theme-select").selectOption("default");

  await page.goto(
    `${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/_edit?branch=main&path=${encodeURIComponent(SHOWCASE_PATH)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator(".cm-content").waitFor({ state: "visible", timeout: 10000 });
  const defaultEditor = await editorStats();
  if (defaultEditor.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`default editor should match the reader default theme: ${defaultEditor.rootClass}`);
  }
  assertReaderEditorParity(defaultReader, defaultEditor);

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    defaultReader,
    defaultEditor,
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
