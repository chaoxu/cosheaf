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
  // Open the seeded demo PR specifically (title "e2e demo PR") rather than
  // the first row, so this is stable when other tests have left fresher PRs
  // at the top of the queue.
  const demo = page.locator('[data-testid^="review-queue-pull-"]', { hasText: "e2e demo PR" }).first();
  await demo.waitFor({ state: "visible" });
  await demo.click();
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

export async function createPrAsMeri(page: Page): Promise<{ branch: string; prNumber: number }> {
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
  const branch = `user/cs-meri/e2e-${Date.now()}`;
  const result = await page.evaluate(
    async ({ name, br }) => {
      const r = await fetch(
        `/api/v1/w/flushing-coin/file?path=${name}&branch=${encodeURIComponent(br)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content:
              "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n",
          }),
        },
      );
      return { status: r.status, body: await r.text() };
    },
    { name: fileName, br: branch },
  );
  if (result.status !== 200) throw new Error(`putFile: ${result.status} ${result.body.slice(0, 200)}`);

  const pub = await page.evaluate(async (br) => {
    const r = await fetch("/api/v1/w/flushing-coin/pulls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ head: br, title: "e2e PR" }),
    });
    return { status: r.status, body: await r.text() };
  }, branch);
  if (pub.status !== 201) throw new Error(`openPull: ${pub.status} ${pub.body.slice(0, 200)}`);
  const { number: prNumber } = JSON.parse(pub.body);
  return { branch, prNumber };
}
