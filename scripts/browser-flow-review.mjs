// Multi-user browser-level smoke for the review lifecycle.
// Requires `pnpm setup:dev:review` to have seeded chao/vera/meri.
// Walks: meri publishes-for-review → vera requests changes → meri re-publishes
// → vera approves → state goes to merged.

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";

const chromium = await loadChromium();

const URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-review.png";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const FLOW_PATH = process.env.COSHEAF_FLOW_PATH ?? `review-flow-${Date.now()}.md`;

const consoleAll = [];
const pageErrors = [];
const badResponses = [];

const browser = await chromium.launch({ headless: true });

async function makeContext(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  attachPageListeners(page, { label, consoleSink: consoleAll, errorSink: pageErrors, badResponseSink: badResponses });
  return page;
}

async function loginAs(page, user, password) {
  await page.goto(URL, { waitUntil: "networkidle" });
  await signInIfNeeded(page, user, password);
  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).waitFor({ state: "visible", timeout: 8000 });
  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).click();
  await page.getByTestId("new-file-toggle").waitFor({ state: "visible", timeout: 8000 });
}

async function typeIntoEditor(page, text) {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.type(text);
}

const meri = await makeContext("meri");
const vera = await makeContext("vera");

let stage = "start";
try {
  // ── 1. meri creates a file and sends it for review ─────────────────────────
  stage = "meri-login";
  await loginAs(meri, "meri", "123123");

  stage = "meri-create";
  await meri.getByTestId("new-file-toggle").click();
  await meri.getByTestId("new-file-path").fill(FLOW_PATH);
  await meri.keyboard.press("Enter");
  await meri.getByTestId(`file-${FLOW_PATH}`).waitFor({ state: "visible", timeout: 12000 });
  await meri.waitForURL(`**/w/${WORKSPACE_SLUG}/${FLOW_PATH}`, { timeout: 8000 });

  stage = "meri-edit-1";
  await typeIntoEditor(meri, " v1");
  // Save before publish (Save is disabled until dirty)
  await meri.locator('button:has-text("Save")').first().click();

  stage = "meri-publish-review-1";
  await meri.getByTestId("publish-review").waitFor({ state: "visible", timeout: 8000 });
  await meri.getByTestId("publish-review").click();
  // Read meri's active change id from the hidden DOM signal.
  await meri.getByTestId("active-change-id").waitFor({ state: "attached", timeout: 8000 });
  const changeId = (await meri.getByTestId("active-change-id").innerText()).trim();
  if (!changeId) throw new Error("could not read active-change-id from meri's session");

  // ── 2. vera reviews and requests changes ───────────────────────────────────
  stage = "vera-login";
  await loginAs(vera, "vera", "123123");

  stage = "vera-open-queue";
  await vera.getByTestId("sidebar-tab-queue").click();
  const queueItem = vera.locator(`[data-testid="queue-change-${changeId}"]`);
  await queueItem.waitFor({ state: "visible", timeout: 15000 });

  stage = "vera-click-queue";
  await queueItem.click();
  // Review surface should render: PR header, changed-files list, diff area
  // with the spike picker, and the action bar at the bottom.
  await vera.getByTestId("pr-header").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("pr-file-list").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("spike-unified").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("review-request-changes").waitFor({ state: "visible", timeout: 8000 });

  stage = "vera-request-changes";
  await vera.getByTestId("review-comment").fill("please add v2");
  await vera.getByTestId("review-request-changes").click();
  // After request-changes the UI exits review mode (buttons disappear) and the
  // queue item is removed.
  await vera.getByTestId("review-request-changes").waitFor({ state: "detached", timeout: 10000 });
  await vera.locator(`[data-testid="queue-change-${changeId}"]`).waitFor({ state: "detached", timeout: 10000 });

  // ── 3. meri re-publishes after the request ────────────────────────────────
  stage = "meri-edit-2";
  // SSE should have updated meri's state. Just re-edit.
  await meri.bringToFront();
  await typeIntoEditor(meri, " v2");
  await meri.locator('button:has-text("Save")').first().click();

  stage = "meri-publish-review-2";
  await meri.getByTestId("publish-review").click();
  await meri.waitForTimeout(1500);

  // ── 4. vera approves; auto-merge fires ────────────────────────────────────
  stage = "vera-refresh-queue";
  // After re-publish, change re-enters review state and queue. SSE refreshes it,
  // but we click the Queue tab again to force a clean state.
  await vera.bringToFront();
  await vera.getByTestId("sidebar-tab-files").click();
  await vera.getByTestId("sidebar-tab-queue").click();
  await vera.locator(`[data-testid="queue-change-${changeId}"]`).waitFor({ state: "visible", timeout: 10000 });
  await vera.locator(`[data-testid="queue-change-${changeId}"]`).click();
  await vera.getByTestId("review-approve").waitFor({ state: "visible", timeout: 8000 });

  stage = "vera-approve";
  await vera.getByTestId("review-comment").fill("LGTM");
  await vera.getByTestId("review-approve").click();
  // After approval at threshold=1, change merges. Queue item disappears.
  await vera.locator(`[data-testid="queue-change-${changeId}"]`).waitFor({ state: "detached", timeout: 15000 });

  // Approval badge for the merged change should now show "approve".
  // (Switch back to files tab to check meri's view of merged state via /api works too.)

  await meri.screenshot({ path: SCREENSHOT, fullPage: false });

  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    stage,
    changeId,
    path: FLOW_PATH,
    badResponses,
    pageErrors,
    consoleSample: consoleAll.slice(-15),
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  await meri.screenshot({ path: SCREENSHOT, fullPage: false }).catch(() => undefined);
  await vera.screenshot({ path: SCREENSHOT.replace(/\.png$/, "-vera.png"), fullPage: false }).catch(() => undefined);
  console.log(JSON.stringify({
    ok: false,
    stage,
    path: FLOW_PATH,
    error: err instanceof Error ? err.message : String(err),
    badResponses,
    pageErrors,
    consoleSample: consoleAll.slice(-15),
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
