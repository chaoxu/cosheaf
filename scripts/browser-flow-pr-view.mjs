// End-to-end browser walk of the PR review surface — every spike, every
// affordance, comment add/edit/delete, draft-review batching, role gating.
//
// Requires the standard dev fixture (`pnpm setup:dev:review`) plus a
// freshly-published change in review state. The script picks the first
// in-review change from vera's queue.
//
// Usage: pnpm smoke:pr-view

import { attachPageListeners, loadChromium } from "./browser-utils.mjs";

const URL = "http://localhost:5173/";
const SHOT_DIR = "/tmp";

const errorSink = [];
const badResponseSink = [];
const consoleSink = [];

const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
attachPageListeners(page, { consoleSink, errorSink, badResponseSink });

async function shot(name) {
  await page.screenshot({ path: `${SHOT_DIR}/pr-view-${name}.png`, fullPage: false }).catch(() => undefined);
}

let stage = "open";
async function step(name, fn) {
  stage = name;
  try {
    await fn();
    console.log("OK    ", name);
  } catch (e) {
    await shot(`fail-${name}`);
    console.log("FAIL  ", name, "—", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

async function loginAs(username) {
  await page.goto(URL).catch(() => undefined);
  await page.evaluate(() => fetch("/api/v1/logout", { method: "POST" })).catch(() => undefined);
  await page.goto(URL);
  const inputs = page.locator("form input");
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill("123123");
  await page.locator('button:has-text("Sign in")').click();
  await page.getByTestId(`workspace-flushing-coin`).waitFor({ state: "visible" });
  await page.getByTestId(`workspace-flushing-coin`).click();
}

async function openReview() {
  await page.getByTestId("sidebar-tab-queue").click();
  await page.locator('[data-testid^="queue-change-"]').first().click();
  await page.getByTestId("pr-header").waitFor({ state: "visible" });
  await page.getByTestId("spike-unified").click();
  await page.getByTestId("spike-unified-pane").waitFor({ state: "visible" });
  await page.locator('[data-testid="spike-unified-pane"] .group').first().waitFor({ timeout: 8000 });
}

let exitCode = 0;
try {
  // ----- Reviewer flow: vera (verifier) ----------------------------------
  await step("login-vera", () => loginAs("vera"));
  await step("enter-review", openReview);

  await step("comments-visible", async () => {
    const count = await page.locator('[data-testid="comment-thread"]').count();
    if (count < 1) throw new Error(`expected 1+ threads, got ${count}`);
  });

  for (const id of ["unified", "tint", "split", "rendered"]) {
    await step(`spike-${id}`, async () => {
      await page.getByTestId(`spike-${id}`).click();
      await page.getByTestId(`spike-${id}-pane`).waitFor({ state: "visible", timeout: 5000 });
      if (id === "unified") {
        await page.locator('[data-testid="spike-unified-pane"] .group').first().waitFor({ timeout: 8000 });
      } else if (id === "split") {
        await page.locator('[data-testid="spike-split-pane"] .cm-content').first().waitFor({ timeout: 8000 });
        const loading = await page.locator('[data-testid="spike-split-pane"] >> text=Loading').count();
        if (loading > 0) throw new Error("split-pane stuck on Loading");
      } else {
        await page.locator(`[data-testid="spike-${id}-pane"] .cm-content`).first().waitFor({ timeout: 8000 });
      }
      await shot(`spike-${id}`);
    });
  }

  await page.getByTestId("spike-unified").click();
  await page.getByTestId("spike-unified-pane").waitFor({ state: "visible" });

  await step("gutter-add-single", async () => {
    const btn = page.locator('[data-testid^="comment-add-new-"]').first();
    await btn.click({ force: true });
    await page.getByTestId("inline-composer").waitFor({ state: "visible" });
  });

  await step("submit-single", async () => {
    const composer = page.getByTestId("inline-composer");
    await composer.locator("textarea").fill("single-shot from verify");
    await composer.locator('button:has-text("Add comment")').click();
    await page.getByTestId("inline-composer").waitFor({ state: "detached", timeout: 5000 });
  });

  await step("edit-own", async () => {
    await page.waitForTimeout(800);
    const editButtons = page.locator('[data-testid^="comment-edit-"]');
    if ((await editButtons.count()) === 0) throw new Error("no edit buttons visible to vera");
    await editButtons.first().click();
    const id = await editButtons.first().getAttribute("data-testid");
    const cid = id.split("-").pop();
    const textarea = page.getByTestId(`comment-edit-body-${cid}`);
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("edited from verify");
    await page.getByTestId(`comment-edit-save-${cid}`).click();
    await textarea.waitFor({ state: "detached", timeout: 5000 });
  });

  await step("delete-own", async () => {
    const deleteButtons = page.locator('[data-testid^="comment-delete-"]:not([data-testid*="confirm"])');
    const before = await deleteButtons.count();
    if (before === 0) throw new Error("no delete buttons visible");
    await deleteButtons.first().click();
    // Inline confirm appears; click Delete.
    const confirm = page.locator('[data-testid^="comment-delete-confirm-"]').first();
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await confirm.click();
    await page.waitForFunction(
      (was) => document.querySelectorAll('[data-testid^="comment-delete-"]:not([data-testid*="confirm"])').length < was,
      before,
      { timeout: 8000 },
    );
  });

  await step("draft-on", async () => {
    await page.getByTestId("review-toggle-draft").click();
    await page.locator('[data-testid="review-toggle-draft"]:has-text("Draft active")').waitFor({ timeout: 5000 });
  });

  await step("draft-add-comment", async () => {
    const btn = page.locator('[data-testid^="comment-add-new-"]').first();
    await btn.click({ force: true });
    const composer = page.getByTestId("inline-composer");
    await composer.locator("textarea").fill("batched 1");
    await composer.locator('button:has-text("Add comment")').click();
    await page.getByTestId("inline-composer").waitFor({ state: "detached", timeout: 5000 });
  });

  await step("draft-submit-as-comment", async () => {
    const textarea = page.locator('[data-testid="review-comment"]');
    await textarea.fill("submitting batch as comment-only");
    await page.getByTestId("review-comment-submit").click();
    await page.locator('[data-testid="review-toggle-draft"]:has-text("Start a review")').waitFor({ timeout: 5000 });
  });

  await step("switch-file", async () => {
    const files = page.locator('[data-testid^="pr-file-"]');
    const count = await files.count();
    if (count < 2) throw new Error(`need 2+ files in PR, got ${count}`);
    await files.nth(1).click();
    await page.waitForTimeout(300);
    await page.getByTestId("spike-unified-pane").waitFor({ state: "visible" });
  });

  await step("exit-review", async () => {
    await page.getByTestId("review-exit").click();
    await page.getByTestId("sidebar-tab-files").waitFor();
    if ((await page.getByTestId("pr-header").count()) > 0) {
      throw new Error("pr-header still mounted after exit");
    }
  });

  await step("re-enter-review", openReview);

  await step("submit-comment-only", async () => {
    const textarea = page.locator('[data-testid="review-comment"]');
    await textarea.fill("plain comment, no batch");
    await page.getByTestId("review-comment-submit").click();
    await page.waitForTimeout(500);
  });

  // ----- Author flow: meri (cannot review own change) --------------------
  await step("login-meri", () => loginAs("meri"));
  await step("meri-enter-review", openReview);

  await step("meri-approve-disabled", async () => {
    if (!(await page.getByTestId("review-approve").isDisabled())) {
      throw new Error("meri (author) can click Approve!");
    }
  });

  await step("meri-no-gutter", async () => {
    const n = await page.locator('[data-testid^="comment-add-"]').count();
    if (n > 0) throw new Error(`meri sees ${n} gutter add buttons`);
  });

  await step("meri-textarea-disabled", async () => {
    if (!(await page.getByTestId("review-comment").isDisabled())) {
      throw new Error("meri can use the comment textarea");
    }
  });

  await step("meri-no-edit-on-others", async () => {
    const n = await page.locator('[data-testid^="comment-edit-"]').count();
    if (n > 0) throw new Error(`meri sees ${n} edit buttons on others' comments`);
  });

  console.log("\n*** ALL CHECKS PASSED ***");
} catch (err) {
  exitCode = 1;
  console.log("\nstage:", stage);
  console.log("error:", err instanceof Error ? err.stack : String(err));
} finally {
  if (errorSink.length) console.log("\nPAGE ERRORS:\n" + errorSink.join("\n"));
  const noisy = consoleSink.filter(
    (l) => !l.includes("React DevTools") && !l.includes("vite]") && l.includes("[error]"),
  );
  if (noisy.length) console.log("\nCONSOLE:\n" + noisy.slice(0, 30).join("\n"));
  if (badResponseSink.length) {
    const real = badResponseSink.filter((l) => !l.includes("/api/v1/me") || !l.includes("401"));
    if (real.length) console.log("\nBAD RESPONSES:\n" + real.slice(0, 20).join("\n"));
  }
  await browser.close();
  process.exit(exitCode);
}
