#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const BUILTIN_FIXTURES = new Map([
  ["milk-pr3-md", "/chao/milk/pulls/3/files?file=milk.md&mode=rich&shape=split"],
  ["milk-pr3-pdf", "/chao/milk/pulls/3/files?file=img%2Fcomplexity.pdf&mode=rich&shape=after"],
  ["flushing-showcase", "/chao/flushing-coin/src/branch/main/coflat-feature-showcase.md"],
]);

const program = new Command("page-rich-check")
  .argument("[target]", "absolute URL, route path, or fixture name")
  .option("--url <url>", "base URL for route/fixture targets", process.env.URL ?? process.env.COSHEAF_STAGING_URL ?? browserWebUrl())
  .option("--fixture <name>", "fixture name; repeatable", collect, [])
  .option("--list-fixtures", "print known fixture names and exit", false)
  .option("--user <user>", "login user", process.env.COSHEAF_SMOKE_USER ?? "chao")
  .option("--password <password>", "login password", process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!")
  .option("--screenshot-dir <dir>", "screenshot output directory", "test-results/page-rich-check")
  .option("--json", "emit only JSON summary", false)
  .option("--allow-unresolved", "do not fail on unresolved rich refs/citations", false)
  .option("--allow-no-changes", "do not fail when a PR file has no step-through changes", false)
  .option("--variant <variant>", "variant to check: current, rich-split, rich-after, source-split; repeatable", collect, [])
  .parse(normalizeArgv(process.argv));

const opts = program.opts();
const envFixtures = parseEnvFixtures(process.env.COSHEAF_PR_RICH_FIXTURES ?? "");
const fixtures = new Map([...BUILTIN_FIXTURES, ...envFixtures]);

if (opts.listFixtures) {
  for (const [name, target] of fixtures) console.log(`${name}\t${target}`);
  process.exit(0);
}

const targets = [...opts.fixture.map((name) => fixtureTarget(fixtures, name))];
if (program.args[0]) targets.push(resolveTarget(fixtures, program.args[0]));
if (targets.length === 0) {
  console.error("usage: pnpm check:pr-rich -- <url|route|fixture>");
  console.error("try: pnpm check:pr-rich -- --list-fixtures");
  process.exit(2);
}

const baseUrl = normalizeBaseUrl(opts.url);
const variants = opts.variant.length > 0 ? opts.variant : ["current", "rich-split", "rich-after", "source-split"];
await mkdir(opts.screenshotDir, { recursive: true });

const chromium = await loadChromium();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

const summary = {
  ok: true,
  baseUrl,
  targets: [],
};

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await signInIfNeeded(page, opts.user, opts.password);

  for (const target of targets) {
    const targetUrl = absoluteUrl(baseUrl, target);
    const result = await checkTarget(page, targetUrl);
    summary.targets.push(result);
    if (!result.ok) summary.ok = false;
  }
} finally {
  await browser.close();
}

if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}
if (!summary.ok) process.exit(1);

function collect(value, previous) {
  previous.push(value);
  return previous;
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseEnvFixtures(value) {
  const out = new Map();
  for (const part of value.split(",")) {
    const [name, ...rest] = part.split("=");
    const target = rest.join("=").trim();
    if (name?.trim() && target) out.set(name.trim(), target);
  }
  return out;
}

function fixtureTarget(fixtures, name) {
  const target = fixtures.get(name);
  if (!target) throw new Error(`unknown fixture ${name}; run --list-fixtures`);
  return target;
}

function resolveTarget(fixtures, target) {
  return fixtures.get(target) ?? target;
}

function absoluteUrl(base, target) {
  return new URL(target, base).toString();
}

function variantUrls(targetUrl) {
  const current = new URL(targetUrl);
  if (!current.pathname.includes("/pulls/") || !current.pathname.endsWith("/files")) {
    return [{ name: "current", url: current.toString() }];
  }
  const byName = new Map();
  for (const variant of variants) {
    const url = new URL(current);
    if (variant === "rich-split") {
      url.searchParams.set("mode", "rich");
      url.searchParams.set("shape", "split");
    } else if (variant === "rich-after") {
      url.searchParams.set("mode", "rich");
      url.searchParams.set("shape", "after");
    } else if (variant === "source-split") {
      url.searchParams.set("mode", "source");
      url.searchParams.set("shape", "split");
    } else if (variant !== "current") {
      throw new Error(`unknown variant ${variant}`);
    }
    byName.set(variant, { name: variant, url: url.toString() });
  }
  return [...byName.values()];
}

async function checkTarget(page, targetUrl) {
  const result = { targetUrl, ok: true, variants: [] };
  for (const variant of variantUrls(targetUrl)) {
    const checked = await checkVariant(page, variant.name, variant.url);
    result.variants.push(checked);
    if (!checked.ok) result.ok = false;
  }

  const sourceCounts = result.variants
    .filter((item) => item.mode === "source")
    .map((item) => item.changeCount)
    .filter((count) => typeof count === "number");
  const richCounts = result.variants
    .filter((item) => item.mode === "rich")
    .map((item) => item.changeCount)
    .filter((count) => typeof count === "number");
  const sourceHasChanges = sourceCounts.some((count) => count > 0);
  const richHasChanges = richCounts.some((count) => count > 0);
  if (!opts.allowNoChanges && sourceHasChanges && !richHasChanges) {
    result.ok = false;
    result.crossVariantIssue = "source mode has step-through changes but rich mode has none";
  }
  return result;
}

async function checkVariant(page, name, url) {
  const consoleMessages = [];
  const pageErrors = [];
  const badResponses = [];
  const detachListeners = attachPageListeners(page, { label: name, consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });
  const screenshot = path.join(opts.screenshotDir, `${safeName(new URL(url).pathname)}-${name}.png`);
  const result = {
    name,
    url,
    ok: true,
    mode: new URL(url).searchParams.get("mode") ?? null,
    shape: new URL(url).searchParams.get("shape") ?? null,
    screenshot,
  };
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    result.httpStatus = response?.status() ?? null;
    await waitForSettledPage(page);
    Object.assign(result, await collectPageMetrics(page));
    await page.screenshot({ path: screenshot, fullPage: false });
    result.consoleErrors = consoleMessages.filter((msg) => msg.includes("[error]"));
    result.pageErrors = pageErrors;
    result.badResponses = badResponses;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => undefined);
  } finally {
    detachListeners();
  }
  result.ok = variantOk(result);
  return result;
}

async function waitForSettledPage(page) {
  const richIsland = page.locator(".coflat-reader-island").first();
  if (await richIsland.count()) {
    await richIsland.waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".coflat-reader-island")]
        .every((el) => el.dataset.readerHydrated === "1"),
      { timeout: 20_000 },
    ).catch(() => undefined);
  }
  await page.waitForTimeout(250);
}

async function collectPageMetrics(page) {
  return page.evaluate((selectors) => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const changeText = text(".diff-change-count");
    const changeMatch = changeText.match(/(?:^|\s)(\d+)\s*\/\s*(\d+)\s+changes?/i);
    const provenance = [...document.querySelectorAll(".coflat-reader-island")].map((el) => ({
      documentRef: el.dataset.renderDocumentRef ?? el.dataset.readerBranch ?? null,
      resourceRef: el.dataset.renderResourceRef ?? null,
      resourceFallbackRefs: el.dataset.renderResourceFallbackRefs ?? null,
      path: el.dataset.renderPath ?? null,
      hydrated: el.dataset.readerHydrated === "1",
    }));
    return {
      title: document.title,
      changeNavText: changeText,
      changeCount: changeMatch ? Number(changeMatch[2]) : (changeText.includes("No changes") ? 0 : null),
      unresolvedCrossrefs: document.querySelectorAll(selectors.unresolvedCrossref).length,
      unresolvedCitations: document.querySelectorAll(selectors.unresolvedCitation).length,
      mathErrors: document.querySelectorAll(selectors.mathError).length,
      citations: document.querySelectorAll(selectors.citation).length,
      bibliographyEntries: document.querySelectorAll(selectors.bibliographyEntry).length,
      readerIslands: document.querySelectorAll(".coflat-reader-island").length,
      hydratedReaderIslands: document.querySelectorAll(".coflat-reader-island[data-reader-hydrated='1']").length,
      provenance,
    };
  }, CF);
}

function variantOk(result) {
  if (result.error) return false;
  if (result.httpStatus !== null && result.httpStatus >= 400) return false;
  if (result.badResponses?.length) return false;
  if (result.pageErrors?.length) return false;
  if (result.consoleErrors?.length) return false;
  const rich = result.readerIslands > 0 || result.mode === "rich";
  if (!opts.allowUnresolved && rich && ((result.unresolvedCrossrefs ?? 0) > 0 || (result.unresolvedCitations ?? 0) > 0)) return false;
  if (!opts.allowNoChanges && result.url.includes("/pulls/") && result.url.includes("/files") && result.changeCount === 0) return false;
  return true;
}

function safeName(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "page";
}

function printSummary(data) {
  console.log(`Page rich check: ${data.ok ? "OK" : "FAIL"} ${data.baseUrl}`);
  for (const target of data.targets) {
    console.log(`${target.ok ? "OK" : "FAIL"} ${target.targetUrl}`);
    if (target.crossVariantIssue) console.log(`  fail ${target.crossVariantIssue}`);
    for (const item of target.variants) {
      console.log(`  ${item.ok ? "OK" : "FAIL"} ${item.name} ${item.mode ?? "default"}/${item.shape ?? "default"}`);
      console.log(`    changes: ${item.changeNavText || "n/a"}`);
      console.log(`    unresolved: refs=${item.unresolvedCrossrefs ?? "?"} citations=${item.unresolvedCitations ?? "?"} math=${item.mathErrors ?? "?"}`);
      if (item.provenance?.length) console.log(`    provenance: ${JSON.stringify(item.provenance)}`);
      if (item.badResponses?.length) console.log(`    bad responses: ${JSON.stringify(item.badResponses)}`);
      if (item.consoleErrors?.length) console.log(`    console errors: ${JSON.stringify(item.consoleErrors)}`);
      if (item.error) console.log(`    error: ${item.error}`);
      console.log(`    screenshot: ${item.screenshot}`);
    }
  }
}
