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
        const rail = document.querySelector(".doc-rail");
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
