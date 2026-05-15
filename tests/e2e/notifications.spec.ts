import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe.serial("Notifications inbox", () => {
  test("@mention surfaces in chao's inbox, click opens the issue, mark-all clears", async ({ page }) => {
    // Reset chao's notification state for this workspace so the test is
    // independent of prior runs.
    await loginAs(page, "chao");
    await page.evaluate(() =>
      fetch("/api/v1/w/flushing-coin/notifications/read-all", { method: "POST" }),
    );

    const probeTitle = `Notification probe ${Date.now()}`;
    // meri opens an issue that @-mentions cs-chao. Forgejo creates a
    // notification for chao automatically.
    await loginAs(page, "meri");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill(probeTitle);
    await page
      .getByTestId("new-issue-body")
      .fill("Hey @cs-chao, can you take a look at the Pythagoras sketch?");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible({ timeout: 8000 });

    // chao logs in, opens Inbox, expects the notification row to appear.
    await loginAs(page, "chao");
    await page.getByTestId("sidebar-tab-inbox").click();

    // Forgejo can lag a beat before the notification thread shows up; poll the
    // refresh button until it lands instead of waiting on the 30s background
    // poll.
    const notifRow = page.locator('[data-testid^="notif-"]').first();
    await expect
      .poll(
        async () => {
          if (await notifRow.isVisible().catch(() => false)) return true;
          await page.getByRole("button", { name: "Refresh" }).click().catch(() => undefined);
          return false;
        },
        { timeout: 15_000, intervals: [500, 1000, 1500] },
      )
      .toBe(true);
    await expect(notifRow).toContainText(probeTitle);

    // Section header is visible.
    await expect(page.getByTestId("notifs-section")).toBeVisible();

    // Click navigates to the issue detail.
    await notifRow.click();
    await expect(page.getByTestId("issue-view")).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId("issue-view")).toContainText(probeTitle);

    // Optimistic removal: clicked notification is gone from the list.
    await page.getByTestId("sidebar-tab-inbox").click();
    await expect(page.locator('[data-testid^="notif-"]')).toHaveCount(0, { timeout: 5_000 });

    // Seed another notification so we can test mark-all-read.
    await loginAs(page, "meri");
    await page.getByTestId("sidebar-tab-inbox").click();
    await page.getByTestId("new-issue").click();
    await page.getByTestId("new-issue-title").fill(`Second mention ${Date.now()}`);
    await page
      .getByTestId("new-issue-body")
      .fill("Another ping @cs-chao — confirm the lemma statement.");
    await page.getByTestId("new-issue-submit").click();
    await expect(page.getByTestId("issue-view")).toBeVisible({ timeout: 8000 });

    await loginAs(page, "chao");
    await page.getByTestId("sidebar-tab-inbox").click();
    await expect
      .poll(
        async () => {
          const visible = await page
            .locator('[data-testid^="notif-"]')
            .first()
            .isVisible()
            .catch(() => false);
          if (visible) return true;
          await page.getByRole("button", { name: "Refresh" }).click().catch(() => undefined);
          return false;
        },
        { timeout: 15_000, intervals: [500, 1000, 1500] },
      )
      .toBe(true);

    // mark-all-read empties the list and the button disappears with the section.
    await page.getByTestId("notifs-mark-all-read").click();
    await expect(page.locator('[data-testid^="notif-"]')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("notifs-section")).toHaveCount(0);
    await expect(page.getByTestId("notifs-mark-all-read")).toHaveCount(0);
  });
});
