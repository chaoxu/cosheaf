import { expect, test } from "@playwright/test";

const webBase = "http://localhost:3030";
const repoBase = `${webBase}/flushing-coin`;

test("account preferences are separate from project settings", async ({ page }) => {
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);

  await page.getByRole("link", { name: "chao" }).click();
  await expect(page).toHaveURL(`${webBase}/account/settings`);
  await expect(page.getByTestId("settings-user-preferences")).toBeVisible();
  await expect(page.getByTestId("settings-document-theme-select")).toBeVisible();
  await expect(page.getByTestId("settings-diff-mode-select")).toBeVisible();
  await expect(page.getByTestId("settings-diff-shape-select")).toBeVisible();

  await page.goto(`${repoBase}/settings`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Settings");
  await expect(page.getByTestId("settings-user-preferences")).toHaveCount(0);
  await expect(page.locator(".repo-body")).toContainText("Review policy");
  await expect(page.locator(".repo-body")).toContainText("Access");
  await expect(page.getByTestId("settings-access")).toBeVisible();
});
