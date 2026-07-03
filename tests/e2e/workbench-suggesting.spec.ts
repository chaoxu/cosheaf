import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

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

test("workbench suggesting mode accepts checkpoint and reverts hunks @smoke-workbench-annotations", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-workbench-suggesting-"));
  const port = await freePort();
  const owner = "local";
  const repo = basename(dir);
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const browserErrors: string[] = [];
  let child: ChildProcess | null = null;

  try {
    writeFileSync(join(dir, "paper.md"), "# Paper\n\nAlpha line.\nBeta line.\nGamma line.\n");
    gitQuiet(dir, ["init", "-q", "-b", "main"]);
    gitQuiet(dir, ["config", "user.email", "smoke@example.test"]);
    gitQuiet(dir, ["config", "user.name", "Smoke"]);
    gitQuiet(dir, ["add", "paper.md"]);
    gitQuiet(dir, ["commit", "-qm", "Initial paper"]);

    child = spawn("pnpm", ["workbench", dir, "--port", String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, COSHEAF_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    await waitForWorkbench(`${baseUrl}/${owner}/${repo}`, child, logs);
    await page.setViewportSize({ width: 390, height: 800 });
    page.on("response", (response) => {
      const url = response.url();
      if ((url.includes("/assets/") || url.includes("/vendor/coflat/")) && response.status() >= 400) {
        browserErrors.push(`${response.status()} ${url}`);
      }
    });
    page.on("pageerror", (err) => browserErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") browserErrors.push(msg.text());
    });

    await page.goto(`${baseUrl}/${owner}/${repo}/src/branch/main/paper.md?mode=edit`);
    await page.getByRole("button", { name: "Source" }).click();
    await expect(page.locator(".cm-gutters")).toBeHidden();
    await page.getByText("Beta line.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Browser accepted edit.");

    const accept = page.getByRole("button", { name: "Accept hunk" });
    const revert = page.getByRole("button", { name: "Revert hunk" });
    await expect(accept).toBeVisible();
    await expect(revert).toBeVisible();
    await expect.poll(() =>
      page.locator(".cm-gutters").evaluate((el) => getComputedStyle(el).backgroundColor)
    ).toBe("rgba(0, 0, 0, 0)");
    await expect(accept).toBeInViewport();
    await expect(revert).toBeInViewport();
    await accept.click();
    await expect(accept).toHaveCount(0);
    await expect(page.locator(".cm-gutters")).toBeHidden();
    await expect(page.getByTestId("editor-suggesting-state")).toContainText("Changes 0");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+S" : "Control+S");
    await expect.poll(() => git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
    await expect(page.locator(".cm-cosheaf-suggesting-actions")).toHaveCount(0);

    const checkpointHead = git(dir, ["rev-parse", "--short", "HEAD"]).trim();
    expect(readFileSync(join(dir, "paper.md"), "utf8")).toContain("Beta line. Browser accepted edit.");

    await page.getByText("Gamma line.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Browser reverted edit.");
    await expect(revert).toBeVisible();
    await revert.click();

    await expect(page.locator(".cm-content")).not.toContainText("Browser reverted edit.");
    await expect(revert).toHaveCount(0);
    expect(readFileSync(join(dir, "paper.md"), "utf8")).not.toContain("Browser reverted edit.");
    expect(git(dir, ["rev-parse", "--short", "HEAD"]).trim()).toBe(checkpointHead);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(browserErrors).toEqual([]);
  } finally {
    if (child) await stopWorkbench(child);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});
