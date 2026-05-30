// Shared Playwright bootstrap for the cosheaf browser smoke scripts.

import { existsSync } from "node:fs";
import path from "node:path";

const candidates = [
  path.join(process.cwd(), "node_modules/playwright/index.js"),
];

export async function loadChromium() {
  const playwrightPath = candidates.find(existsSync);
  if (!playwrightPath) {
    console.error("playwright not found; install via `pnpm add -g playwright` and `pnpm exec playwright install chromium`");
    process.exit(1);
  }
  return (await import(playwrightPath)).default.chromium;
}

export function attachPageListeners(page, { label = "", consoleSink, errorSink, badResponseSink }) {
  const tag = label ? `[${label}]` : "";
  page.on("console", async (msg) => {
    const args = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => "[unserializable]")));
    consoleSink.push(`${tag}[${msg.type()}] ${msg.text()} | ${JSON.stringify(args).slice(0, 400)}`);
  });
  page.on("pageerror", (err) => errorSink.push(`${tag} ${err.name}: ${err.message}\n${err.stack ?? ""}`));
  page.on("response", (res) => {
    if (res.status() >= 400) badResponseSink.push(`${tag} ${res.status()} ${res.url()}`);
  });
}

export async function signInIfNeeded(page, username, password) {
  if ((await page.locator("text=username").count()) > 0) {
    const inputs = page.locator("input");
    await inputs.nth(0).fill(username);
    await inputs.nth(1).fill(password);
    await page.locator('button:has-text("Sign in")').click();
  }
}
