// Multi-user browser smoke for the Forgejo-shell review lifecycle.
// Requires `pnpm setup:dev:review` to have seeded chao/vera/meri.
// Walks: meri opens a PR → vera requests changes → meri amends and re-opens
// → vera approves → admin merges → state goes to merged.

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";

const chromium = await loadChromium();

const URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-review.png";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const ADMIN_PASSWORD = process.env.COSHEAF_ADMIN_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const MERI_PASSWORD = process.env.COSHEAF_MERI_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const VERA_PASSWORD = process.env.COSHEAF_VERA_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
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

async function waitForReviewRejection(page, prNumber, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rejected = await page.evaluate(async ({ n, workspaceSlug }) => {
      const pat = localStorage.getItem("cosheaf.pat");
      const r = await fetch(`/api/v1/w/${workspaceSlug}/pulls/${n}/reviews`, {
        headers: pat ? { authorization: `Bearer ${pat}` } : undefined,
      });
      if (!r.ok) return false;
      const j = await r.json();
      return j.rejections >= 1;
    }, { n: prNumber, workspaceSlug: WORKSPACE_SLUG });
    if (rejected) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`timed out waiting for request-changes review on PR ${prNumber}`);
}

async function waitForOpenedPr(page, branch, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prNumber = await page.evaluate(async ({ branch, workspaceSlug }) => {
      const pat = localStorage.getItem("cosheaf.pat");
      const r = await fetch(`/api/v1/w/${workspaceSlug}/pulls?state=open`, {
        headers: pat ? { authorization: `Bearer ${pat}` } : undefined,
      });
      if (!r.ok) return null;
      const { pulls } = await r.json();
      const found = pulls.find((p) => p.head_ref === branch || p.title === branch);
      const fallback = pulls
        .filter((p) => p.author_username === "meri" && p.head_ref?.startsWith("user/meri/wip-"))
        .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
      return found ? found.number : (fallback?.number ?? null);
    }, { branch, workspaceSlug: WORKSPACE_SLUG });
    if (prNumber) return prNumber;
    await page.waitForTimeout(500);
  }
  throw new Error("could not locate PR by head_ref after open");
}

const meri = await makeContext("meri");
const vera = await makeContext("vera");

let stage = "start";
try {
  // ── 1. meri creates a file and opens a PR ──────────────────────────────────
  stage = "meri-login";
  await loginAs(meri, "meri", MERI_PASSWORD);

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
  await meri.getByTestId("active-branch-name").waitFor({ state: "hidden", timeout: 8000 });

  // Locate the just-opened PR number via the Cosheaf API on the same origin.
  const prNumber = await waitForOpenedPr(meri, meriBranch);

  // ── 2. vera reviews and requests changes ───────────────────────────────────
  stage = "vera-login";
  await loginAs(vera, "vera", VERA_PASSWORD);

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
  await waitForReviewRejection(vera, prNumber);

  // ── 3. meri amends the same branch — the save pushes another commit to
  //       the existing PR's head ref instead of forking a second PR (#26).
  stage = "meri-edit-2";
  await meri.bringToFront();
  await typeIntoEditor(meri, " v2");
  await meri.locator('button:has-text("Save")').first().click();
  // After #26: openPull no longer clears currentBranchName for the "open
  // for review" path, so the save continues on the same head ref.
  await meri.getByTestId("active-branch-name").waitFor({ state: "attached", timeout: 8000 });
  const meriBranch2 = (await meri.getByTestId("active-branch-name").innerText()).trim();
  if (meriBranch2 !== meriBranch) {
    throw new Error(
      `expected the second save to push to the same PR branch "${meriBranch}", got "${meriBranch2}"`,
    );
  }

  // ── 4. vera approves the same PR after the follow-up commit lands ─────────
  stage = "vera-approve";
  await vera.bringToFront();
  await vera.getByTestId("sidebar-tab-inbox").click();
  const reviewPullItem2 = vera.locator(`[data-testid="review-pull-${prNumber}"]`);
  await reviewPullItem2.waitFor({ state: "visible", timeout: 15000 });
  await reviewPullItem2.click();
  await vera.getByTestId("review-approve").waitFor({ state: "visible", timeout: 8000 });
  await vera.getByTestId("review-comment").fill("LGTM");
  await vera.getByTestId("review-approve").click();

  // Approval lands; chao (admin) merges through the API.
  stage = "admin-merge";
  const adminPage = await makeContext("chao");
  await loginAs(adminPage, "chao", ADMIN_PASSWORD);
  const mergeResult = await adminPage.evaluate(async ({ n, workspaceSlug }) => {
    const pat = localStorage.getItem("cosheaf.pat");
    const r = await fetch(`/api/v1/w/${workspaceSlug}/pulls/${n}/merge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(pat ? { authorization: `Bearer ${pat}` } : {}),
      },
      body: JSON.stringify({ Do: "squash" }),
    });
    return { status: r.status, body: await r.text() };
  }, { n: prNumber, workspaceSlug: WORKSPACE_SLUG });
  if (mergeResult.status !== 200)
    throw new Error(`merge ${prNumber}: ${mergeResult.status} ${mergeResult.body}`);

  await meri.screenshot({ path: SCREENSHOT, fullPage: false });

  const ok = pageErrors.length === 0 && badResponses.length === 0;
  console.log(JSON.stringify({
    ok,
    stage,
    prNumber,
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
