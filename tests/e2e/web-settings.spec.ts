import { expect, test } from "@playwright/test";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";

const webBase = defaultWebUrl();
const repoBase = `${webBase}/chao/flushing-coin`;

test("account preferences are separate from repository settings", async ({ page }) => {
  const css = await page.request.get(`${webBase}/cosheaf-web.css`);
  expect(css.ok()).toBe(true);
  const preferencesJs = await page.request.get(`${webBase}/cosheaf-preferences.js`);
  expect(preferencesJs.ok()).toBe(true);
  const diffDefaultsJs = await page.request.get(`${webBase}/cosheaf-pr-diff-defaults.js`);
  expect(diffDefaultsJs.ok()).toBe(true);
  const favicon = await page.request.get(`${webBase}/favicon.svg`);
  expect(favicon.ok()).toBe(true);

  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);

  await page.locator(".sidebar-identity-link").click();
  await expect(page).toHaveURL(`${webBase}/account/settings`);
  await expect(page.getByTestId("settings-user-preferences")).toBeVisible();
  await expect(page.getByTestId("settings-document-theme-select")).toBeVisible();
  await expect(page.getByTestId("settings-file-labels-select")).toBeVisible();
  await expect(page.getByTestId("settings-diff-mode-select")).toBeVisible();
  await expect(page.getByTestId("settings-diff-shape-select")).toBeVisible();

  await page.goto(`${repoBase}/settings`);
  await expect(page.locator(".repo-tabs a.active")).toHaveText("Settings");
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(0);
  await expect(page.locator('link[href*="/vendor/coflat/"]')).toHaveCount(0);
  await expect(page.getByTestId("settings-user-preferences")).toHaveCount(0);
  await expect(page.locator(".repo-body")).toContainText("Review policy");
  await expect(page.locator(".repo-body")).toContainText("Access");
  await expect(page.getByTestId("settings-access")).toHaveCount(1);

  await page.goto(`${repoBase}/src/branch/main/hello.md`);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(1);
  await expect(page.locator('link[href*="/vendor/coflat/"]')).not.toHaveCount(0);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md`);
  await expect(page.locator(".cf-doc-block--theorem .cf-block-header-rendered").filter({ hasText: "Theorem 1" }).first()).toBeVisible();
  await expect(
    page.locator(".cf-doc-block--theorem .cf-block-attr-title").filter({ hasText: "Hover Preview Stress Test" }).first(),
  ).toBeVisible();
  await expect(page.locator(".cf-doc-block--theorem > .cf-block-header")).toHaveCount(0);
  const showcaseImage = page.locator('img[src*="/raw/branch/main/showcase/hover-preview-figure.svg"]').first();
  await expect(showcaseImage).toBeVisible();
  const showcaseImageSrc = await showcaseImage.getAttribute("src");
  expect(showcaseImageSrc).toBeTruthy();
  const showcaseImageResponse = await page.request.get(new URL(showcaseImageSrc ?? "", webBase).toString());
  expect(showcaseImageResponse.ok()).toBe(true);
  expect(showcaseImageResponse.headers()["content-type"]).toContain("image/svg+xml");
});
