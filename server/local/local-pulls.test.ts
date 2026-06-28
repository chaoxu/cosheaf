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
import type { RemotePullClient } from "./remote-cosheaf-client.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// A working clone with an `origin` bare remote, on a `feature` branch with a
// pending working-tree edit ready to push.
function repoWithOrigin(): { work: string; bare: string } {
  const bare = mkdtempSync(join(tmpdir(), "cosheaf-wb-bare-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
  const work = mkdtempSync(join(tmpdir(), "cosheaf-wb-work-"));
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "t@t.test"]);
  git(work, ["config", "user.name", "Tester"]);
  git(work, ["remote", "add", "origin", bare]);
  writeFileSync(join(work, "hello.md"), "# Hello\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "init"]);
  git(work, ["push", "-q", "-u", "origin", "main"]);
  git(work, ["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(work, "hello.md"), "# Hello from feature\n");
  return { work, bare };
}

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: true,
};

function app(dir: string, remoteClient?: RemotePullClient): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  return createApp({
    config,
    db: freshTestDb("wb-pulls-"),
    workspaceBackend: new LocalGitWorkspaceBackend(dir),
    localWorkspace: IDENTITY,
    remoteClient,
  });
}

describe("local Workbench Tier 2 (push + PR)", () => {
  it("409s opening a PR with no remote configured", async () => {
    const { work } = repoWithOrigin();
    const res = await app(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "t" }),
    });
    expect(res.status).toBe(409);
  });

  it("commits, pushes the branch to origin, and opens a PR on the remote", async () => {
    const { work, bare } = repoWithOrigin();
    const calls: Array<Record<string, unknown>> = [];
    const remote: RemotePullClient = {
      openPull: async (owner, repo, body) => {
        calls.push({ owner, repo, ...body });
        return { number: 7 };
      },
      pullUrl: (owner, repo, n) => `https://remote.example/${owner}/${repo}/pulls/${n}`,
    };

    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello", body: "b" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 7 });

    // The feature branch was committed and pushed to the bare origin.
    expect(git(bare, ["rev-parse", "--verify", "feature"]).trim()).toMatch(/^[0-9a-f]{40}$/);
    // The PR was opened on the remote with the right head/base.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ owner: "me", repo: "notes", head: "feature", base: "main", title: "edit hello" });
  });

  it("rejects a PR whose head equals its base", async () => {
    const { work } = repoWithOrigin();
    const remote: RemotePullClient = {
      openPull: async () => ({ number: 1 }),
      pullUrl: () => "x",
    };
    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "main", base: "main" }),
    });
    expect(res.status).toBe(400);
  });

  it("redirects /pulls/:n to the remote PR url", async () => {
    const { work } = repoWithOrigin();
    const remote: RemotePullClient = {
      openPull: async () => ({ number: 7 }),
      pullUrl: (owner, repo, n) => `https://remote.example/${owner}/${repo}/pulls/${n}`,
    };
    const res = await app(work, remote).request("/me/notes/pulls/7");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://remote.example/me/notes/pulls/7");
  });
});
