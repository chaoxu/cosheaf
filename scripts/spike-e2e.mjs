import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://localhost:5180";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});

// Seed data via direct API calls so the test is self-contained.
async function seed(loginCookie) {
  const headers = { "content-type": "application/json", Cookie: loginCookie };
  await fetch(`${APP_URL}/api/w/demo/note?path=primes.md`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      content: "---\nid: thm-prime\ntype: page\nstatus: golden\n---\n# Primes\n",
    }),
  });
  await fetch(`${APP_URL}/api/w/demo/note?path=algebra/groups.md`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      content: "# Theorem on Groups\n\nReferences [[thm-prime]] and also [primes](../primes.md).",
    }),
  });
}

const loginRes = await fetch(`${APP_URL}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "alice", password: "secret123" }),
});
if (!loginRes.ok) throw new Error(`seed login failed: ${loginRes.status}`);
const setCookie = loginRes.headers.get("set-cookie") ?? "";
const seedCookie = setCookie.split(";")[0];
await seed(seedCookie);

console.log("loading", APP_URL);
await page.goto(APP_URL);
await page.waitForSelector("h1");

console.log("logging in as alice");
await page.fill('input[autocomplete="username"]', "alice");
await page.fill('input[autocomplete="current-password"]', "secret123");
await page.click('button[type="submit"]');

await page.waitForSelector("h2");

console.log("opening demo workspace");
await page.click(".ws-row");
await page.waitForSelector(".ws-files");

await page.waitForFunction(() => document.querySelectorAll(".ws-file-row").length > 0);
const labels = await page.$$eval(".ws-file-row", (els) =>
  els.map((e) => ({
    text: e.textContent,
    title: e.getAttribute("title"),
  })),
);
console.log("file rows:", labels);

if (!labels.some((l) => l.title?.startsWith("id: "))) {
  throw new Error("expected at least one file row with an id title attr");
}

const goldenBadge = await page.$(".badge-golden");
if (!goldenBadge) throw new Error("expected a golden badge in tree");
console.log("golden badge present:", await goldenBadge.textContent());

console.log("opening primes.md (golden)");
await page.click('.ws-file-row:has-text("Primes")');
await page.waitForSelector(".cm-editor");
const primesContent = await page.evaluate(() => {
  const el = document.querySelector(".cm-content");
  return el?.textContent ?? "";
});
console.log("primes content snippet:", JSON.stringify(primesContent.slice(0, 80)));
if (!primesContent.includes("status: golden")) {
  throw new Error("primes.md doesn't show frontmatter status: golden");
}

console.log("editing groups.md, save, expect status badge to remain draft");
await page.click('.ws-file-row:has-text("Theorem on Groups")');
await page.waitForSelector(".cm-editor");
await page.click(".cm-content");
await page.keyboard.press("End");
await page.keyboard.type("\n\nAnother line.");
await page.click('button:has-text("Save")');
await page.waitForFunction(
  () => document.querySelector(".muted.small")?.textContent?.includes("saved"),
  null,
  { timeout: 5000 },
);

await page.waitForFunction(() => document.querySelectorAll(".ws-file-row").length > 0);
const draftBadge = await page.$(".badge-draft");
if (!draftBadge) throw new Error("expected a draft badge after save");
console.log("draft badge present:", await draftBadge.textContent());

console.log("opening primes.md, expecting backlinks from groups");
await page.click('.ws-file-row:has-text("Primes")');
await page.waitForSelector(".cm-editor");
await page.waitForFunction(
  () => document.querySelector(".backlinks-header")?.textContent?.includes("(") ?? false,
  null,
  { timeout: 5000 },
);
const backlinkLabels = await page.$$eval(".backlinks li button", (els) =>
  els.map((e) => e.textContent),
);
console.log("backlinks shown:", backlinkLabels);
if (!backlinkLabels.some((t) => t?.includes("Theorem on Groups"))) {
  throw new Error("expected backlinks to include Theorem on Groups");
}
if (backlinkLabels.length < 2) {
  throw new Error(`expected 2 backlinks (wiki + path), got ${backlinkLabels.length}`);
}

// Search
console.log("searching for 'prime'");
await page.fill(".search-input", "prime");
await page.keyboard.press("Enter");
await page.waitForSelector(".search-results");
const searchTitles = await page.$$eval(".search-results .ws-file-row .file-label strong", (els) =>
  els.map((e) => e.textContent),
);
console.log("search results:", searchTitles);
if (!searchTitles.includes("Primes")) throw new Error("expected Primes in search results");
await page.click('button:has-text("Clear")');

// Tokens
console.log("opening tokens screen");
await page.click('button:has-text("← Workspaces")');
await page.waitForSelector("h2");
await page.click('button:has-text("Tokens")');
await page.waitForSelector('input[placeholder^="token name"]');
await page.fill('input[placeholder^="token name"]', "test-agent");
await page.click('button:has-text("Create token")');
await page.waitForSelector(".token-value");
const tokenValue = await page.textContent(".token-value");
console.log("created token:", tokenValue?.slice(0, 12), "…");
if (!tokenValue?.startsWith("cs_")) throw new Error("token doesn't start with cs_");

// Use the token from a fresh fetch (no cookie) to verify it grants access.
const r = await fetch(`${APP_URL}/api/workspaces`, {
  headers: { Authorization: `Bearer ${tokenValue}` },
});
const wsViaToken = await r.json();
console.log("workspaces via token:", wsViaToken);
if (!wsViaToken.workspaces?.some((w) => w.slug === "demo")) {
  throw new Error("token didn't grant workspace access");
}

if (errors.length > 0) {
  console.error("ERRORS:", errors);
  process.exit(1);
}

await browser.close();
console.log("E2E PASSED (phase 2)");
