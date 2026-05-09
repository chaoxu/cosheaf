import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://localhost:5180";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});

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
const fileTexts = await page.$$eval(".ws-file-row", (els) => els.map((e) => e.textContent));
console.log("files:", fileTexts);

console.log("opening hello.md");
await page.click('.ws-file-row:has-text("hello.md")');
await page.waitForSelector(".cm-editor");

const newContent = `# Edited via Playwright + CM6\n\nTimestamp: ${Date.now()}\n`;

await page.click(".cm-content");
await page.keyboard.press("Meta+A");
await page.keyboard.press("Delete");
await page.keyboard.type(newContent);

await page.click('button:has-text("Save")');

await page.waitForFunction(
  () => document.querySelector(".muted.small")?.textContent?.includes("saved"),
  null,
  { timeout: 5000 },
);
console.log("save status:", await page.textContent(".muted.small"));

const cookies = await page.context().cookies();
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const reloaded = await fetch(`${APP_URL}/api/w/demo/note?path=hello.md`, {
  headers: { Cookie: cookieHeader },
});
const json = await reloaded.json();
console.log("server length:", json.content.length, "starts:", JSON.stringify(json.content.slice(0, 50)));

if (!json.content.includes("CM6")) {
  console.error("FAIL: server content missing 'CM6'");
  process.exit(1);
}

if (errors.length > 0) {
  console.error("ERRORS:", errors);
  process.exit(1);
}

await browser.close();
console.log("E2E PASSED");
