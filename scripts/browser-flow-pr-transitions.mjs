// Walks state transitions on a fresh PR: Approve → merged, and Request
// changes → changes_requested. Each transition consumes a PR, so we create
// fresh ones via API per leg.
//
// Usage: pnpm smoke:pr-transitions

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const APP = "http://localhost:5173/";
const API = "/api/v1";

const errorSink = [];
const badResponseSink = [];
const consoleSink = [];

const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true });

async function fetchAs(user, path, init = {}) {
  // server-side fetch via password login; cookie jar held in a fresh context
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(APP);
    await page.evaluate(
      async ([u, p]) => {
        await fetch("/api/v1/logout", { method: "POST" });
        return fetch("/api/v1/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: u, password: p }),
        });
      },
      [user, "123123"],
    );
    const result = await page.evaluate(
      async ([p, opts]) => {
        const r = await fetch(p, opts);
        const text = await r.text();
        return { status: r.status, body: text };
      },
      [path, init],
    );
    return result;
  } finally {
    await ctx.close();
  }
}

async function createReviewablePr() {
  // meri creates a file and publishes it for review. Returns { changeId, prNumber }.
  const filePath = `flow-${Date.now()}.md`;
  const put = await fetchAs("meri", `${API}/w/flushing-coin/file?path=${filePath}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `# Pythagorean theorem\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n`,
    }),
  });
  if (put.status !== 200) throw new Error(`putFile failed: ${put.status} ${put.body.slice(0, 200)}`);
  const { change_id } = JSON.parse(put.body);
  const pub = await fetchAs("meri", `${API}/w/flushing-coin/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ change_id, mode: "review" }),
  });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.status} ${pub.body.slice(0, 200)}`);
  const { pr_number } = JSON.parse(pub.body);
  return { changeId: change_id, prNumber: pr_number };
}

async function loginVera(page) {
  await page.goto(APP);
  await page.evaluate(() => fetch("/api/v1/logout", { method: "POST" })).catch(() => undefined);
  await page.goto(APP);
  const inputs = page.locator("form input");
  await inputs.nth(0).fill("vera");
  await inputs.nth(1).fill("123123");
  await page.locator('button:has-text("Sign in")').click();
  await page.getByTestId("workspace-flushing-coin").waitFor();
  await page.getByTestId("workspace-flushing-coin").click();
}

let stage = "";
async function step(name, fn) {
  stage = name;
  try {
    await fn();
    console.log("OK    ", name);
  } catch (e) {
    console.log("FAIL  ", name, "—", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

let exitCode = 0;
try {
  // ===== Approve → merged =====
  await step("create-pr-for-approve", async () => {
    const { changeId, prNumber } = await createReviewablePr();
    console.log(`  approve-target: change=${changeId} pr=${prNumber}`);
    globalThis.__approveTarget = changeId;
  });

  const approveCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const approvePage = await approveCtx.newPage();
  attachPageListeners(approvePage, { consoleSink, errorSink, badResponseSink });

  await step("vera-approve-flow", async () => {
    await loginVera(approvePage);
    await approvePage.getByTestId("sidebar-tab-queue").click();
    await approvePage
      .getByTestId(`queue-change-${globalThis.__approveTarget}`)
      .waitFor({ state: "visible", timeout: 8000 });
    await approvePage.getByTestId(`queue-change-${globalThis.__approveTarget}`).click();
    await approvePage.getByTestId("pr-header").waitFor();
    await approvePage.getByTestId("review-approve").click();
    // After approve+merge, the PR header should disappear (we drop out of
    // the review surface) once the server returns the new state.
    await approvePage.getByTestId("pr-header").waitFor({ state: "detached", timeout: 15000 });
  });
  await approveCtx.close();

  // Confirm in DB
  await step("verify-merged-state", async () => {
    // Wait for webhook reconciliation (a moment)
    await new Promise((r) => setTimeout(r, 1500));
    const sqliteCmd = `sqlite3 /Users/chaoxu/playground/mathhub/db.sqlite "SELECT state FROM changes WHERE id='${globalThis.__approveTarget}';"`;
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bash", ["-c", sqliteCmd], { encoding: "utf8" });
    const state = result.stdout.trim();
    if (state !== "merged") throw new Error(`state is "${state}", expected merged`);
  });

  // ===== Request-changes → changes_requested =====
  await step("create-pr-for-request-changes", async () => {
    const { changeId } = await createReviewablePr();
    console.log(`  rc-target: change=${changeId}`);
    globalThis.__rcTarget = changeId;
  });

  const rcCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const rcPage = await rcCtx.newPage();
  attachPageListeners(rcPage, { consoleSink, errorSink, badResponseSink });

  await step("vera-request-changes-flow", async () => {
    await loginVera(rcPage);
    await rcPage.getByTestId("sidebar-tab-queue").click();
    await rcPage
      .getByTestId(`queue-change-${globalThis.__rcTarget}`)
      .waitFor({ state: "visible", timeout: 8000 });
    await rcPage.getByTestId(`queue-change-${globalThis.__rcTarget}`).click();
    await rcPage.getByTestId("pr-header").waitFor();
    await rcPage.getByTestId("review-comment").fill("Please tighten the proof.");
    await rcPage.getByTestId("review-request-changes").click();
    await rcPage.getByTestId("pr-header").waitFor({ state: "detached", timeout: 15000 });
  });
  await rcCtx.close();

  await step("verify-changes-requested-state", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bash", [
      "-c",
      `sqlite3 /Users/chaoxu/playground/mathhub/db.sqlite "SELECT state FROM changes WHERE id='${globalThis.__rcTarget}';"`,
    ], { encoding: "utf8" });
    const state = result.stdout.trim();
    if (state !== "changes_requested") {
      throw new Error(`state is "${state}", expected changes_requested`);
    }
  });

  console.log("\n*** STATE TRANSITION CHECKS PASSED ***");
} catch (err) {
  exitCode = 1;
  console.log("\nstage:", stage);
  console.log("error:", err instanceof Error ? err.stack : String(err));
} finally {
  if (errorSink.length) console.log("\nPAGE ERRORS:\n" + errorSink.join("\n"));
  const noisy = consoleSink.filter((l) => l.includes("[error]") && !l.includes("vite]"));
  if (noisy.length) console.log("\nCONSOLE:\n" + noisy.slice(0, 20).join("\n"));
  if (badResponseSink.length) {
    const real = badResponseSink.filter((l) => !l.includes("/api/v1/me") || !l.includes("401"));
    if (real.length) console.log("\nBAD RESPONSES:\n" + real.slice(0, 20).join("\n"));
  }
  await browser.close();
  process.exit(exitCode);
}
