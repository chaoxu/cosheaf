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
// Verify rich-mode rendering: the typora-style ViewPlugins replace the
// markdown source with a rendered title widget and inline heading. The
// stub @codemirror/lang-markdown editor never produced these classes.
await page.waitForSelector(".cm-content .cf-doc-title", { timeout: 5000 });
const docTitle = await page.textContent(".cm-content .cf-doc-title");
console.log("rich doc-title widget:", docTitle);
if (!docTitle?.toLowerCase().includes("prime")) {
  throw new Error(`expected rich title 'Primes', got '${docTitle}'`);
}
// Switch to source mode and verify frontmatter is now visible.
await page.click('button:has-text("Source")');
await page.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("status: golden") ?? false,
  null,
  { timeout: 5000 },
);
console.log("source mode shows frontmatter");
await page.click('button:has-text("Rich")');

console.log("editing groups.md, save, expect status badge to remain draft");
await page.click('.ws-file-row:has-text("Theorem on Groups")');
await page.waitForSelector(".cm-editor");
// Switch to source mode for deterministic keyboard editing.
await page.click('button:has-text("Source")');
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

// Workflow: submit groups (currently draft) and approve as alice (owner can approve)
console.log("opening Theorem on Groups, submitting, approving");
await page.click('.ws-file-row:has-text("Theorem on Groups")');
await page.waitForFunction(
  () => {
    const el = document.querySelector(".editor-bar");
    return el?.textContent?.includes("groups.md");
  },
  null,
  { timeout: 5000 },
);
const ebHtml = await page.$eval(".editor-bar", (el) => el.innerHTML);
console.log("editor-bar:", ebHtml.replace(/\s+/g, " ").slice(0, 280));
await page.click('button:has-text("Submit")');
await page.waitForFunction(
  () => document.querySelector(".badge-unreviewed") !== null,
  null,
  { timeout: 5000 },
);
await page.click('button:has-text("Approve")');
await page.waitForFunction(
  () =>
    document
      .querySelector(".editor-bar .badge")
      ?.classList.contains("badge-golden") ?? false,
  null,
  { timeout: 5000 },
);
console.log("groups promoted to golden");

// Propose update on the now-golden Groups page.
console.log("creating a proposal");
await page.click('button:has-text("Propose update")');
await page.fill(".propose-form textarea", "# Theorem on Groups (revised)\n\nNew sketch of proof.");
await page.click('button:has-text("Create proposal")');
await page.waitForFunction(
  () => document.querySelector(".muted.small")?.textContent?.includes("proposal created"),
  null,
  { timeout: 5000 },
);

// Open queue, click the proposal, submit + approve
console.log("opening queue");
await page.click('button:has-text("Queue")');
await page.waitForSelector(".queue-panel");
const queueText = await page.textContent(".queue-panel");
console.log("queue text:", queueText?.replace(/\s+/g, " ").slice(0, 120));
if (!queueText?.includes("Proposal for")) {
  console.log("proposal not in queue yet (probably still draft); submitting it");
  await page.click('button:has-text("Files")');
  await page.click('.ws-file-row:has-text("Proposal")');
  await page.waitForFunction(
    () => document.querySelector(".editor-bar")?.textContent?.toLowerCase().includes("proposal"),
    null,
    { timeout: 5000 },
  );
  console.log("opened proposal:", (await page.$eval(".editor-bar", (el) => el.textContent)).slice(0, 80));
  await page.click('button:has-text("Submit")');
  await page.waitForFunction(
    () => document.querySelector(".editor-bar .badge-unreviewed") !== null,
    null,
    { timeout: 5000 },
  );
  console.log("submitted; reopening queue");
  await page.click('button:has-text("Queue")');
  await page.waitForSelector(".queue-panel");
}
await page.click('.queue-panel .ws-file-row:has-text("Proposal")');
await page.waitForFunction(
  () => document.querySelector(".editor-bar")?.textContent?.toLowerCase().includes("proposal"),
  null,
  { timeout: 5000 },
);
const beforeApprove = await page.$eval(".editor-bar", (el) => el.outerHTML);
console.log("editor-bar before approve:", beforeApprove.replace(/\s+/g, " ").slice(0, 300));
await page.click('button:has-text("Approve")');
// Verify via the API that the proposal got archived and target is golden
const cookies2 = await page.context().cookies();
const cookieHeader2 = cookies2.map((c) => `${c.name}=${c.value}`).join("; ");
async function readDocs() {
  const r = await fetch(`${APP_URL}/api/w/demo/documents`, {
    headers: { Cookie: cookieHeader2 },
  });
  return (await r.json()).documents;
}
let docs = [];
for (let i = 0; i < 25; i++) {
  docs = await readDocs();
  const proposal = docs.find((d) => d.type === "proposal" && d.status === "archived");
  if (proposal) break;
  await new Promise((r) => setTimeout(r, 200));
}
const archivedProposal = docs.find((d) => d.type === "proposal" && d.status === "archived");
const goldenGroups = docs.find((d) => d.path.endsWith("groups.md") && d.status === "golden");
if (!archivedProposal) throw new Error("proposal not archived after approval");
if (!goldenGroups) throw new Error("groups page not golden after promotion");
console.log("archived proposal:", archivedProposal.id, "golden target:", goldenGroups.id);

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
