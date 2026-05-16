import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

export async function loginAs(page: Page, username: string) {
  await page.goto("/");
  await page.evaluate(() => fetch("/api/v1/logout", { method: "POST" })).catch(() => undefined);
  await page.goto("/");
  const inputs = page.locator("form input");
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill("123123");
  await page.locator('button:has-text("Sign in")').click();
  await page.getByTestId("workspace-flushing-coin").waitFor({ state: "visible" });
  await page.getByTestId("workspace-flushing-coin").click();
}

export async function openReview(page: Page, expectMarker = "Pythagoras") {
  await page.getByTestId("sidebar-tab-inbox").click();
  await page.locator('[data-testid^="review-queue-branch-"]').first().click();
  await page.getByTestId("pr-header").waitFor({ state: "visible" });
  // Default mode/shape lands on Source + Unified.
  await page.getByTestId("view-mode-source").click();
  await page.getByTestId("view-shape-unified").click();
  await page.getByTestId("diff-pane-unified").waitFor({ state: "visible" });
  await page
    .locator(`[data-testid="diff-pane-unified"] >> text=${expectMarker}`)
    .first()
    .waitFor({ timeout: 8000 });
}

export async function createPrAsMeri(page: Page): Promise<{ changeId: string; prNumber: number }> {
  // Drive the API through the page's origin (Vite proxies /api → 3030).
  await page.goto("/");
  await page.evaluate(async () => {
    await fetch("/api/v1/logout", { method: "POST" });
    await fetch("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "meri", password: "123123" }),
    });
  });
  const fileName = `e2e-${Date.now()}.md`;
  const result = await page.evaluate(async (name) => {
    const r = await fetch(`/api/v1/w/flushing-coin/file?path=${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content:
          "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n",
      }),
    });
    return { status: r.status, body: await r.text() };
  }, fileName);
  if (result.status !== 200) throw new Error(`putFile: ${result.status} ${result.body.slice(0, 200)}`);
  const { change_id } = JSON.parse(result.body);
  const pub = await page.evaluate(async (id) => {
    const r = await fetch(`/api/v1/w/flushing-coin/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_id: id, mode: "review" }),
    });
    return { status: r.status, body: await r.text() };
  }, change_id);
  if (pub.status !== 200) throw new Error(`publish: ${pub.status} ${pub.body.slice(0, 200)}`);
  const { pr_number } = JSON.parse(pub.body);
  return { changeId: change_id, prNumber: pr_number };
}

export function changeStateInDb(changeId: string): string {
  const out = spawnSync("sqlite3", [
    "/Users/chaoxu/playground/mathhub/db.sqlite",
    `SELECT state FROM changes WHERE id='${changeId}';`,
  ]);
  return String(out.stdout).trim();
}
