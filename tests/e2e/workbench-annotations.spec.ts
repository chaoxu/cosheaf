import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { COFLAT_BROWSER_SELECTORS as CF } from "@chaoxu/coflat/browser-test-utils";
import { expect, test } from "@playwright/test";

function git(dir: string, args: string[]): void {
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
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForWorkbench(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Workbench exited with ${child.exitCode}\n${logs.join("")}`);
    }
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

test("workbench local annotation anchor inserts at selected source position @smoke-workbench-annotations", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-workbench-annotation-"));
  const port = await freePort();
  const owner = "local";
  const repo = dir.split("/").pop() ?? "cosheaf-workbench-annotation";
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let child: ChildProcess | null = null;

  try {
    writeFileSync(join(dir, "paper.md"), "Alpha sentence.\n\nOmega sentence.\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "smoke@example.test"]);
    git(dir, ["config", "user.name", "Smoke"]);
    git(dir, ["add", "paper.md"]);
    git(dir, ["commit", "-qm", "init"]);

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

    const alpha = page.getByText("Alpha sentence.").first();
    const box = await alpha.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);

    await page.getByRole("button", { name: /Annotations/ }).click();
    await page.getByRole("textbox", { name: "New note" }).fill("Check the first sentence.");
    await page.getByRole("button", { name: "Add" }).click();

    await expect(page.locator(".cm-content")).toContainText(/Alpha sentence\.\[@local:la_[a-z0-9]{12}\]/);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    const saved = readFileSync(join(dir, "paper.md"), "utf8");
    expect(saved).toMatch(/Alpha sentence\.\[@local:la_[a-z0-9]{12}\]\n\nOmega sentence\./);
    expect(saved).not.toMatch(/Omega sentence\.\n\n\[@local:la_[a-z0-9]{12}\]/);
    const firstId = saved.match(/\[@local:(la_[a-z0-9]{12})\]/)?.[1];
    expect(firstId).toBeTruthy();
    if (!firstId) return;

    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Rich" }).click();
    const renderedMarker = page.locator(".cf-local-annotation", { hasText: "local note" }).first();
    await expect(renderedMarker).toBeVisible();
    await expect(renderedMarker).toHaveAttribute("tabindex", "0");
    await renderedMarker.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("local-annotations")).toBeVisible();
    const annotationList = page.locator(".local-annotations-list");
    await expect(annotationList).toHaveCSS("grid-row-start", "4");
    await expect(annotationList).toHaveCSS("overflow-y", "auto");
    await expect(page.locator(".local-annotation.is-focused")).toContainText(`[@local:${firstId}]`);
    await page.getByRole("button", { name: "Close" }).click();
    await renderedMarker.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("local-annotations")).toBeVisible();
    await expect(page.locator(".local-annotation.is-focused")).toContainText(`[@local:${firstId}]`);
    await page.getByRole("button", { name: "Close" }).click();
    await renderedMarker.click();
    await expect(page.getByTestId("local-annotations")).toBeVisible();
    await expect(page.locator(".local-annotation.is-focused")).toContainText(`[@local:${firstId}]`);

    await page.getByRole("button", { name: "Source" }).click();
    const omega = page.getByText("Omega sentence.").first();
    const omegaBox = await omega.boundingBox();
    expect(omegaBox).not.toBeNull();
    if (!omegaBox) return;
    await page.mouse.click(omegaBox.x + omegaBox.width - 4, omegaBox.y + omegaBox.height / 2);
    await page.locator(".local-annotation-compose select").selectOption("task");
    await page.getByRole("textbox", { name: "New note" }).fill("Check the last sentence.");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".cm-content")).toContainText(/Omega sentence\.\[@local:la_[a-z0-9]{12}\]/);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    const savedWithSecond = readFileSync(join(dir, "paper.md"), "utf8");
    const id = savedWithSecond.match(/Omega sentence\.\[@local:(la_[a-z0-9]{12})\]/)?.[1];
    expect(id).toBeTruthy();
    if (!id) return;

    const firstArticle = page.locator(".local-annotation", { hasText: `[@local:${firstId}]` });
    const secondArticle = page.locator(".local-annotation", { hasText: `[@local:${id}]` });
    await expect(secondArticle.locator(".meta-pill")).toHaveText("task");
    const agentReplyStatus = await page.evaluate(
      async ({ id, owner, repo }) => {
        const res = await fetch(`/api/v1/repos/${owner}/${repo}/local-annotations/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Agent checked this sentence." }),
        });
        return res.status;
      },
      { id, owner, repo },
    );
    expect(agentReplyStatus).toBe(200);
    await expect(secondArticle).toContainText("Agent checked this sentence.");
    await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
    await page.getByRole("button", { name: "Next open" }).click();
    await expect(page.locator(".local-annotation.is-focused")).toContainText(`[@local:${id}]`);
    await page.getByRole("button", { name: "Next open" }).click();
    await expect(page.locator(".local-annotation.is-focused")).toContainText(`[@local:${firstId}]`);
    await firstArticle.getByRole("button", { name: "Resolve" }).click();
    await expect(firstArticle).toContainText("resolved");
    await page.getByLabel("Open only").check();
    await expect(page.locator(".local-annotation", { hasText: `[@local:${firstId}]` })).toHaveCount(0);
    await expect(secondArticle).toHaveCount(1);
    await page.getByLabel("Open only").uncheck();
    await expect(firstArticle).toHaveCount(1);

    const deleteButton = firstArticle.getByRole("button", { name: "Delete" });
    await expect(deleteButton).toBeVisible();
    // The click handler removes this article; dispatch avoids Playwright waiting
    // on a detached target while still exercising the browser UI handler.
    await deleteButton.dispatchEvent("click");
    await expect(page.locator(".cm-content")).not.toContainText(`[@local:${firstId}]`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    expect(readFileSync(join(dir, "paper.md"), "utf8")).not.toContain(`[@local:${firstId}]`);
    const sidecarAfterDelete = JSON.parse(readFileSync(join(dir, ".cosheaf", "local-annotations.json"), "utf8")) as {
      annotations: Record<string, unknown>;
    };
    expect(sidecarAfterDelete.annotations[firstId]).toBeUndefined();

    await page.getByTestId("editor-path-input").fill("renamed.md");
    await expect(page.getByTestId("editor-path-input")).toHaveValue("renamed.md");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

    expect(existsSync(join(dir, "paper.md"))).toBe(false);
    const renamed = readFileSync(join(dir, "renamed.md"), "utf8");
    expect(renamed).toContain(`[@local:${id}]`);

    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "local-annotations.json"), "utf8")) as {
      annotations: Record<string, { path: string }>;
    };
    expect(sidecar.annotations[id]?.path).toBe("renamed.md");

    const exportRes = await page.request.get(`${baseUrl}/${owner}/${repo}/export/pdf/branch/main/renamed.md`);
    expect(exportRes.status()).toBe(422);
    const exportBody = await exportRes.text();
    expect(exportBody).toContain(`[@local:${id}] (open`);
    expect(exportBody).not.toContain(`[@local:${id}] (missing`);

    const externalWriteStatus = await page.evaluate(
      async ({ owner, repo, renamed }) => {
        const res = await fetch(`/api/v1/repos/${owner}/${repo}/file?path=renamed.md&branch=main`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: `${renamed}\nExternal agent edit.\n` }),
        });
        return res.status;
      },
      { owner, repo, renamed },
    );
    expect(externalWriteStatus).toBe(200);
    await expect(page.getByTestId("editor-external-change-banner")).toContainText("This file changed outside this editor.");
    await page.getByTestId("editor-external-change-compare").click();
    await expect(page.getByTestId("editor-external-compare")).toContainText("Current editor buffer");
    await expect(page.getByTestId("editor-external-compare")).toContainText("Latest workspace file");
    await expect(page.getByTestId("editor-external-compare")).toContainText("External agent edit.");

    await page.locator(CF.editorContent).fill(`${renamed}\nHuman stale edit.\n`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("editor-external-change-banner")).toContainText("Save blocked because this editor buffer is stale.");
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute(
      "title",
      "Stale buffer: this file changed outside the editor. Compare or reload before saving.",
    );
    expect(readFileSync(join(dir, "renamed.md"), "utf8")).toContain("External agent edit.");
    expect(readFileSync(join(dir, "renamed.md"), "utf8")).not.toContain("Human stale edit.");

    await page.getByTestId("editor-external-change-reload").click();
    await expect(page.locator(CF.editorContent)).toContainText("External agent edit.");
    await expect(page.locator(CF.editorContent)).not.toContainText("Human stale edit.");
  } finally {
    if (child) await stopWorkbench(child);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test("workbench agent session review commits selected local edits @smoke-workbench-annotations", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-workbench-agent-session-"));
  const port = await freePort();
  const owner = "local";
  const repo = dir.split("/").pop() ?? "cosheaf-workbench-agent-session";
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  let child: ChildProcess | null = null;

  try {
    writeFileSync(join(dir, "paper.md"), "# Paper\n\nFirst draft.\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "smoke@example.test"]);
    git(dir, ["config", "user.name", "Smoke"]);
    git(dir, ["add", "paper.md"]);
    git(dir, ["commit", "-qm", "init"]);

    child = spawn("pnpm", ["workbench", dir, "--port", String(port)], {
      cwd: process.cwd(),
      env: { ...process.env, COSHEAF_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

    await waitForWorkbench(`${baseUrl}/${owner}/${repo}`, child, logs);

    const annotation = await page.request.post(`${baseUrl}/api/v1/repos/${owner}/${repo}/local-annotations`, {
      headers: { origin: baseUrl },
      data: { id: "la_aaaaaaaaaaaa", path: "paper.md", body: "Clarify the opening.", author: "chao" },
    });
    expect(annotation.status()).toBe(201);
    const session = await page.request.post(`${baseUrl}/api/v1/repos/${owner}/${repo}/agent-sessions`, {
      headers: { origin: baseUrl },
      data: {
        id: "as_aaaaaaaaaaaa",
        title: "Review agent edits",
        touched_files: ["paper.md"],
        linked_annotations: ["la_aaaaaaaaaaaa"],
      },
    });
    expect(session.status()).toBe(201);

    writeFileSync(join(dir, "paper.md"), "# Paper\n\nImproved draft from agent.\n");
    const waiting = await page.request.patch(`${baseUrl}/api/v1/repos/${owner}/${repo}/agent-sessions/as_aaaaaaaaaaaa`, {
      headers: { origin: baseUrl },
      data: { status: "waiting_for_review", summary: "Ready for human review." },
    });
    expect(waiting.status()).toBe(200);

    await page.goto(`${baseUrl}/${owner}/${repo}/agent-sessions/as_aaaaaaaaaaaa`);
    await expect(page.getByRole("heading", { name: "Review agent edits" })).toBeVisible();
    await expect(page.getByTestId("agent-session-annotations")).toContainText("la_aaaaaaaaaaaa");
    await expect(page.getByTestId("agent-session-diff")).toContainText("Improved draft from agent.");

    await page.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByTestId("agent-session-notice")).toContainText("Annotation updated.");
    await expect(page.getByTestId("agent-session-annotations")).toContainText("resolved");

    await page.getByRole("button", { name: "Commit selected files" }).click();
    await expect(page.getByTestId("agent-session-notice")).toContainText(/Committed [0-9a-f]{8}/);
    await expect(page.getByText("This session has no touched files.")).toBeVisible();

    const committedFiles = execFileSync("git", ["-C", dir, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" }).trim();
    expect(committedFiles).toBe("paper.md");
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "agent-sessions.json"), "utf8")) as {
      sessions: Record<string, { status: string; touched_files: string[] }>;
    };
    expect(sidecar.sessions.as_aaaaaaaaaaaa.status).toBe("done");
    expect(sidecar.sessions.as_aaaaaaaaaaaa.touched_files).toEqual([]);
  } finally {
    if (child) await stopWorkbench(child);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});
