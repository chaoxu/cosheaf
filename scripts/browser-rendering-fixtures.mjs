// Browser smoke for seeded long-form Markdown issue and PR rendering.

import { attachPageListeners, browserWebUrl, loadChromium, smokeDefaults } from "./browser-utils.mjs";
import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-rendering-fixtures.png";
const { username: USERNAME, password: PASSWORD, owner: OWNER, workspaceSlug: WORKSPACE_SLUG } = smokeDefaults();
const ISSUE_TITLE = "Rendering fixture: long Markdown issue";
const COFLAT_SHOWCASE_ISSUE_TITLE = "Rendering fixture: Coflat feature showcase";
const PR_TITLE = "Rendering fixture: long Markdown PR";
const SIDE_BY_SIDE_PR_TITLE = "Rendering fixture: side-by-side Markdown PR";

// A coflat reader surface is a bounded prose column: a finite reading measure
// (not full-bleed, not collapsed) that fits its container, with zero horizontal
// document padding and normal whitespace. We assert this invariant rather than
// coflat's exact default measure (36rem today) — coflat owns that and may tune
// it without it being a cosheaf regression. `stats.width` (reader) falls back to
// `stats.readerWidth`; `available` is the container/pane width.
function isBoundedProseColumn(stats, available) {
  const maxWidthPx = Number.parseInt(stats.maxWidth, 10);
  const width = stats.width ?? stats.readerWidth;
  return (
    Number.isFinite(maxWidthPx) &&
    maxWidthPx >= 400 &&
    maxWidthPx <= 1300 &&
    width >= 400 &&
    width <= available + 4 &&
    stats.paddingInline.join("/") === "0px/0px" &&
    stats.paragraphWhiteSpace === "normal"
  );
}

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
  await page.getByRole("link", { name: new RegExp(`^${OWNER}/${WORKSPACE_SLUG}\\b`) }).waitFor({ state: "visible", timeout: 10000 });
}

try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await ensureSignedIn();

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/issues`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(ISSUE_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(ISSUE_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const issueView = page.locator(".thread");
  await issueView.getByText("Purpose").waitFor({ state: "visible", timeout: 10000 });
  await issueView.getByText("Checklist").waitFor({ state: "visible", timeout: 10000 });
  await issueView.getByText("seededRenderingFixture").waitFor({ state: "visible", timeout: 10000 });

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/issues`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(COFLAT_SHOWCASE_ISSUE_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(COFLAT_SHOWCASE_ISSUE_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const showcaseView = page.locator(".thread");
  await showcaseView.getByText("Coflat Feature Showcase").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Frontmatter and Structure Editing").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Labeled Display Math and Equation References").waitFor({ state: "visible", timeout: 10000 });
  await showcaseView.getByText("Rich table for edit/display parity").waitFor({ state: "visible", timeout: 10000 });
  const readerSurface = await showcaseView.locator(CF.readerSurface).count();
  if (readerSurface === 0) {
    throw new Error("coflat showcase issue did not use a Coflat reader surface");
  }
  const showcaseIssueStats = await showcaseView.locator(CF.compactReader).first().evaluate((el, selector) => {
    const paragraph = el.querySelector(selector.paragraphOrNative);
    const styles = getComputedStyle(el);
    const parent = el.parentElement;
    return {
      width: Math.round(el.getBoundingClientRect().width),
      availableWidth: parent ? Math.round(parent.getBoundingClientRect().width) : 0,
      maxWidth: styles.maxWidth,
      paddingInline: [styles.paddingLeft, styles.paddingRight],
      paragraphWhiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : null,
    };
  }, CF);
  // The issue/PR thread reader renders a compact, bounded prose column.
  // Assert the invariant — a finite reading measure that
  // fits its container, zero horizontal padding, normal whitespace — rather
  // than coflat's exact default measure (it owns that and may tune it).
  if (!isBoundedProseColumn(showcaseIssueStats, showcaseIssueStats.availableWidth)) {
    throw new Error(`coflat issue reader is not using a bounded compact prose column: ${JSON.stringify(showcaseIssueStats)}`);
  }

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(PR_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(PR_TITLE).click();
  await page.locator(".thread").waitFor({ state: "visible", timeout: 10000 });
  const prHeader = page.locator(".thread");
  // Assert the PR description rendered into a coflat reader surface with its
  // body content present. The compact thread reader uses collapsible sections,
  // so assert rendered text content (matching richSurfaceText below) rather
  // than visibility of deep body content, and don't pin "Review focus" to a
  // heading role — the fixture owns whether it is a heading.
  await prHeader.locator(CF.readerSurface).first().waitFor({ state: "visible", timeout: 10000 });
  const prBodyText = await prHeader.locator(CF.readerSurface).first().evaluate((el) => el.textContent ?? "");
  if (!prBodyText.includes("Review focus") || !prBodyText.includes("rich diff rendering")) {
    throw new Error(`PR description did not render expected body content: ${prBodyText.slice(0, 200)}`);
  }

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await page.getByTestId("diff-pane-after").waitFor({ state: "visible", timeout: 10000 });
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-diff-mode-select").selectOption("source");
  await page.getByTestId("settings-diff-shape-select").selectOption("split");
  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await page.getByTestId("view-mode-source").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("diff-pane-split").waitFor({ state: "visible", timeout: 10000 });
  if (!page.url().includes("mode=source") || !page.url().includes("shape=split")) {
    throw new Error(`changed-files preference did not apply to URL: ${page.url()}`);
  }
  await page.goto(new URL("/account/settings", WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("settings-diff-mode-select").selectOption("rich");
  await page.getByTestId("settings-diff-shape-select").selectOption("after");
  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/pulls`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  await page.getByText(SIDE_BY_SIDE_PR_TITLE).click();
  await page.getByRole("link", { name: "Files changed" }).click();
  await page.getByTestId("diff-pane-after").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("view-mode-rich").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("view-shape-after").waitFor({ state: "visible", timeout: 10000 });
  const richAfterStats = await page.getByTestId("diff-pane-after").evaluate((el, selector) => {
    const reader = el.querySelector(selector.reader);
    if (!reader) return null;
    const paragraph = reader.querySelector(selector.paragraphOrNative);
    const styles = getComputedStyle(reader);
    return {
      paneWidth: Math.round(el.getBoundingClientRect().width),
      readerWidth: Math.round(reader.getBoundingClientRect().width),
      maxWidth: styles.maxWidth,
      paddingInline: [styles.paddingLeft, styles.paddingRight],
      paragraphWhiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : null,
    };
  }, CF);
  if (!richAfterStats || !isBoundedProseColumn(richAfterStats, richAfterStats.paneWidth)) {
    throw new Error(`rich after reader is not using a bounded document layout: ${JSON.stringify(richAfterStats)}`);
  }
  await page.getByTestId("view-shape-split").click();
  await page.getByTestId("diff-pane-split").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("This is the default development page").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("This branch version of the Flushing Coin hello page").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("sideBySideFixture").waitFor({ state: "visible", timeout: 10000 });
  const richDiffStats = await page.getByTestId("diff-pane-split").evaluate((el, selector) => {
    const katex = el.querySelector(selector.katex);
    const reader = el.querySelector(selector.reader);
    const richSurface = el.querySelector(selector.reader);
    return {
      katexCount: el.querySelectorAll(selector.katex).length,
      katexDisplay: katex ? getComputedStyle(katex).display : null,
      katexFont: katex ? getComputedStyle(katex).fontFamily : null,
      richSurfaceCount: el.querySelectorAll(selector.reader).length,
      readerWidth: reader ? Math.round(reader.getBoundingClientRect().width) : 0,
      richSurfaceText: richSurface?.textContent?.slice(0, 240) ?? "",
      paneWidth: Math.round(el.getBoundingClientRect().width),
    };
  }, CF);
  if (richDiffStats.richSurfaceCount === 0 || !richDiffStats.richSurfaceText.includes("Hello")) {
    throw new Error(`rich PR diff did not render document surfaces: ${JSON.stringify(richDiffStats)}`);
  }
  if (richDiffStats.readerWidth < 400) {
    throw new Error(`rich PR diff reader too narrow: ${JSON.stringify(richDiffStats)}`);
  }

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
