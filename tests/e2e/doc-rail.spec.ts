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
  });
}

async function expectRailBottomAligned(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const appContent = document.querySelector(".app-content");
        const statusbar = document.querySelector(".app-statusbar");
        const rail = [...document.querySelectorAll<HTMLElement>(".doc-rail")].find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (!appContent || !statusbar || !rail) return null;
        const appRect = appContent.getBoundingClientRect();
        const statusRect = statusbar.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        return {
          appToStatus: Math.round(appRect.bottom - statusRect.top),
          appToRail: Math.round(appRect.bottom - railRect.bottom),
          overflowY: getComputedStyle(rail).overflowY,
        };
      }),
    )
    .toEqual({
      appToStatus: 0,
      appToRail: 0,
      overflowY: "auto",
    });
}

async function expectEditorStatusbarContained(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const footer = document.querySelector(".app-statusbar");
        const slot = document.querySelector(".status-editor-slot");
        if (!footer || !slot) return null;
        const footerRect = footer.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        return {
          pageScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          slotPastFooter: Math.max(0, Math.ceil(slotRect.right - footerRect.right)),
        };
      }),
    )
    .toEqual({
      pageScrollWidth: await page.evaluate(() => window.innerWidth),
      viewportWidth: await page.evaluate(() => window.innerWidth),
      slotPastFooter: 0,
    });
}

test("document rail reaches the status bar in reader and editor modes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/hello.md`);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await expectRailBottomAligned(page);

  await page.goto(`${repoBase}/_edit?branch=main&path=hello.md`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectRailBottomAligned(page);
});

test("branch actions remain visible when the document rail is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/fixtures/side-by-side-rendering/hello.md`);
  const readerChrome = page.locator(".doc-reader-chrome");
  await expect(readerChrome.getByText("More")).toBeVisible();
  await readerChrome.locator("summary").click();
  await expect(readerChrome.getByRole("link", { name: "PDF" })).toBeVisible();
  await expect(readerChrome.getByRole("link", { name: "Raw" })).toBeVisible();
  await expect(readerChrome.getByRole("link", { name: "Open PR" })).toHaveCount(0);

  await page.goto(`${repoBase}/_edit?branch=fixtures%2Fside-by-side-rendering&path=hello.md`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectEditorStatusbarContained(page);
  const mobileActions = page.locator(".web-editor-mobile-actions");
  await expect(mobileActions.getByRole("button", { name: "Open PR" })).toBeVisible();
  await expect(mobileActions.getByRole("button", { name: "Merge to main" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 900 });
  await expectEditorStatusbarContained(page);
});
