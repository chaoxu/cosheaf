import { expect, type Page } from "@playwright/test";

export async function ensureSignedIn(page: Page, webBase: string, username = "chao", password = "Cosheaf123!"): Promise<void> {
  await page.goto(`${webBase}/`);
  if (await page.locator(".sidebar-identity-link", { hasText: username }).isVisible().catch(() => false)) return;
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);
}
