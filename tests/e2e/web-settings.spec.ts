import { expect, type Locator, test } from "@playwright/test";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";

const webBase = defaultWebUrl();
const repoBase = `${webBase}/chao/flushing-coin`;

test("sidebar identity links to profiles and settings gear opens settings", async ({ page }) => {
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);

  const identity = page.locator(".sidebar-identity-link");
  await expect(identity).toContainText("chao");
  await expect(identity).toHaveAttribute("href", "/users/chao");
  await identity.locator(".avatar-chip").click();
  await expect(page).toHaveURL(`${webBase}/users/chao`);
  await expect(page.getByTestId("user-page")).toBeVisible();

  const settingsGear = page.locator(".settings-gear");
  await expect(settingsGear).toHaveAttribute("href", "/account/settings");
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(settingsGear).toBeVisible();
  await settingsGear.click();
  await expect(page).toHaveURL(`${webBase}/account/settings`);
  await expect(settingsGear).toHaveClass(/active/);
});

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

  await expect(page.locator(".sidebar-identity-link")).toHaveAttribute("href", "/users/chao");
  await page.locator(".sidebar-identity-link").click();
  await expect(page).toHaveURL(`${webBase}/users/chao`);
  await expect(page.getByTestId("user-page")).toBeVisible();
  await expect(page.locator(".settings-gear")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.locator(".settings-gear")).toBeVisible();
  await page.locator(".settings-gear").click();
  await expect(page).toHaveURL(`${webBase}/account/settings`);
  await expect(page.locator(".settings-gear")).toHaveClass(/active/);
  await expect(page.getByTestId("settings-user-preferences")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
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

test("username autocomplete opens on every repo username field", async ({ page }) => {
  await page.route("**/chao/flushing-coin/user-suggestions**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ users: ["stargazer"] }),
    });
  });

  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);

  await page.goto(`${repoBase}/settings`);
  await page.locator("details.add-disclosure", { hasText: "Add collaborator" }).locator("summary").click();
  await expectAutocomplete(page.getByTestId("settings-access-username"));

  await page.goto(`${repoBase}/issues`);
  await page.locator("details.filter-advanced > summary").click();
  await expectAutocomplete(page.locator('input[name="created_by"]'));
  await expectAutocomplete(page.locator('input[name="assigned_by"]'));
  await expectAutocomplete(page.locator('input[name="mentioned_by"]'));

  await page.goto(`${repoBase}/pulls`);
  await page.locator("details.filter-advanced > summary").click();
  await expectAutocomplete(page.locator('input[name="author"]'));
});

async function expectAutocomplete(input: Locator) {
  await input.fill("sta");
  const option = input.page().locator(".user-autocomplete-listbox:not([hidden]) .user-autocomplete-option", { hasText: "stargazer" });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toHaveValue("stargazer");
}
