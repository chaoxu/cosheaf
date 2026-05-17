// Multi-user browser smoke for the Forgejo-shell review lifecycle.
// Requires `pnpm setup:dev:review` to have seeded chao/vera/meri.
// Walks: meri opens a PR → vera requests changes → meri amends and re-opens
// → vera approves → admin merges → state goes to merged.

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
  // Wait for the editor's CodeMirror surface to be fully attached and
  // focusable. Without the editable=true check we can race against a
  // re-mount from the post-create state churn and end up typing into the
  // detached previous view.
  const editor = page.locator(".cm-content[contenteditable=true]").first();
  await editor.waitFor({ state: "visible", timeout: 8000 });
  await editor.click();
  await editor.focus();
  await page.keyboard.type(text, { delay: 10 });
}

const meri = await makeContext("meri");
const vera = await makeContext("vera");

let stage = "start";
try {
  // ── 1. meri creates a file and opens a PR ──────────────────────────────────
  stage = "meri-login";
  await loginAs(meri, "meri", "Cosheaf123!");

  stage = "meri-create";
  await meri.getByTestId("new-file-toggle").click();
  await meri.getByTestId("new-file-path").fill(FLOW_PATH);
  await meri.keyboard.press("Enter");
  await meri.getByTestId(`file-${FLOW_PATH}`).waitFor({ state: "visible", timeout: 12000 });
  await meri.waitForURL(`**/w/${WORKSPACE_SLUG}/${FLOW_PATH}`, { timeout: 8000 });

  stage = "meri-edit-1";
  await typeIntoEditor(meri, " v1");
  await meri.locator('button:has-text("Save")').first().click();
  await meri.getByTestId("active-branch-name").waitFor({ state: "attached", timeout: 8000 });
  const meriBranch = (await meri.getByTestId("active-branch-name").innerText()).trim();
  if (!meriBranch) throw new Error("could not read active-branch-name from meri's session");

  stage = "meri-open-pr-1";
  await meri.getByTestId("open-pull-request").waitFor({ state: "visible", timeout: 8000 });
  await meri.getByTestId("open-pull-request").click();
  // After open, currentBranch is cleared.
  await meri.getByTestId("active-branch-name").waitFor({ state: "detached", timeout: 8000 });

  // Locate the just-opened PR number via Forgejo-shape API on the same origin.
  const prNumber = await meri.evaluate(async (branch) => {
    const r = await fetch("/api/v1/w/flushing-coin/forgejo/pulls?state=open");
    const pulls = await r.json();
    const found = pulls.find((p) => p.head?.ref === branch);
    return found ? found.number : null;
  }, meriBranch);
  if (!prNumber) throw new Error("could not locate PR by head_ref after open");

  // ── 2. vera reviews and requests changes ───────────────────────────────────
  stage = "vera-login";
  await loginAs(vera, "vera", "Cosheaf123!");

  stage = "vera-open-inbox";
  await vera.getByTestId("sidebar-tab-inbox").click();
  const reviewPullItem = vera.locator(`[data-testid="review-pull-${prNumber}"]`);
  await reviewPullItem.waitFor({ state: "visible", timeout: 15000 });

  stage = "vera-click-pull";
  await reviewPullItem.click();
  await vera.getByTestId("pr-header").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("pr-file-list").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("review-request-changes").waitFor({ state: "visible", timeout: 8000 });

  stage = "vera-request-changes";
  await vera.getByTestId("review-comment").fill("please add v2");
  await vera.getByTestId("review-request-changes").click();
  // After REQUEST_CHANGES the PR stays open; we just verify via API.
  await vera.waitForFunction(
    async (n) => {
      const r = await fetch(`/api/v1/w/flushing-coin/pulls/${n}/reviews`);
      const j = await r.json();
      return j.rejections >= 1;
    },
    prNumber,
    { timeout: 10000 },
  );

  // ── 3. meri amends the same branch and we resubmit by re-saving ───────────
  stage = "meri-edit-2";
  await meri.bringToFront();
  await typeIntoEditor(meri, " v2");
  await meri.locator('button:has-text("Save")').first().click();
  // The save goes to a fresh user branch (currentBranchName was cleared on
  // opening a pull request). Open a *second* PR — Forgejo treats each amend session as its
  // own PR in this smoke; production would push to the same branch.
  await meri.getByTestId("active-branch-name").waitFor({ state: "attached", timeout: 8000 });
  const meriBranch2 = (await meri.getByTestId("active-branch-name").innerText()).trim();
  await meri.getByTestId("open-pull-request").click();
  await meri.getByTestId("active-branch-name").waitFor({ state: "detached", timeout: 8000 });
  const prNumber2 = await meri.evaluate(async (branch) => {
    const r = await fetch("/api/v1/w/flushing-coin/forgejo/pulls?state=open");
    const pulls = await r.json();
    const found = pulls.find((p) => p.head?.ref === branch);
    return found ? found.number : null;
  }, meriBranch2);
  if (!prNumber2) throw new Error("could not locate PR2");

  // ── 4. vera approves the new PR ───────────────────────────────────────────
  stage = "vera-approve";
  await vera.bringToFront();
  await vera.getByTestId("sidebar-tab-inbox").click();
  const reviewPullItem2 = vera.locator(`[data-testid="review-pull-${prNumber2}"]`);
  await reviewPullItem2.waitFor({ state: "visible", timeout: 15000 });
  await reviewPullItem2.click();
  await vera.getByTestId("review-approve").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("review-comment").fill("LGTM");
  await vera.getByTestId("review-approve").click();

  // Approval lands; chao (admin) merges through the API.
  stage = "admin-merge";
  const adminPage = await makeContext("chao");
  await loginAs(adminPage, "chao", "Cosheaf123!");
  const mergeResult = await adminPage.evaluate(async (n) => {
    const r = await fetch(`/api/v1/w/flushing-coin/pulls/${n}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Do: "squash" }),
    });
    return { status: r.status, body: await r.text() };
  }, prNumber2);
  if (mergeResult.status !== 200)
    throw new Error(`merge ${prNumber2}: ${mergeResult.status} ${mergeResult.body}`);

  await meri.screenshot({ path: SCREENSHOT, fullPage: false });

  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    stage,
    prNumber,
    prNumber2,
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
