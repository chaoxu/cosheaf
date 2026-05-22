import type { Page } from "@playwright/test";

// loginAs drives the SPA login form. The React handler stores the returned
// PAT in localStorage under "cosheaf.pat" (see src/cosheaf/api.ts
// setStoredPat / login), which is what authorizes every subsequent
// authHeaders()-wrapped fetch from the page — including page.evaluate
// fetches that callers may run later. Callers that need raw API access
// without a SPA session should use createPrAsMeri-style explicit Bearer
// tokens instead.
export async function loginAs(page: Page, username: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("cosheaf.pat"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const inputs = page.locator("form input");
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await page.getByTestId("workspace-flushing-coin").waitFor({ state: "visible" });
  await page.getByTestId("workspace-flushing-coin").click();
}

export async function openReview(page: Page, expectMarker = "Pythagoras") {
  await page.getByTestId("sidebar-tab-inbox").click();
  // Open the seeded demo PR specifically (title "e2e demo PR") rather than
  // the first row, so this is stable when other tests have left fresher PRs
  // at the top of the pull request list.
  const demo = page.locator('[data-testid^="review-pull-"]', { hasText: "e2e demo PR" }).first();
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
  // Post-#63 auth: log in to grab a PAT and send it as Bearer on every
  // subsequent fetch. We don't touch localStorage here because these are raw
  // API drivers, not the SPA — callers that need an authed SPA session
  // should use loginAs(page, ...) which goes through the UI.
  await page.goto("/");
  const pat = await page.evaluate(async () => {
    const r = await fetch("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "meri", password: "Cosheaf123!" }),
    });
    if (!r.ok) throw new Error(`login meri: ${r.status}`);
    const body = (await r.json()) as { pat: string };
    return body.pat;
  });
  const fileName = `e2e-${Date.now()}.md`;
  const branch = `user/meri/e2e-${Date.now()}`;
  const result = await page.evaluate(
    async ({ name, br, token }) => {
      const r = await fetch(
        `/api/v1/w/flushing-coin/file?path=${name}&branch=${encodeURIComponent(br)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            content:
              "# Pythagoras\n\nIn a right triangle, a^2 + b^2 = c^2.\n\nProof: similar triangles.\n",
          }),
        },
      );
      return { status: r.status, body: await r.text() };
    },
    { name: fileName, br: branch, token: pat },
  );
  if (result.status !== 200) throw new Error(`putFile: ${result.status} ${result.body.slice(0, 200)}`);

  const pub = await page.evaluate(
    async ({ br, token }) => {
      const r = await fetch("/api/v1/w/flushing-coin/pulls", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ head: br, title: "e2e PR" }),
      });
      return { status: r.status, body: await r.text() };
    },
    { br: branch, token: pat },
  );
  if (pub.status !== 201) throw new Error(`openPull: ${pub.status} ${pub.body.slice(0, 200)}`);
  const { number: prNumber } = JSON.parse(pub.body);
  return { branch, prNumber };
}
