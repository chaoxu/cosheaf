// Shared Playwright bootstrap for the cosheaf browser smoke scripts.

import { existsSync } from "node:fs";
import path from "node:path";
import { defaultWebUrl, serverPort, vitePort } from "./lib/env-dev.mjs";

const candidates = [
  "@playwright/test",
  path.join(process.cwd(), "node_modules/playwright/index.js"),
];

export async function loadChromium() {
  for (const candidate of candidates) {
    if (candidate.startsWith("@") || existsSync(candidate)) {
      try {
        const mod = await import(candidate);
        const chromium = mod.chromium ?? mod.default?.chromium;
        if (!chromium) {
          throw new Error(`${candidate} did not export chromium`);
        }
        return chromium;
      } catch (error) {
        void error;
        // Try the next candidate so older checkouts still get a useful error.
      }
    }
  }
  {
    console.error("playwright not found; run `pnpm install` and `pnpm exec playwright install chromium`");
    process.exit(1);
  }
}

export function attachPageListeners(page, { label = "", consoleSink, errorSink, badResponseSink }) {
  const tag = label ? `[${label}]` : "";
  const onConsole = async (msg) => {
    const args = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => "[unserializable]")));
    consoleSink.push(`${tag}[${msg.type()}] ${msg.text()} | ${JSON.stringify(args).slice(0, 400)}`);
  };
  const onPageError = (err) => errorSink.push(`${tag} ${err.name}: ${err.message}\n${err.stack ?? ""}`);
  const onResponse = (res) => {
    if (res.status() >= 400) badResponseSink.push(`${tag} ${res.status()} ${res.url()}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("response", onResponse);
  };
}

export function browserAppUrl(env = process.env) {
  return optionalEnv(env.URL) ?? `${defaultWebUrl(env)}/`;
}

export function browserWebUrl(env = process.env) {
  return serverRenderedOrigin(browserAppUrl(env), env);
}

export function serverRenderedOrigin(value, env = process.env) {
  const url = new URL(value);
  const viteDevPort = vitePort(env);
  const apiPort = serverPort(env);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if ((hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") && url.port === viteDevPort) {
    url.port = apiPort;
  }
  return url.toString();
}

function optionalEnv(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function signInIfNeeded(page, username, password) {
  if ((await page.locator("text=username").count()) > 0) {
    const inputs = page.locator("input");
    await inputs.nth(0).fill(username);
    await inputs.nth(1).fill(password);
    await page.locator('button:has-text("Sign in")').click();
  }
}
