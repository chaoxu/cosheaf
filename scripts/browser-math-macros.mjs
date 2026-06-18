// Browser smoke: repo-wide (cosheaf.yaml) + document-frontmatter KaTeX macros
// actually render (#182/#183). Guards the regression where macros were resolved
// server-side but never forwarded to hydrateMath, so non-builtin macros rendered
// as "undefined control sequence". Deliberately uses NON-builtin macro names —
// \R (a KaTeX builtin) masked this bug in the original verification.

import { attachPageListeners, browserWebUrl, loadChromium, signInIfNeeded } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const chromium = await loadChromium();
const WEB_URL = browserWebUrl();
const SCREENSHOT = process.env.SCREENSHOT ?? "/tmp/cosheaf-browser-math-macros.png";
const USERNAME = process.env.COSHEAF_SMOKE_USER ?? "chao";
const PASSWORD = process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
const OWNER = process.env.COSHEAF_SMOKE_OWNER ?? "chao";
const WORKSPACE_SLUG = process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin";

const TS = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const BRANCH = `smoke-math-${TS}`;
const DOC = `smoke-math-${TS}.md`;
const REPO_CONFIG = "cosheaf.yaml";
// Repo-wide macro (cosheaf.yaml) and a document-frontmatter macro, both non-builtin.
const CONFIG_YAML = "math:\n  \\RepoMac: \\operatorname{RepoMac}\n";
const DOC_SOURCE = [
  "---",
  "title: Macro smoke",
  "math:",
  "  \\DecRank: \\text{Rank-}k\\text{-Reduction}",
  "---",
  "",
  "Frontmatter macro $\\DecRank$ and repo-wide macro $\\RepoMac$ must both expand.",
  "",
].join("\n");

function apiPath(p) {
  return new URL(`/api/v1/repos/${OWNER}/${WORKSPACE_SLUG}${p}`, WEB_URL).toString();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const badResponses = [];
attachPageListeners(page, { consoleSink: consoleMessages, errorSink: pageErrors, badResponseSink: badResponses });

async function jsonReq(method, p, data) {
  const res = await context.request[method](apiPath(p), {
    headers: { "content-type": "application/json", origin: new URL(WEB_URL).origin },
    ...(data ? { data } : {}),
  });
  return res.status();
}

let createdBranch = false;
try {
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await signInIfNeeded(page, USERNAME, PASSWORD);
  await page.getByRole("link", { name: new RegExp(`^${OWNER}/${WORKSPACE_SLUG}\\b`) }).waitFor({ state: "visible", timeout: 10000 });

  const branchStatus = await jsonReq("post", "/branches", { name: BRANCH });
  createdBranch = branchStatus < 300;
  if (!createdBranch) throw new Error(`branch create failed: ${branchStatus}`);
  // Repo config first (so the doc render resolves the repo-wide macro), then the doc.
  const cfgStatus = await jsonReq("put", `/file?path=${encodeURIComponent(REPO_CONFIG)}&branch=${encodeURIComponent(BRANCH)}`, { content: CONFIG_YAML });
  const docStatus = await jsonReq("put", `/file?path=${encodeURIComponent(DOC)}&branch=${encodeURIComponent(BRANCH)}`, { content: DOC_SOURCE });
  if (cfgStatus >= 300 || docStatus >= 300) throw new Error(`file PUT failed: cfg=${cfgStatus} doc=${docStatus}`);

  await page.goto(new URL(`/${OWNER}/${WORKSPACE_SLUG}/src/branch/${BRANCH}/${DOC}`, WEB_URL).toString(), { waitUntil: "domcontentloaded" });
  const reader = page.locator(".coflat-reader-island");
  await reader.locator(".katex").first().waitFor({ state: "visible", timeout: 15000 });

  const katexErrors = await reader.locator(".katex-error, .cf-math-error").count();
  const text = (await reader.innerText()).replace(/\s+/g, " ");
  const decRankExpanded = text.includes("Rank-") && text.includes("Reduction");
  const repoMacExpanded = text.includes("RepoMac");
  const noRawCommands = !text.includes("\\DecRank") && !text.includes("\\RepoMac");

  await page.screenshot({ path: SCREENSHOT, fullPage: false });

  const ok =
    katexErrors === 0 &&
    decRankExpanded &&
    repoMacExpanded &&
    noRawCommands &&
    pageErrors.length === 0 &&
    badResponses.length === 0;
  console.log(JSON.stringify({ ok, branch: BRANCH, katexErrors, decRankExpanded, repoMacExpanded, noRawCommands, sample: text.slice(0, 160), badResponses, pageErrors: pageErrors.slice(0, 5) }, null, 2));
  if (!ok) throw new Error("math macros did not render (KaTeX error or macro not expanded)");

  await jsonReq("delete", `/branches/${encodeURIComponent(BRANCH)}`).catch(() => {});
  await browser.close();
  process.exit(0);
} catch (err) {
  await page.screenshot({ path: SCREENSHOT, fullPage: false }).catch(() => undefined);
  if (createdBranch) await jsonReq("delete", `/branches/${encodeURIComponent(BRANCH)}`).catch(() => {});
  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), url: page.url(), badResponses, pageErrors: pageErrors.slice(0, 5) }, null, 2));
  await browser.close();
  process.exit(1);
}
