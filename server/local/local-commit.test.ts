import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-wb-git-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Tester"]);
  writeFileSync(join(dir, "hello.md"), "# Hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
};

function app(dir: string): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  return createApp({ config, db: freshTestDb("wb-git-"), workspaceBackend: new LocalGitWorkspaceBackend(dir), localWorkspace: IDENTITY });
}

describe("local Workbench Tier 1 (git)", () => {
  it("lists the real git branches", async () => {
    const dir = gitRepo();
    git(dir, ["branch", "feature-x"]);
    const res = await app(dir).request("/api/v1/repos/me/notes/branches");
    expect(res.status).toBe(200);
    const branches = (await res.json()) as Array<{ name: string }>;
    expect(branches.map((b) => b.name).sort()).toEqual(["feature-x", "main"]);
  });

  it("shows a clean working tree on the commit page", async () => {
    const dir = gitRepo();
    const res = await app(dir).request("/me/notes/commit");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Branch <strong>main</strong>");
    expect(body).toContain('data-testid="commit-clean"');
  });

  it("commits working-tree changes through the commit page", async () => {
    const dir = gitRepo();
    // A save wrote new content to disk (Tier 0).
    writeFileSync(join(dir, "hello.md"), "# Hello changed\n");

    const wb = app(dir);
    const statusPage = await (await wb.request("/me/notes/commit")).text();
    expect(statusPage).toContain('data-testid="commit-status"');
    expect(statusPage).toContain("hello.md");

    const res = await wb.request("/me/notes/commit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ message: "edit hello" }).toString(),
    });
    expect(res.status).toBe(303);

    expect(git(dir, ["log", "--oneline"]).trim().split("\n")).toHaveLength(2);
    expect(git(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("edit hello");
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("never commits the .cosheaf sidecar dir", async () => {
    const dir = gitRepo();
    const wb = app(dir); // buildLocalConfig writes <dir>/.cosheaf/.gitignore
    writeFileSync(join(dir, ".cosheaf", "db.sqlite"), "fake-sidecar");
    writeFileSync(join(dir, "hello.md"), "# changed\n");
    const res = await wb.request("/me/notes/commit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ message: "edit" }).toString(),
    });
    expect(res.status).toBe(303);
    const tracked = git(dir, ["ls-files"]).split("\n").filter(Boolean);
    expect(tracked.some((f) => f.startsWith(".cosheaf"))).toBe(false);
    expect(tracked).toContain("hello.md");
  });

  it("reports a non-git folder gracefully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-wb-nogit-"));
    writeFileSync(join(dir, "a.md"), "# A\n");
    const res = await app(dir).request("/me/notes/commit");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-testid="commit-not-git"');
  });
});
