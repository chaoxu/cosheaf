import { chromium } from "playwright";

const APP_URL = "http://localhost:5180";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});

console.log("loading", APP_URL);
await page.goto(APP_URL);
await page.waitForSelector("h1", { timeout: 5000 });
console.log("title:", await page.title());
console.log("h1:", await page.textContent("h1"));

console.log("logging in as alice");
await page.fill('input[autocomplete="username"]', "alice");
await page.fill('input[autocomplete="current-password"]', "secret123");
await page.click('button[type="submit"]');

await page.waitForSelector("h2", { timeout: 5000 });
console.log("h2:", await page.textContent("h2"));

console.log("opening demo workspace");
await page.click(".ws-row");
await page.waitForSelector(".ws-files", { timeout: 5000 });

const fileTexts = await page.$$eval(".ws-file-row", (els) => els.map((e) => e.textContent));
console.log("files in tree:", fileTexts);

console.log("opening hello.md");
await page.click('.ws-file-row:has-text("hello.md")');
await page.waitForSelector("textarea.note-editor", { timeout: 5000 });
const initial = await page.inputValue("textarea.note-editor");
console.log("loaded length:", initial.length);

const newContent = `# Edited via Playwright\n\nTimestamp: ${Date.now()}\n`;
await page.fill("textarea.note-editor", newContent);
await page.click('button:has-text("Save")');

await page.waitForFunction(
  () => document.querySelector(".muted.small")?.textContent?.includes("saved"),
  null,
  { timeout: 5000 },
);
console.log("save status:", await page.textContent(".muted.small"));

const reloaded = await fetch(`${APP_URL}/api/w/demo/note?path=hello.md`, {
  headers: { Cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
});
const reloadedJson = await reloaded.json();
console.log("server now has length:", reloadedJson.content.length, "starts:", JSON.stringify(reloadedJson.content.slice(0, 40)));

if (errors.length > 0) {
  console.error("ERRORS:", errors);
  process.exit(1);
}

await browser.close();
console.log("E2E PASSED");
