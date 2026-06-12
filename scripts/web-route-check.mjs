#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { chromium } from "@playwright/test";

const defaultRoutes = ["/flushing-coin/activity", "/flushing-coin/issues", "/flushing-coin/pulls"];

function collect(value, previous) {
  previous.push(value);
  return previous;
}

const program = new Command("web-route-check")
  .option("--url <url>", "base URL", process.env.COSHEAF_WEB_URL ?? "http://localhost:3030")
  .option("--route <route>", "route to verify; repeatable", collect, [])
  .option("--user <user>", "login user", process.env.COSHEAF_SMOKE_USER ?? "chao")
  .option("--password <password>", "login password")
  .option("--storage-state <path>", "existing Playwright storage state")
  .option("--screenshot-dir <path>", "failure screenshot directory", "test-results/devx-route-check")
  .option("--json", "emit machine-readable JSON", false)
  .parse(normalizeArgv(process.argv));

const opts = program.opts();
const baseUrl = normalizeBaseUrl(opts.url);
const routes = opts.route.length > 0 ? opts.route : defaultRoutes;
const password = opts.password ?? defaultPassword(baseUrl);

const results = [];
let failed = false;

await mkdir(opts.screenshotDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  storageState: opts.storageState,
  viewport: { width: 390, height: 520 },
});
const page = await context.newPage();

try {
  if (!opts.storageState) await login(page, baseUrl, opts.user, password);
  for (const route of routes) {
    const result = await verifyRoute(page, baseUrl, route, opts.screenshotDir);
    results.push(result);
    if (!result.ok) failed = true;
  }
} finally {
  await browser.close();
}

const summary = { ok: !failed, baseUrl, routes: results };
if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}
if (failed) process.exit(1);

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function defaultPassword(url) {
  if (process.env.COSHEAF_SMOKE_PASSWORD) return process.env.COSHEAF_SMOKE_PASSWORD;
  return "Cosheaf123!";
}

async function login(page, base, username, pass) {
  await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded" });
  const formVisible = await page.locator('input[name="username"]').isVisible().catch(() => false);
  if (!formVisible) return;
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(pass);
  await page.locator('button:has-text("Sign in")').click();
  await page.waitForURL(base, { waitUntil: "domcontentloaded", timeout: 10_000 });
}

async function verifyRoute(page, base, route, screenshotDir) {
  const assetFailures = [];
  const consoleErrors = [];
  const onResponse = (response) => {
    const url = response.url();
    if ((url.includes("/assets/") || url.endsWith("/cosheaf-web.css")) && response.status() >= 400) {
      assetFailures.push({ url, status: response.status() });
    }
  };
  const onConsole = (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  page.on("response", onResponse);
  page.on("console", onConsole);

  const checks = [];
  const url = new URL(route, base).toString();
  let screenshot;
  try {
    const response = await page.goto(url, { waitUntil: "networkidle" });
    checks.push(check("http status", response !== null && response.status() < 400, response?.status() ?? "no response"));
    checks.push(await headerScrollCheck(page));
    checks.push(await routeSpecificCheck(page, route));
    checks.push(check("asset responses", assetFailures.length === 0, assetFailures));
    checks.push(check("console errors", consoleErrors.length === 0, consoleErrors));
  } catch (err) {
    checks.push(check("route exception", false, err instanceof Error ? err.message : String(err)));
  } finally {
    page.off("response", onResponse);
    page.off("console", onConsole);
  }

  const ok = checks.every((item) => item.ok);
  if (!ok) {
    screenshot = path.join(screenshotDir, `${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}.png`);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => undefined);
  }
  return { route, url, ok, checks, screenshot };
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

async function headerScrollCheck(page) {
  return page.evaluate(async () => {
    const frame = document.querySelector(".app-frame");
    const statusbar = document.querySelector(".app-statusbar");
    const content = document.querySelector(".app-content");
    if (!frame || !statusbar || !content) {
      return { name: "app shell", ok: false, detail: "missing .app-frame/.app-statusbar/.app-content" };
    }
    const statusbarBefore = statusbar.getBoundingClientRect().top;
    content.scrollTo(0, 300);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const statusbarAfter = statusbar.getBoundingClientRect().top;
    const windowScrolls = document.documentElement.scrollHeight > window.innerHeight + 1;
    content.scrollTo(0, 0);
    return {
      name: "app shell scroll",
      ok: !windowScrolls && Math.round(statusbarAfter) === Math.round(statusbarBefore),
      detail: {
        windowScrolls,
        statusbarBefore: Math.round(statusbarBefore),
        statusbarAfter: Math.round(statusbarAfter),
        contentScrollHeight: content.scrollHeight,
        viewportHeight: window.innerHeight,
      },
    };
  });
}

async function routeSpecificCheck(page, route) {
  if (route.endsWith("/issues")) {
    return visibleCheck(page, '[data-testid="issue-filters"]', "issue filters");
  }
  if (route.endsWith("/pulls")) {
    return visibleCheck(page, '[data-testid="pull-filters"]', "pull filters");
  }
  return check("route-specific controls", true, "none");
}

async function visibleCheck(page, selector, name) {
  const visible = await page.locator(selector).isVisible().catch(() => false);
  return check(name, visible, selector);
}

function printSummary(summary) {
  console.log(`DevX route check: ${summary.baseUrl}`);
  for (const route of summary.routes) {
    console.log(`${route.ok ? "OK" : "FAIL"} ${route.route}`);
    for (const item of route.checks) {
      console.log(`  ${item.ok ? "ok" : "fail"} ${item.name}: ${formatDetail(item.detail)}`);
    }
    if (route.screenshot) console.log(`  screenshot: ${route.screenshot}`);
  }
}

function formatDetail(detail) {
  if (typeof detail === "string" || typeof detail === "number") return String(detail);
  return JSON.stringify(detail);
}
