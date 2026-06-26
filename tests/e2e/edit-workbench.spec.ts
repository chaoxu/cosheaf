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

async function apiPat(page: Page): Promise<string> {
  const cookie = (await page.context().cookies(webBase)).find((entry) => entry.name === "cosheaf_pat");
  expect(cookie?.value).toBeTruthy();
  return cookie?.value ?? "";
}

async function waitForHydratedReader(page: Page): Promise<void> {
  await expect(page.locator(".coflat-reader-island[data-reader-hydrated='1']").first()).toBeVisible();
}

async function visibleShowcaseImageStats(page: Page): Promise<{ y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const img = [...document.images].find((candidate) =>
      !candidate.closest("[hidden]") && (candidate.currentSrc || candidate.src).includes("hover-preview-figure")
    );
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return { y: rect.y, width: rect.width, height: rect.height };
  });
}

async function visibleCenterSourceRange(page: Page): Promise<{ from: string | null; to: string | null; text: string }> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-edit-shell] .cm-scroller")
      ?? document.querySelector<HTMLElement>(".app-content");
    if (!scroller) return { from: null, to: null, text: "" };
    const rect = scroller.getBoundingClientRect();
    const sampleY = rect.top + rect.height / 2;
    let carrier: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestHeight = -1;
    for (const candidate of scroller.querySelectorAll<HTMLElement>("[data-source-from][data-source-to]")) {
      const display = getComputedStyle(candidate).display;
      if (display === "inline") continue;
      const box = candidate.getBoundingClientRect();
      if (box.bottom < rect.top || box.top > rect.bottom) continue;
      const distance = box.top <= sampleY && box.bottom >= sampleY
        ? 0
        : Math.min(Math.abs(box.top - sampleY), Math.abs(box.bottom - sampleY));
      const height = Math.max(0, box.height);
      if (distance < bestDistance || (distance === bestDistance && height > bestHeight)) {
        carrier = candidate;
        bestDistance = distance;
        bestHeight = height;
      }
    }
    return {
      from: carrier?.getAttribute("data-source-from") ?? null,
      to: carrier?.getAttribute("data-source-to") ?? null,
      text: (carrier?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  });
}

async function expectWorkbenchReadOnly(page: Page, readOnly: boolean): Promise<void> {
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect.poll(async () =>
    page.locator(`${CF.editorContent}.cm-content`).evaluate((element) => element.getAttribute("contenteditable") === "false"),
  ).toBe(readOnly);
}

test("edit workbench read mode mounts the rich editor read-only", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/hello.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.getByTestId("editor")).toContainText("Hello");
  await expect(page.locator('script[src*="web-edit-shell"]')).toHaveCount(1);
  await expect(page.locator('script[src*="web-reader"]')).toHaveCount(0);
  await expectWorkbenchReadOnly(page, true);
  await expect(page.locator(".edit-primary-mode button.active")).toHaveText("Read");
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
  await expect(page.getByTestId("editor-path-input")).toBeDisabled();
  await expect(page.getByTestId("editor-path-pencil")).toBeDisabled();
  await expect(page.locator(".doc-rail .doc-view-controls")).toHaveCount(0);
  await expect(page.locator(".status-editor-slot > :last-child")).toHaveAttribute("data-edit-primary-mode", "");

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expectWorkbenchReadOnly(page, false);
  await expect(page.locator(".edit-primary-mode button.active")).toHaveText("Edit");
  await expect(page.getByRole("button", { name: "Rich" })).toBeVisible();
  await expect(page.getByTestId("editor-upload-asset")).toBeVisible();
  await expect(page.getByTestId("editor-path-input")).toBeEnabled();
  await expect(page.getByTestId("editor-path-pencil")).toBeEnabled();
  await expect(page.locator(".status-editor-slot > :last-child")).toHaveAttribute("data-edit-primary-mode", "");

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toContainText("Hello");
  await expectWorkbenchReadOnly(page, true);
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
  await expect(page.getByTestId("editor-path-input")).toBeDisabled();
  await expect(page.getByTestId("editor-path-pencil")).toBeDisabled();
});

test("rich editor keeps fenced div opener editable while adding a label", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  const branch = `user/chao/issue-225-fenced-${Date.now()}`;
  const path = "issue-225-fenced.md";
  const pat = await apiPat(page);
  const put = await page.request.put(
    `${webBase}/api/v1/repos/chao/flushing-coin/file?path=${path}&branch=${encodeURIComponent(branch)}`,
    {
      headers: { authorization: `Bearer ${pat}` },
      data: {
        content: [
          "# Fenced Div Regression",
          "",
          "::: {.lemma}",
          "some lemma",
          ":::",
          "",
        ].join("\n"),
      },
    },
  );
  expect(put.ok()).toBe(true);

  await page.goto(`${repoBase}/src/branch/${branch}/${path}?mode=edit&edit_branch=${encodeURIComponent(branch)}`);
  await expect(page.getByTestId("editor")).toBeVisible();
  const header = page.locator(CF.editorContent).locator(CF.blockHeaderRendered, { hasText: "Lemma" }).first();
  await expect(header).toBeVisible();

  await header.click();
  await expect(page.locator(CF.editorContent)).toContainText("::: {.lemma}");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(" #l");

  await expect(page.locator(CF.editorContent)).toContainText("::: {.lemma #l}");
  await expect(page.locator(CF.editorContent).locator(CF.blockHeaderRendered, { hasText: "Lemma" })).toHaveCount(0);
});

test("edit workbench read mode remains scrollable after switching from edit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit`);
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
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectWorkbenchReadOnly(page, true);

  await expect.poll(async () => page.locator("#web-editor-root .cm-scroller").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const scrollState = await page.locator("#web-editor-root .cm-scroller").evaluate((element) => {
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });

  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
});

test("edit workbench first read switch preserves the editor source anchor", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 520 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.58);
  });
  await page.waitForTimeout(250);
  const before = await visibleCenterSourceRange(page);
  expect(before.from).not.toBeNull();
  expect(before.from).not.toBe("0");
  const beforeFrom = Number(before.from);
  expect(Number.isFinite(beforeFrom)).toBe(true);

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectWorkbenchReadOnly(page, true);
  await expect.poll(async () => {
    const after = await visibleCenterSourceRange(page);
    const afterFrom = Number(after.from);
    const afterTo = Number(after.to);
    return Number.isFinite(afterFrom) && Number.isFinite(afterTo)
      && afterFrom <= beforeFrom && beforeFrom <= afterTo;
  }, {
    message: "workbench read mode should keep the source position that was centered in the editor",
  }).toBe(true);
});

test("edit workbench keeps source anchor stable across repeated read edit switches", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit&source_from=3440&source_to=3476`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator('[data-edit-shell] .cm-scroller [data-source-from="3440"][data-source-to="3476"]').first()).toBeVisible();
  await expectWorkbenchReadOnly(page, true);

  await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
    from: "3440",
    to: "3476",
  });

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await page.waitForTimeout(120);
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
    from: "3440",
    to: "3476",
  });

  for (let index = 0; index < 2; index += 1) {
    await page.locator('.edit-primary-mode button:has-text("Edit")').click();
    await expectWorkbenchReadOnly(page, false);
    await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
      from: "3440",
      to: "3476",
    });
    await page.locator('.edit-primary-mode button:has-text("Read")').click();
    await expectWorkbenchReadOnly(page, true);
    await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
      from: "3440",
      to: "3476",
    });
  }
});

test("edit workbench preserves deep source anchors when switching back to read", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit&source_from=3958&source_to=3972`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectWorkbenchReadOnly(page, true);
  await expect.poll(async () => {
    const range = await visibleCenterSourceRange(page);
    const from = Number(range.from);
    const to = Number(range.to);
    return Number.isFinite(from) && Number.isFinite(to) && from <= 3958 && 3958 <= to;
  }).toBe(true);

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expectWorkbenchReadOnly(page, false);
  const editAnchor = await visibleCenterSourceRange(page);
  const editAnchorFrom = Number(editAnchor.from);
  expect(Number.isFinite(editAnchorFrom)).toBe(true);

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expectWorkbenchReadOnly(page, true);
  await expect.poll(async () => {
    const after = await visibleCenterSourceRange(page);
    const afterFrom = Number(after.from);
    const afterTo = Number(after.to);
    return Number.isFinite(afterFrom) && Number.isFinite(afterTo)
      && afterFrom <= editAnchorFrom && editAnchorFrom <= afterTo;
  }, {
    message: "read-only editor should follow the source position that was visible in edit mode",
  }).toBe(true);
});

test("reader selection can open edit mode at the selected source anchor", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md`);
  await expect(page.locator(CF.reader)).toContainText("Coflat Feature Showcase");
  await waitForHydratedReader(page);
  await page.locator(".doc-main").evaluate((element) => {
    const target = [...element.querySelectorAll<HTMLElement>("[data-source-from][data-source-to]")]
      .find((candidate) => candidate.textContent?.includes("Bullet with math"));
    if (!target || !target.firstChild) throw new Error("missing selectable source anchor");
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    target.scrollIntoView({ block: "center" });
    document.dispatchEvent(new Event("selectionchange"));
  });

  await expect(page.getByRole("button", { name: "Edit selection" })).toBeVisible();
  await page.getByRole("button", { name: "Edit selection" }).click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page).toHaveURL(/mode=edit/);
  await expect(page).toHaveURL(/source_from=/);
  await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
    from: "3440",
    to: "3476",
  });
});

test("normal reader edit control opens editor at the current source anchor", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md`);
  await expect(page.locator(CF.reader)).toContainText("Coflat Feature Showcase");
  await waitForHydratedReader(page);
  await page.locator(".app-content").evaluate((element) => {
    const target = [...element.querySelectorAll<HTMLElement>("[data-source-from='3440'][data-source-to='3476']")][0];
    if (!target) throw new Error("missing source anchor");
    target.scrollIntoView({ block: "center" });
  });
  await expect.poll(async () => page.evaluate(() => {
    const target = document.querySelector<HTMLElement>("[data-source-from='3440'][data-source-to='3476']");
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.top > 100 && rect.bottom < window.innerHeight - 100;
  })).toBe(true);

  await page.locator(".doc-view-switch a:has-text('Edit')").click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page).toHaveURL(/mode=edit/);
  await expect(page).toHaveURL(/source_from=3440/);
  await expect.poll(async () => visibleCenterSourceRange(page)).toMatchObject({
    from: "3440",
    to: "3476",
  });
});

test("edit workbench keeps read-only and editable modes anchored on inline images", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);

  await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit&source_from=6363&source_to=6427`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.locator('[data-edit-shell] .cm-scroller [data-source-from="6363"][data-source-to="6427"]').first()).toBeVisible();
  await expectWorkbenchReadOnly(page, true);
  await page.evaluate(() => {
    const img = [...document.images].find((candidate) => (candidate.currentSrc || candidate.src).includes("hover-preview-figure"));
    img?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(700);
  const before = await visibleShowcaseImageStats(page);
  expect(before).not.toBeNull();
  expect(before?.width).toBe(257);
  expect(before?.height).toBe(150);

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expectWorkbenchReadOnly(page, false);
  await expect.poll(async () => visibleShowcaseImageStats(page)).toMatchObject({ width: 257, height: 150 });
  const afterEdit = await visibleShowcaseImageStats(page);
  expect(afterEdit).not.toBeNull();
  expect(Math.abs((afterEdit?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(18);

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toContainText("Links and Images");
  await expectWorkbenchReadOnly(page, true);
  await expect.poll(async () => visibleShowcaseImageStats(page)).toMatchObject({ width: 257, height: 150 });
  const afterRead = await visibleShowcaseImageStats(page);
  expect(afterRead).not.toBeNull();
  expect(Math.abs((afterRead?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(96);
});

test("edit workbench previews unsaved drafts in read mode and refreshes after save", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const branch = `user/chao/workbench-${Date.now()}`;
  const path = `workbench-${Date.now()}.md`;

  await page.goto(`${repoBase}/src/branch/main/${encodeURIComponent(path)}?mode=edit&edit_branch=${encodeURIComponent(branch)}`);
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(CF.editorContent).fill("# Workbench\n\nUnsaved body.\n");

  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toContainText("Unsaved body.");
  await expectWorkbenchReadOnly(page, true);
  await expect(page.locator(".edit-primary-mode")).toHaveClass(/is-dirty/);
  const samePreviewReused = await page.evaluate(async () => {
    const before = document.querySelector(".cm-editor");
    document.querySelector<HTMLElement>('.edit-primary-mode button[data-edit-mode-target="read"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return before === document.querySelector(".cm-editor");
  });
  expect(samePreviewReused).toBe(true);

  await page.locator('.edit-primary-mode button:has-text("Edit")').click();
  await expectWorkbenchReadOnly(page, false);
  await expect(page.locator(CF.editorContent)).toContainText("Unsaved body.");

  await page.locator(CF.editorContent).fill("# Workbench\n\nSaved body.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("statusbar")).toContainText("Saved");
  await page.locator('.edit-primary-mode button:has-text("Read")').click();
  await expect(page.getByTestId("editor")).toContainText("Saved body.");
  await expectWorkbenchReadOnly(page, true);
  await expect(page.locator(".edit-primary-mode")).not.toHaveClass(/is-dirty/);
  await expect(page.getByTestId("editor-upload-asset")).toBeHidden();
});

test("edit workbench keeps compact read and rich line boxes aligned", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  for (const width of [430, 600]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto(`${repoBase}/src/branch/main/coflat-feature-showcase.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit`);
    await expectWorkbenchReadOnly(page, true);
    await expect(page.locator(`${CF.editorContent} .cm-line.cf-doc-paragraph`).first()).toBeVisible();
    const readBox = await page.locator(`${CF.editorContent} .cm-line.cf-doc-paragraph`).first().boundingBox();
    expect(readBox, `read-only editor paragraph at ${width}px`).not.toBeNull();

    for (let i = 0; i < 3; i += 1) {
      await page.locator('.edit-primary-mode button:has-text("Edit")').click();
      await expectWorkbenchReadOnly(page, false);
      await expect(page.locator(`${CF.editorContent} .cm-line.cf-doc-paragraph`).first()).toBeVisible();
      await page.locator('.edit-primary-mode button:has-text("Read")').click();
      await expectWorkbenchReadOnly(page, true);
      await expect(page.locator(`${CF.editorContent} .cm-line.cf-doc-paragraph`).first()).toBeVisible();
    }

    await page.locator('.edit-primary-mode button:has-text("Edit")').click();
    await expectWorkbenchReadOnly(page, false);
    const editBox = await page.locator(`${CF.editorContent} .cm-line.cf-doc-paragraph`).first().boundingBox();
    expect(editBox, `editor paragraph at ${width}px`).not.toBeNull();
    expect(Math.abs((editBox?.width ?? 0) - (readBox?.width ?? 0)), `paragraph width at ${width}px`).toBeLessThanOrEqual(1);
    expect(Math.abs((editBox?.x ?? 0) - (readBox?.x ?? 0)), `paragraph x at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test("standalone read still uses the reader while workbench read uses the editor", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(`${repoBase}/src/branch/main/hello.md`);
  await expect(page.locator(CF.reader)).toContainText("Hello");
  await waitForHydratedReader(page);
  await expect(page.getByTestId("editor")).toHaveCount(0);

  await page.goto(`${repoBase}/src/branch/main/hello.md?mode=read&edit_branch=user%2Fchao%2Fweb-edit`);
  await expect(page.locator(CF.reader)).toHaveCount(0);
  await expect(page.getByTestId("editor")).toContainText("Hello");
  await expectWorkbenchReadOnly(page, true);
});
