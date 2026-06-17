#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { defaultWebUrl, loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const baseUrl = defaultWebUrl();
const username = process.env.COSHEAF_DEV_USER ?? "chao";
const password = process.env.COSHEAF_DEV_PASSWORD ?? "Cosheaf123!";
const out = process.env.COSHEAF_STORAGE_STATE ?? ".playwright/cosheaf-chao-state.json";

await mkdir(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(new URL("/login", baseUrl).toString(), { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForURL(new URL("/", baseUrl).toString());
  await page.context().storageState({ path: out });
  console.log(`wrote ${out} for ${username} at ${baseUrl}`);
} finally {
  await browser.close();
}
