// Browser regression for the server-rendered Coflat full reader surface.

import { attachPageListeners, browserWebUrl, loadChromium } from "./browser-utils.mjs";
import {
  assertCoflatCodeBlockParity,
  assertCoflatFootnoteSectionParity,
  assertCoflatLinkStyleParity,
  assertCoflatReaderEditorSurfaceParity,
  COFLAT_BROWSER_ATTRIBUTES as CFA,
  COFLAT_BROWSER_SELECTORS as CF,
} from "@chaoxu/coflat/browser-test-utils";
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
const OUTLINE_REFERENCE_LABEL = "Proof of Theorem 3";
const OUTLINE_REFERENCE_RAW = "@thm:fundamental";
const COGIRTH_OUTLINE_REFERENCE_LABEL = "Proof of Theorem 4";
const COGIRTH_OUTLINE_REFERENCE_RAW = "@cor:rank-reduction-from-bounded-gap";
const DESKTOP_VIEWPORT = { width: 1440, height: 1000 };
const RESPONSIVE_VIEWPORTS = [
  { name: "tablet-rail-boundary", width: 900, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
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
  return page.locator(CF.reader).first().evaluate((el, selector) => {
    const h = el.querySelector(`${selector.heading}, h1, h2`);
    const paragraph = el.querySelector(selector.paragraphOrNative);
    const ul = el.querySelector(selector.unorderedListOrNative);
    const displayMath = el.querySelector(selector.displayMath);
    const katex = displayMath?.querySelector(selector.katex);
    const katexDisplay = displayMath?.querySelector(selector.katexDisplay);
    const root = el.closest(selector.themeScope);
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
      headingNumber: h?.getAttribute(selector.attr.sectionNumber) ?? null,
      headingNumbers: [...el.querySelectorAll(selector.heading)]
        .slice(0, 8)
        .map((node) => node.getAttribute(selector.attr.sectionNumber)),
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      listMarkers: el.querySelectorAll(selector.listMarker).length,
      mathErrors: el.querySelectorAll(selector.mathError).length,
      unresolvedCrossrefs: [...el.querySelectorAll(`${selector.unresolvedCrossref}${selector.referenceKey}`)].map((node) =>
        node.getAttribute(selector.attr.referenceKey)
      ),
      citations: [...el.querySelectorAll(selector.citation)].slice(0, 5).map((node) => node.textContent ?? ""),
      redSample: [...el.querySelectorAll('[class*="error"], [class*="unresolved"]')]
        .slice(0, 8)
        .map((node) => node.textContent?.slice(0, 80) ?? ""),
      text: el.textContent?.slice(0, 160) ?? "",
    };
  }, { ...CF, attr: CFA });
}

async function editorStats() {
  return page.locator(CF.editorContent).first().evaluate((el, selector) => {
    const h = el.querySelector(`${selector.heading}, h1, h2`);
    const ul = el.querySelector(selector.unorderedListOrNative);
    const displayMath = el.querySelector(selector.displayMath);
    const katex = displayMath?.querySelector(selector.katex);
    const katexDisplay = displayMath?.querySelector(selector.katexDisplay);
    const root = el.closest(selector.themeScope);
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
      headingNumber: h?.getAttribute(selector.attr.sectionNumber) ?? null,
      headingNumbers: [...el.querySelectorAll(selector.heading)]
        .slice(0, 8)
        .map((node) => node.getAttribute(selector.attr.sectionNumber)),
      listStyle: ul ? getComputedStyle(ul).listStyleType : null,
      listMarkers: el.querySelectorAll(selector.listMarker).length,
      text: el.textContent?.slice(0, 160) ?? "",
    };
  }, { ...CF, attr: CFA });
}

async function readerCodeBlockStats() {
  return page.locator(CF.reader).first().evaluate((el, selector) => {
    const block = el.querySelector(selector.codeBlock);
    const code = block?.querySelector("code") ?? null;
    const language = block?.querySelector(selector.codeLanguage) ?? null;
    const blockStyles = block ? getComputedStyle(block) : null;
    const codeStyles = code ? getComputedStyle(code) : null;
    return {
      count: el.querySelectorAll(selector.codeBlock).length,
      languageText: language?.textContent?.trim() ?? null,
      pre: blockStyles
        ? {
          whiteSpace: blockStyles.whiteSpace,
          wordBreak: blockStyles.wordBreak,
          overflowWrap: blockStyles.overflowWrap,
          overflowX: blockStyles.overflowX,
          fontFamily: blockStyles.fontFamily,
        }
        : null,
      code: codeStyles
        ? {
          whiteSpace: codeStyles.whiteSpace,
          wordBreak: codeStyles.wordBreak,
          overflowWrap: codeStyles.overflowWrap,
          display: codeStyles.display,
          fontFamily: codeStyles.fontFamily,
        }
        : null,
    };
  }, CF);
}

async function editorCodeBlockStats() {
  return page.locator(CF.editorContent).first().evaluate((el, selector) => {
    const lines = [...el.querySelectorAll(selector.editorCodeLine)];
    return {
      count: lines.length,
      languageText: el.querySelector(selector.codeLanguage)?.textContent?.trim() ?? null,
      lines: lines.slice(0, 6).map((line) => {
        const styles = getComputedStyle(line);
        return {
          className: line.className,
          whiteSpace: styles.whiteSpace,
          wordBreak: styles.wordBreak,
          overflowWrap: styles.overflowWrap,
          overflowX: styles.overflowX,
          fontFamily: styles.fontFamily,
        };
      }),
    };
  }, CF);
}

async function readerLinkStats() {
  return page.locator(`${CF.reader} ${CF.link}`).first().evaluate((el) => {
    const styles = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      text: el.textContent?.trim() ?? "",
      line: styles.textDecorationLine,
      style: styles.textDecorationStyle,
      thickness: styles.textDecorationThickness,
      underlineOffset: styles.textUnderlineOffset,
      color: styles.color,
      display: styles.display,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function editorLinkStats() {
  return page.locator(`${CF.editorContent} ${CF.link}`).first().evaluate((el) => {
    const styles = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      text: el.textContent?.trim() ?? "",
      line: styles.textDecorationLine,
      style: styles.textDecorationStyle,
      thickness: styles.textDecorationThickness,
      underlineOffset: styles.textUnderlineOffset,
      color: styles.color,
      display: styles.display,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
}

async function footnoteSectionStats(rootSelector) {
  return page.locator(rootSelector).first().evaluate((el, selector) => {
    const section = el.querySelector(selector.footnoteSection);
    const entries = section ? [...section.querySelectorAll(selector.bibliographyEntry)] : [];
    const heading = section?.querySelector(selector.bibliographyHeading);
    const rect = section?.getBoundingClientRect();
    const styles = section ? getComputedStyle(section) : null;
    return {
      count: entries.length,
      heading: heading?.textContent?.trim() ?? null,
      numbers: entries.map((entry) => entry.querySelector(selector.bibliographyEntryNumber)?.textContent?.trim() ?? ""),
      hasBackrefs: entries.every((entry) => !!entry.querySelector(selector.footnoteBackref)),
      hasMath: entries.some((entry) => !!entry.querySelector(selector.inlineMathOrKatex)),
      text: section?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      width: rect ? Math.round(rect.width) : 0,
      display: styles?.display ?? null,
    };
  }, CF);
}

async function readerLayoutStats(viewportName) {
  return page.locator(".app-content").first().evaluate((appContent, arg) => {
    const { name, selector } = arg;
    const reader = appContent.querySelector(selector.reader);
    const rail = appContent.querySelector(".doc-rail");
    const doc = appContent.querySelector(".document");
    const readerRect = reader?.getBoundingClientRect();
    const appRect = appContent.getBoundingClientRect();
    const docRect = doc?.getBoundingClientRect();
    return {
      viewportName: name,
      viewportWidth: window.innerWidth,
      appWidth: Math.round(appRect.width),
      appScrollWidth: Math.round(appContent.scrollWidth),
      documentWidth: docRect ? Math.round(docRect.width) : 0,
      readerWidth: readerRect ? Math.round(readerRect.width) : 0,
      readerLeft: readerRect ? Math.round(readerRect.left) : 0,
      readerRight: readerRect ? Math.round(readerRect.right) : 0,
      railDisplay: rail ? getComputedStyle(rail).display : null,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    };
  }, { name: viewportName, selector: CF });
}

async function editorLayoutStats(viewportName) {
  return page.locator(".app-content").first().evaluate((appContent, arg) => {
    const { name, selector } = arg;
    const content = appContent.querySelector(selector.editorContent);
    const scroller = appContent.querySelector(selector.editorScroller);
    const rail = appContent.querySelector(".web-editor-outline");
    const appRect = appContent.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const scrollerStyles = scroller ? getComputedStyle(scroller) : null;
    return {
      viewportName: name,
      viewportWidth: window.innerWidth,
      appWidth: Math.round(appRect.width),
      appScrollWidth: Math.round(appContent.scrollWidth),
      contentWidth: contentRect ? Math.round(contentRect.width) : 0,
      contentLeft: contentRect ? Math.round(contentRect.left) : 0,
      contentRight: contentRect ? Math.round(contentRect.right) : 0,
      scrollerPaddingRight: scrollerStyles?.paddingRight ?? null,
      railDisplay: rail ? getComputedStyle(rail).display : null,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    };
  }, { name: viewportName, selector: CF });
}

function assertDesktopLayoutParity(readerLayout, editorLayout) {
  const context = { readerLayout, editorLayout };
  if (readerLayout.appScrollWidth > readerLayout.appWidth + 4) {
    throw new Error(`desktop reader has horizontal overflow: ${JSON.stringify(context)}`);
  }
  if (editorLayout.appScrollWidth > editorLayout.appWidth + 4) {
    throw new Error(`desktop editor has horizontal overflow: ${JSON.stringify(context)}`);
  }
  if (readerLayout.railDisplay === "none" || editorLayout.railDisplay === "none") {
    throw new Error(`desktop reader/editor rail unexpectedly hidden: ${JSON.stringify(context)}`);
  }
  if (Math.abs(readerLayout.readerWidth - editorLayout.contentWidth) > 1) {
    throw new Error(`desktop reader/editor content width mismatch: ${JSON.stringify(context)}`);
  }
  if (Math.abs(readerLayout.railWidth - editorLayout.railWidth) > 2) {
    throw new Error(`desktop reader/editor rail width mismatch: ${JSON.stringify(context)}`);
  }
  if (Math.abs(readerLayout.readerLeft - editorLayout.contentLeft) > 40) {
    throw new Error(`desktop reader/editor content left drift: ${JSON.stringify(context)}`);
  }
  if (Math.abs(readerLayout.readerRight - editorLayout.contentRight) > 40) {
    throw new Error(`desktop reader/editor content right drift: ${JSON.stringify(context)}`);
  }
}

function assertResponsiveLayoutParity(readerLayout, editorLayout) {
  const context = { readerLayout, editorLayout };
  if (readerLayout.appScrollWidth > readerLayout.appWidth + 4) {
    throw new Error(`reader viewport has horizontal overflow: ${JSON.stringify(context)}`);
  }
  if (editorLayout.appScrollWidth > editorLayout.appWidth + 4) {
    throw new Error(`editor viewport has horizontal overflow: ${JSON.stringify(context)}`);
  }
  if (readerLayout.readerWidth < 320 || editorLayout.contentWidth < 320) {
    throw new Error(`reader/editor content width collapsed: ${JSON.stringify(context)}`);
  }
  if (readerLayout.readerRight > readerLayout.viewportWidth + 4 || editorLayout.contentRight > editorLayout.viewportWidth + 4) {
    throw new Error(`reader/editor content overflows viewport: ${JSON.stringify(context)}`);
  }
  if (readerLayout.railDisplay !== editorLayout.railDisplay) {
    throw new Error(`reader/editor rail breakpoint mismatch: ${JSON.stringify(context)}`);
  }
  if (readerLayout.railDisplay === "none" && editorLayout.scrollerPaddingRight !== "0px") {
    throw new Error(`editor reserved hidden rail space: ${JSON.stringify(context)}`);
  }
  const maxDelta = readerLayout.railDisplay === "none" ? 12 : 260;
  if (Math.abs(readerLayout.readerWidth - editorLayout.contentWidth) > maxDelta) {
    throw new Error(`reader/editor responsive width mismatch: ${JSON.stringify(context)}`);
  }
}

async function assertHoverPreview(selector, expectedText) {
  const tooltip = page.locator(CF.hoverPreviewTooltip);
  await page.locator(selector).first().hover();
  await tooltip.waitFor({ state: "visible", timeout: 3000 });
  const text = await tooltip.textContent();
  if (!text?.includes(expectedText)) {
    throw new Error(`hover preview text mismatch for ${selector}: ${JSON.stringify(text)}`);
  }
  await page.mouse.move(10, 10);
  await tooltip.waitFor({ state: "hidden", timeout: 3000 }).catch(() => undefined);
}

async function assertResolvedOutlineLabel(surfaceName) {
  await page.locator(".doc-rail-outline").waitFor({ state: "visible", timeout: 10000 });
  const items = await page.locator(".doc-rail-outline a, .doc-rail-outline button").evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  );
  if (!items.some((text) => text.includes(OUTLINE_REFERENCE_LABEL))) {
    throw new Error(`${surfaceName} outline did not include ${JSON.stringify(OUTLINE_REFERENCE_LABEL)}: ${JSON.stringify(items)}`);
  }
  const rawHits = items.filter((text) => text.includes(OUTLINE_REFERENCE_RAW));
  if (rawHits.length > 0) {
    throw new Error(`${surfaceName} outline exposed raw reference text: ${JSON.stringify(rawHits)}`);
  }
  if (!items.some((text) => text.includes(COGIRTH_OUTLINE_REFERENCE_LABEL))) {
    throw new Error(`${surfaceName} outline did not include ${JSON.stringify(COGIRTH_OUTLINE_REFERENCE_LABEL)}: ${JSON.stringify(items)}`);
  }
  const cogirthRawHits = items.filter((text) => text.includes(COGIRTH_OUTLINE_REFERENCE_RAW));
  if (cogirthRawHits.length > 0) {
    throw new Error(`${surfaceName} outline exposed Cogirth-shaped raw reference text: ${JSON.stringify(cogirthRawHits)}`);
  }
}

async function scrollEditorUntilMounted(selector) {
  const scroller = page.locator(".cm-scroller").first();
  await scroller.waitFor({ state: "visible", timeout: 10000 });
  for (let step = 0; step < 12; step += 1) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return;
    await scroller.evaluate((el, index) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * (index / 11);
    }, step);
    await page.waitForTimeout(150);
  }
  const visibleReferences = await page.locator(CF.referenceWidget).evaluateAll((nodes) =>
    nodes.slice(0, 12).map((node) => node.textContent ?? ""),
  );
  throw new Error(`editor reference widget did not mount for ${selector}: ${JSON.stringify(visibleReferences)}`);
}

async function gotoShowcaseReader() {
  await page.goto(`${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/src/branch/main/${SHOWCASE_PATH}`, { waitUntil: "domcontentloaded" });
  await page.locator(CF.reader).waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`${CF.reader} ${CF.heading}`).first().waitFor({ state: "visible", timeout: 10000 });
}

async function gotoShowcaseEditor() {
  await page.goto(
    `${WEB_URL.replace(/\/$/, "")}/${OWNER}/${WORKSPACE_SLUG}/_edit?branch=main&path=${encodeURIComponent(SHOWCASE_PATH)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.locator(CF.editorContent).waitFor({ state: "visible", timeout: 10000 });
}

async function setDocumentTheme(theme) {
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  const themeSelect = page.getByTestId("settings-document-theme-select");
  await themeSelect.waitFor({ state: "visible", timeout: 10000 });
  await page.evaluate((value) => {
    const select = document.querySelector("[data-document-theme-user]");
    const legacyKey = "cosheaf:document-theme";
    const user = select instanceof HTMLSelectElement ? select.dataset.documentThemeUser || "" : "";
    const key = user ? `${legacyKey}:${user}` : legacyKey;
    localStorage.setItem(key, value);
    localStorage.setItem(legacyKey, value);
  }, theme);
  await themeSelect.selectOption(theme);
}

async function setReadingWidth(width) {
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  const widthSelect = page.getByTestId("settings-reading-width-select");
  await widthSelect.waitFor({ state: "visible", timeout: 10000 });
  await page.evaluate((value) => {
    const select = document.querySelector("[data-reading-width-user]");
    const legacyKey = "cosheaf:reading-width";
    const user = select instanceof HTMLSelectElement ? select.dataset.readingWidthUser || "" : "";
    const key = user ? `${legacyKey}:${user}` : legacyKey;
    localStorage.setItem(key, value);
    localStorage.setItem(legacyKey, value);
    document.documentElement.setAttribute("data-cosheaf-reading", value);
  }, width);
  await widthSelect.selectOption(width);
}

try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await ensureSignedIn();
  await setDocumentTheme("default");
  await setReadingWidth("normal");
  await gotoShowcaseReader();
  // Scope to the heading: the reader now renders an outline whose TOC link
  // carries the same text, so a bare getByText is ambiguous (strict-mode).
  await page.getByRole("heading", { name: "Frontmatter and Structure Editing" }).first().waitFor({ state: "visible", timeout: 10000 });

  const defaultReader = await readerStats();
  const defaultReaderLayout = await readerLayoutStats("desktop");
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
  if (!defaultReader.rootClass.includes("cf-theme-scope")) {
    throw new Error(`missing document theme scope: ${defaultReader.rootClass}`);
  }
  if (defaultReader.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`default reader should match the editor default theme: ${defaultReader.rootClass}`);
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
  const defaultReaderLink = await readerLinkStats();
  const defaultReaderCode = await readerCodeBlockStats();
  const defaultReaderFootnotes = await footnoteSectionStats(CF.reader);
  await assertResolvedOutlineLabel("reader");
  await assertHoverPreview(`${CF.reader} [${CFA.referenceKey}="thm:hover-preview"]`, "This referenced block exists");

  await setDocumentTheme("blueprint-book");
  await gotoShowcaseReader();
  const blueprintReader = await readerStats();
  if (!blueprintReader.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`settings-selected theme did not apply to reader: ${blueprintReader.rootClass}`);
  }
  await gotoShowcaseEditor();
  const blueprintEditor = await editorStats();
  if (!blueprintEditor.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`settings-selected theme did not apply to editor: ${blueprintEditor.rootClass}`);
  }
  assertCoflatReaderEditorSurfaceParity(blueprintReader, blueprintEditor);
  await setDocumentTheme("default");

  await gotoShowcaseEditor();
  const defaultEditor = await editorStats();
  const defaultEditorLayout = await editorLayoutStats("desktop");
  if (defaultEditor.rootClass.includes("cf-theme-blueprint-book")) {
    throw new Error(`default editor should match the reader default theme: ${defaultEditor.rootClass}`);
  }
  assertCoflatReaderEditorSurfaceParity(defaultReader, defaultEditor);
  assertDesktopLayoutParity(defaultReaderLayout, defaultEditorLayout);
  await scrollEditorUntilMounted(`${CF.editorContent} ${CF.link}`);
  const defaultEditorLink = await editorLinkStats();
  assertCoflatLinkStyleParity(defaultReaderLink, defaultEditorLink);
  await scrollEditorUntilMounted(CF.editorCodeLine);
  const defaultEditorCode = await editorCodeBlockStats();
  assertCoflatCodeBlockParity(defaultReaderCode, defaultEditorCode);
  await scrollEditorUntilMounted(CF.footnoteSection);
  const defaultEditorFootnotes = await footnoteSectionStats(CF.editorContent);
  assertCoflatFootnoteSectionParity(defaultReaderFootnotes, defaultEditorFootnotes);
  await assertResolvedOutlineLabel("editor");
  const editorHoverTarget = `${CF.referenceWidget} [${CFA.referenceId}="thm:hover-preview"], ${CF.referenceWidget}[${CFA.referenceKey}="thm:hover-preview"]`;
  await scrollEditorUntilMounted(editorHoverTarget);
  await assertHoverPreview(editorHoverTarget, "This referenced block exists");

  await setReadingWidth("wide");
  await gotoShowcaseReader();
  const wideReader = await readerStats();
  const wideReaderLayout = await readerLayoutStats("desktop-wide");
  await gotoShowcaseEditor();
  const wideEditor = await editorStats();
  const wideEditorLayout = await editorLayoutStats("desktop-wide");
  assertCoflatReaderEditorSurfaceParity(wideReader, wideEditor);
  assertDesktopLayoutParity(wideReaderLayout, wideEditorLayout);
  if (wideReader.width <= defaultReader.width || wideEditor.width <= defaultEditor.width) {
    throw new Error(`wide reading-width did not widen both surfaces: ${JSON.stringify({
      defaultReader,
      defaultEditor,
      wideReader,
      wideEditor,
    })}`);
  }
  await setReadingWidth("normal");

  const responsiveLayouts = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await gotoShowcaseReader();
    const readerLayout = await readerLayoutStats(viewport.name);
    await gotoShowcaseEditor();
    const editorLayout = await editorLayoutStats(viewport.name);
    assertResponsiveLayoutParity(readerLayout, editorLayout);
    responsiveLayouts.push({ readerLayout, editorLayout });
  }
  await page.setViewportSize(DESKTOP_VIEWPORT);

  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    defaultReader,
    defaultEditor,
    blueprintReader,
    blueprintEditor,
    wideReader,
    wideEditor,
    defaultReaderLink,
    defaultEditorLink,
    defaultReaderLayout,
    defaultEditorLayout,
    wideReaderLayout,
    wideEditorLayout,
    defaultReaderCode,
    defaultEditorCode,
    defaultReaderFootnotes,
    defaultEditorFootnotes,
    responsiveLayouts,
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
