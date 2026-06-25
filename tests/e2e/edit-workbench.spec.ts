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

async function readerSurfaceScreenshot(page: Page, url: string, scrollRatio = 0): Promise<Buffer> {
  await page.goto(url);
  await expect(page.locator(CF.reader)).toBeVisible();
  await expect.poll(async () => page.locator(CF.reader).evaluate((element) => element.textContent?.trim().length ?? 0)).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await page.locator(".doc-main").evaluate((element, ratio) => {
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.round(max * ratio);
  }, scrollRatio);
  await page.waitForTimeout(150);
  return page.locator(".doc-main").screenshot({ animations: "disabled" });
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
  await expect(page.locator(".status-editor-slot > :last-child")).toHaveAttribute("data-edit-primary-mode", "");

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator(".edit-primary-mode button.active")).toHaveText("Edit");
  await expect(page.getByRole("button", { name: "Rich" })).toBeVisible();
  await expect(page.getByTestId("editor-upload-asset")).toBeVisible();
  await expect(page.locator(".status-editor-slot > :last-child")).toHaveAttribute("data-edit-primary-mode", "");

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
  const editScroll = await page.locator("#web-editor-root .cm-scroller").evaluate((element) => {
    element.scrollTop = Math.max(1, Math.floor((element.scrollHeight - element.clientHeight) * 0.55));
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  expect(editScroll.scrollTop).toBeGreaterThan(0);

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Coflat Feature Showcase");

  await expect.poll(async () => page.locator("[data-edit-read-panel] .doc-main").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrollState = await page.locator("[data-edit-read-panel] .doc-main").evaluate((element) => {
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });

  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
});

test("edit workbench previews unsaved drafts in read mode and refreshes after save", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const branch = `user/chao/workbench-${Date.now()}`;
  const path = `workbench-${Date.now()}.md`;

  await page.goto(`${repoBase}/_edit?branch=${encodeURIComponent(branch)}&mode=edit&path=${encodeURIComponent(path)}`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(CF.editorContent).fill("# Workbench\n\nUnsaved body.\n");

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Unsaved body.");
  await expect(page.getByTestId("editor")).toBeHidden();
  await expect(page.locator(".edit-primary-mode")).toHaveClass(/is-dirty/);
  const samePreviewReused = await page.evaluate(async () => {
    const before = document.querySelector(".coflat-reader-island");
    document.querySelector<HTMLElement>('.edit-primary-mode button[data-edit-mode-target="read"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return before === document.querySelector(".coflat-reader-island");
  });
  expect(samePreviewReused).toBe(true);

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator(CF.editorContent)).toContainText("Unsaved body.");

  await page.locator(CF.editorContent).fill("# Workbench\n\nSaved body.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("Saved");
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.locator(CF.reader)).toContainText("Saved body.");
  await expect(page.locator(".edit-primary-mode")).not.toHaveClass(/is-dirty/);
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
});

test("edit workbench read surface is pixel-identical to the normal reader", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const cases = [
    { viewport: { width: 1280, height: 900 }, path: "hello.md", scrollRatio: 0 },
    { viewport: { width: 1280, height: 900 }, path: "coflat-feature-showcase.md", scrollRatio: 0.52 },
    { viewport: { width: 430, height: 820 }, path: "hello.md", scrollRatio: 0 },
    { viewport: { width: 430, height: 820 }, path: "coflat-feature-showcase.md", scrollRatio: 0.52 },
  ];

  for (const item of cases) {
    await page.setViewportSize(item.viewport);
    const direct = await readerSurfaceScreenshot(page, `${repoBase}/src/branch/main/${item.path}`, item.scrollRatio);
    const workbench = await readerSurfaceScreenshot(
      page,
      `${repoBase}/_edit?branch=main&mode=read&path=${encodeURIComponent(item.path)}`,
      item.scrollRatio,
    );
    expect(Buffer.compare(direct, workbench), `${item.path} ${item.viewport.width}x${item.viewport.height}`).toBe(0);
  }
});
