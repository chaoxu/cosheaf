import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { expect, type Page, test } from "@playwright/test";
import { defaultWebUrl } from "../../scripts/lib/env-dev.mjs";
import { ensureSignedIn } from "./auth";

const webBase = defaultWebUrl();
const repoBase = `${webBase}/chao/flushing-coin`;

async function signIn(page: Page): Promise<void> {
  await ensureSignedIn(page, webBase);
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

test("document rail reaches the status bar in workbench read and edit modes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/hello.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.locator(".coflat-reader-island")).toHaveCount(0);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await expectRailBottomAligned(page);

  await page.goto(`${repoBase}/src/branch/main/hello.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectRailBottomAligned(page);
});

test("workbench actions remain visible when the document rail is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/fixtures/side-by-side-rendering/hello.md?mode=read`);
  await expect(page.locator(".doc-reader-chrome")).toHaveCount(0);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await expect(page.locator(".doc-rail")).not.toBeVisible();

  await page.goto(`${repoBase}/src/branch/fixtures/side-by-side-rendering/hello.md?mode=edit`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectEditorStatusbarContained(page);
  const mobileActions = page.locator(".web-editor-mobile-actions");
  await expect(mobileActions.getByRole("button", { name: "Open PR" })).toBeVisible();
  await expect(mobileActions.getByRole("button", { name: "Merge to main" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 900 });
  await expectEditorStatusbarContained(page);
});
