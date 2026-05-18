import { expect, test } from "@playwright/test";

// Post-#63 auth: the SPA stores a PAT in localStorage under "cosheaf.pat"
// and sends it as Bearer on every authed fetch. These tests pin the
// surface: login form stores it, reload survives, logout clears it, and
// a bogus PAT bounces the user back to the login form.

const PAT_KEY = "cosheaf.pat";

async function signIn(page: import("@playwright/test").Page, username: string): Promise<void> {
  await page.goto("/");
  const inputs = page.locator("form input");
  await inputs.nth(0).fill(username);
  await inputs.nth(1).fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await page.getByTestId("workspace-flushing-coin").waitFor({ state: "visible" });
}

test.describe.serial("auth surface", () => {
  test("logs in via the form, stashes the PAT in localStorage, and lands on the workspace list", async ({ page }) => {
    await signIn(page, "chao");
    const pat = await page.evaluate((k) => localStorage.getItem(k), PAT_KEY);
    expect(pat, "PAT should be stashed in localStorage").toBeTruthy();
    expect((pat ?? "").length).toBeGreaterThan(0);
    await expect(page.locator('[data-testid^="workspace-"]').first()).toBeVisible();
  });

  test("survives a reload — PAT in localStorage keeps the session", async ({ page }) => {
    await signIn(page, "chao");
    await page.reload();
    await expect(page.getByTestId("workspace-flushing-coin")).toBeVisible();
    // No login form should be back.
    await expect(page.locator('button:has-text("Sign in")')).toHaveCount(0);
  });

  test("logs out and clears the PAT", async ({ page }) => {
    await signIn(page, "chao");
    // The workspace-list topbar has a direct "Sign out" button.
    await page.locator('button:has-text("Sign out")').click();
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible();
    const pat = await page.evaluate((k) => localStorage.getItem(k), PAT_KEY);
    expect(pat).toBeNull();
  });

  test("a forged/expired PAT bounces to login", async ({ page }) => {
    // Seed localStorage before the SPA boots so it picks up the bogus PAT.
    await page.goto("/");
    await page.evaluate(
      ({ k, v }) => localStorage.setItem(k, v),
      { k: PAT_KEY, v: "definitely-not-a-real-pat" },
    );
    await page.reload();
    // api.ts clears the stored PAT and reloads on pat_invalid / unauthorized.
    // End state: login form visible, PAT cleared.
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible({ timeout: 10000 });
    const pat = await page.evaluate((k) => localStorage.getItem(k), PAT_KEY);
    expect(pat).toBeNull();
  });
});
