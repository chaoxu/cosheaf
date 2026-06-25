#!/usr/bin/env node

import { attachPageListeners, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const WEB_URL = (process.env.COSHEAF_VERIFY_URL ?? "https://cosheaf.chaoxu.prof").replace(/\/$/, "");
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const STORAGE_STATE = process.env.COSHEAF_STORAGE_STATE;
const PAGE_PATH = process.env.COSHEAF_COGIRTH_EDIT_PATH ?? "/chao/cogirth/src/branch/main/main.md?mode=edit&edit_branch=user%2Fchao%2Fweb-edit";
const EXPECTED = process.env.COSHEAF_COGIRTH_OUTLINE_TEXT ?? "Proof of Theorem 4";
const FORBIDDEN = process.env.COSHEAF_COGIRTH_FORBIDDEN_TEXT ?? "@cor:rank-reduction-from-bounded-gap";
const IS_PROD = new URL(WEB_URL).hostname === "cosheaf.chaoxu.prof";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? (IS_PROD ? undefined : "Cosheaf123!");

if (IS_PROD && !PASSWORD && !STORAGE_STATE) {
  console.error("COSHEAF_SMOKE_PASSWORD or COSHEAF_STORAGE_STATE is required for production Cogirth outline verification");
  process.exit(2);
}

const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STORAGE_STATE });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

try {
  await page.goto(`${WEB_URL}/`, { waitUntil: "domcontentloaded" });
  if (PASSWORD) {
    await signInIfNeeded(page, USERNAME, PASSWORD);
  }
  if (new URL(page.url()).pathname === "/login") {
    throw new Error("not signed in; set COSHEAF_SMOKE_PASSWORD or COSHEAF_STORAGE_STATE for this target");
  }
  await page.goto(`${WEB_URL}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).pathname === "/login") {
    throw new Error("editor redirected to login; credentials or storage state are missing/expired");
  }
  await page.locator(".cm-content").waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".doc-rail-outline").waitFor({ state: "visible", timeout: 15000 });
  const outlineItems = await page.locator(".doc-rail-outline button, .doc-rail-outline a").evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  );
  if (!outlineItems.some((text) => text.includes(EXPECTED))) {
    throw new Error(`Cogirth outline did not include ${JSON.stringify(EXPECTED)}: ${JSON.stringify(outlineItems)}`);
  }
  const forbiddenHits = outlineItems.filter((text) => text.includes(FORBIDDEN));
  if (forbiddenHits.length > 0) {
    throw new Error(`Cogirth outline still exposes raw reference text: ${JSON.stringify(forbiddenHits)}`);
  }
  if (badResponses.length || pageErrors.length) {
    throw new Error(`browser errors: ${JSON.stringify({ badResponses, pageErrors })}`);
  }
  console.log(`Cogirth outline verified at ${WEB_URL}${PAGE_PATH}: ${EXPECTED}`);
} finally {
  await browser.close();
}
