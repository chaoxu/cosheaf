// Browser-level workflow smoke test for the seeded Cosheaf dev fixture.
// Creates a unique page through the UI, verifies pull request controls appear, and
// direct-merges it. Defaults match `pnpm setup:dev`.

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";

const chromium = await loadChromium();

const URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-flow.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const FLOW_PATH = process.env.COSHEAF_FLOW_PATH ?? `smoke-flow-${Date.now()}.md`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

async function textOfTestId(id) {
  return page.getByTestId(id).innerText().catch(() => "");
}

try {
  await page.goto(URL, { waitUntil: "networkidle" });
  await signInIfNeeded(page, USERNAME, PASSWORD);

  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).waitFor({ state: "visible", timeout: 8000 });
  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).click();
  await page.getByTestId("new-file-toggle").waitFor({ state: "visible", timeout: 8000 });

  await page.getByTestId("new-file-toggle").click();
  await page.getByTestId("new-file-path").fill(FLOW_PATH);
  await page.keyboard.press("Enter");

  await page.getByTestId(`file-${FLOW_PATH}`).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForURL(`**/w/${WORKSPACE_SLUG}/${FLOW_PATH}`, { timeout: 8000 });
  await page.getByTestId("merge-branch").waitFor({ state: "visible", timeout: 8000 });
  const branchStatus = await textOfTestId("statusbar");
  if (!branchStatus.includes(FLOW_PATH)) {
    throw new Error(`expected created file in statusbar, got: ${branchStatus}`);
  }

  await page.getByTestId("merge-branch").click();
  await page.getByTestId("merge-branch").waitFor({ state: "detached", timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 12000 });

  const finalStatus = await textOfTestId("statusbar");
  const editorText = await page.locator(".cm-content").first().innerText().catch(() => "");
  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0 && finalStatus.includes(FLOW_PATH) && editorText.includes(FLOW_PATH.replace(/\.md$/, ""));
  console.log(JSON.stringify({
    ok,
    url: page.url(),
    path: FLOW_PATH,
    finalStatus,
    editorTextPreview: editorText.slice(0, 300),
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
    path: FLOW_PATH,
    error: err instanceof Error ? err.message : String(err),
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
