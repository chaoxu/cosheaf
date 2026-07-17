import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:net";
import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { expect, test } from "@playwright/test";

function gitQuiet(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a TCP port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForWorkbench(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Workbench exited with ${child.exitCode}\n${logs.join("")}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Workbench did not start at ${url}: ${lastError}\n${logs.join("")}`);
}

async function stopWorkbench(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// #387: a cross-file page id from /suggest must appear in Coflat's SINGLE native
// `[@` reference popup — not a second, competing popup (the duplicate be6791f5
// removed). Verifies the extraCompletionSourcesFacet wiring end-to-end.
test("workbench [@ autocomplete merges cross-file ids into one popup @smoke-workbench-annotations", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-workbench-refac-"));
  const port = await freePort();
  const owner = "local";
  const repo = basename(dir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let child: ChildProcess | null = null;

  try {
    writeFileSync(join(dir, "paper.md"), "# Paper\n\nSee also: \n");
    writeFileSync(join(dir, "theory.md"), "---\nid: theory-main\ntitle: Theory of Everything\n---\n# Theory\n");
    gitQuiet(dir, ["init", "-q", "-b", "main"]);
    gitQuiet(dir, ["config", "user.email", "smoke@example.test"]);
    gitQuiet(dir, ["config", "user.name", "Smoke"]);
    gitQuiet(dir, ["add", "-A"]);
    gitQuiet(dir, ["commit", "-qm", "Initial pages"]);

    child = spawn("pnpm", ["workbench", dir, "--port", String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, COSHEAF_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    await waitForWorkbench(`${baseUrl}/${owner}/${repo}`, child, logs);

    await page.goto(`${baseUrl}/${owner}/${repo}/src/branch/main/paper.md?mode=edit`);
    await page.getByRole("button", { name: "Source" }).click();
    await page.getByText("See also:").click();
    await page.keyboard.press("End");
    // Trigger the reference popup; the extra source fetches /suggest for `[@`.
    await page.keyboard.type("[@theo");

    const tooltip = page.locator(".cm-tooltip-autocomplete");
    await expect(tooltip).toContainText("theory-main");
    // The core of #387: one popup, not two.
    await expect(tooltip).toHaveCount(1);

    // Accepting the cross-file candidate inserts the reference.
    await tooltip.getByText("theory-main").click();
    await expect(page.locator(CF.editorContent)).toContainText("[@theory-main]");
  } finally {
    if (child) await stopWorkbench(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
