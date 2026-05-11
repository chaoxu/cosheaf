// Browser-level workflow smoke test for the seeded Cosheaf dev fixture.
// Creates a unique page through the UI, verifies publish controls appear, and
// direct-publishes it. Defaults match `pnpm setup:dev`.

import { existsSync } from "node:fs";
import path from "node:path";

const candidates = [
  path.join(process.cwd(), "node_modules/playwright/index.js"),
  "/Users/chaoxu/Library/pnpm/global/5/node_modules/playwright/index.js",
];
const playwrightPath = candidates.find(existsSync);
if (!playwrightPath) {
  console.error("playwright not found; install via `pnpm add -g playwright` and `pnpm exec playwright install chromium`");
  process.exit(1);
}
const { chromium } = (await import(playwrightPath)).default;

const URL = process.env.URL ?? "http://localhost:5173/";
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-flow.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "123123";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const FLOW_PATH = process.env.COSHEAF_FLOW_PATH ?? `smoke-flow-${Date.now()}.md`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];

page.on("console", async (msg) => {
  const args = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => "[unserializable]")));
  consoleMessages.push(`[${msg.type()}] ${msg.text()} | ${JSON.stringify(args).slice(0, 400)}`);
});
page.on("pageerror", (err) => pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? ""}`));
page.on("response", (res) => {
  if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
});

async function textOfTestId(id) {
  return page.getByTestId(id).innerText().catch(() => "");
}

try {
  await page.goto(URL, { waitUntil: "networkidle" });

  if (await page.locator("text=username").count() > 0) {
    const inputs = page.locator("input");
    await inputs.nth(0).fill(USERNAME);
    await inputs.nth(1).fill(PASSWORD);
    await page.locator('button:has-text("Sign in")').click();
  }

  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).waitFor({ state: "visible", timeout: 8000 });
  await page.getByTestId(`workspace-${WORKSPACE_SLUG}`).click();
  await page.getByTestId("new-file-toggle").waitFor({ state: "visible", timeout: 8000 });

  await page.getByTestId("new-file-toggle").click();
  await page.getByTestId("new-file-path").fill(FLOW_PATH);
  await page.keyboard.press("Enter");

  await page.getByTestId(`file-${FLOW_PATH}`).waitFor({ state: "visible", timeout: 12000 });
  await page.waitForURL(`**/w/${WORKSPACE_SLUG}/${FLOW_PATH}`, { timeout: 8000 });
  await page.getByTestId("publish-direct").waitFor({ state: "visible", timeout: 8000 });
  const unpublishedStatus = await textOfTestId("statusbar");
  if (!unpublishedStatus.includes(FLOW_PATH)) {
    throw new Error(`expected created file in statusbar, got: ${unpublishedStatus}`);
  }

  await page.getByTestId("publish-direct").click();
  await page.getByTestId("publish-direct").waitFor({ state: "detached", timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("editor").waitFor({ state: "visible", timeout: 12000 });

  const finalStatus = await textOfTestId("statusbar");
  const editorText = await page.locator(".cm-content").first().innerText().catch(() => "");
  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  const ok = pageErrors.length === 0 && badResponses.length === 0 && finalStatus.includes(FLOW_PATH) && editorText.includes(FLOW_PATH.replace(/\.md$/, ""));
  console.log(JSON.stringify({
    ok,
    url: page.url(),
    path: FLOW_PATH,
    finalStatus,
    editorTextPreview: editorText.slice(0, 300),
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  await page.screenshot({ path: SCREENSHOT, fullPage: false }).catch(() => undefined);
  console.log(JSON.stringify({
    ok: false,
    path: FLOW_PATH,
    error: err instanceof Error ? err.message : String(err),
    consoleSample: consoleMessages.slice(-10),
    badResponses,
    pageErrors,
    screenshot: SCREENSHOT,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
