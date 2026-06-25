import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { expect, type Page, test } from "@playwright/test";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";

const webBase = defaultWebUrl();
const repoBase = `${webBase}/chao/flushing-coin`;

async function signIn(page: Page): Promise<void> {
  await page.goto(`${webBase}/login`);
  await page.locator('input[name="username"]').fill("chao");
  await page.locator('input[name="password"]').fill("Cosheaf123!");
  await page.locator('button:has-text("Sign in")').click();
  await expect(page).toHaveURL(`${webBase}/`);
  await page.evaluate(() => {
    localStorage.removeItem("cosheaf:left-rail");
    localStorage.removeItem("cosheaf:right-rail");
    localStorage.setItem("cosheaf:file-open-mode:chao", "edit");
  });
}

test("edit workbench starts as reader and lazy-loads editor on demand", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/_edit?branch=user%2Fchao%2Fweb-edit&mode=read&path=hello.md`);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await expect(page.locator('script[src*="web-edit-shell"]')).toHaveCount(1);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(1);
  await expect(page.locator('script[src*="web-editor"]')).toHaveCount(0);
  await expect(page.locator(".edit-primary-mode button.active")).toHaveText("Read");
  await expect(page.getByTestId("editor-upload-asset")).toHaveCount(0);
  await expect(page.locator(".doc-rail .doc-view-controls")).toHaveCount(0);

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator(".edit-primary-mode button.active")).toHaveText("Edit");
  await expect(page.getByRole("button", { name: "Rich" })).toBeVisible();
  await expect(page.getByTestId("editor-upload-asset")).toBeVisible();

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await expect(page.getByTestId("editor")).toBeHidden();
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
});

test("edit workbench read mode remains scrollable after switching from edit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/_edit?branch=user%2Fchao%2Fweb-edit&mode=edit&path=coflat-feature-showcase.md`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Coflat Feature Showcase");

  const scrollState = await page.locator("[data-edit-read-panel] .doc-main").evaluate((element) => {
    element.scrollTop = 400;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });

  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
});

test("edit workbench confirms dirty read switch and refreshes reader after save", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const branch = `user/chao/workbench-${Date.now()}`;
  const path = `workbench-${Date.now()}.md`;

  await page.goto(`${repoBase}/_edit?branch=${encodeURIComponent(branch)}&mode=edit&path=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(CF.editorContent).fill("# Workbench\n\nUnsaved body.\n");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Discard unsaved changes");
    await dialog.dismiss();
  });
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toBeVisible();

  await page.locator(CF.editorContent).fill("# Workbench\n\nSaved body.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("Saved");
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Saved body.");
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
});
