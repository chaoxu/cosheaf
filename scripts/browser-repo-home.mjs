// Focused browser smoke for the repository home/files page.

import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();

const WEB_URL = browserWebUrl();
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";
const EXPECTED_CLONE_URL = process.env.COSHEAF_EXPECTED_CLONE_URL;
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-repo-home.png";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { label: "repo-home", consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
await signInIfNeeded(page, USERNAME, PASSWORD);

const repoUrl = new URL(`/${OWNER}/${WORKSPACE_SLUG}`, WEB_URL).toString();
await page.goto(repoUrl, { waitUntil: "domcontentloaded" });

const cloneInput = page.getByLabel("SSH clone URL");
await cloneInput.waitFor({ state: "visible", timeout: 10000 });
const cloneUrl = await cloneInput.inputValue();
const expectedSuffix = `/${OWNER}/${WORKSPACE_SLUG}.git`;
const cloneOk = EXPECTED_CLONE_URL ? cloneUrl === EXPECTED_CLONE_URL : cloneUrl.startsWith("ssh://") && cloneUrl.endsWith(expectedSuffix);

await page.getByTestId("repo-clone").waitFor({ state: "visible", timeout: 10000 });
await page.getByRole("button", { name: "Copy" }).waitFor({ state: "visible", timeout: 10000 });
await page.getByRole("link", { name: "SSH keys" }).waitFor({ state: "visible", timeout: 10000 });
await page.screenshot({ path: SCREENSHOT, fullPage: false });

const ok = cloneOk && pageErrors.length === 0 && badResponses.length === 0;
console.log(JSON.stringify({
  ok,
  url: page.url(),
  cloneUrl,
  expectedCloneUrl: EXPECTED_CLONE_URL ?? null,
  consoleSample: consoleMessages.slice(-10),
  badResponses,
  pageErrors,
  screenshot: SCREENSHOT,
}, null, 2));

await browser.close();
process.exit(ok ? 0 : 1);
