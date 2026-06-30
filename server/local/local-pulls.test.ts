import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import type { RemotePullClient } from "./remote-cosheaf-client.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

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

// A fake remote with sensible defaults; override only what a test asserts on.
function fakeRemote(over: Partial<RemotePullClient> = {}): RemotePullClient {
  return {
    whoami: async () => ({ username: "me" }),
    openPull: async () => ({ number: 1 }),
    listPulls: async () => [],
    branchHead: async () => null,
    pullUrl: (owner, repo, n) => `https://remote.example/${owner}/${repo}/pulls/${n}`,
    ...over,
  };
}

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

function appWithBinding(
  dir: string,
  remoteClient: RemotePullClient,
  gitRemote: { name: string; host: string; owner: string; repo: string; url: string },
): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("wb-pulls-bound-");
  const registry = new WorkspaceRegistry(db, { user: IDENTITY.user });
  registry.register({
    slug: workspaceSlug(IDENTITY.owner, IDENTITY.repo),
    path: dir,
    identity: IDENTITY,
    backend: new LocalGitWorkspaceBackend(dir, { pushRemote: gitRemote.name }),
    remote: { url: `https://${gitRemote.host}`, token: "token" },
    gitRemote,
    remoteClient,
  });
  return createApp({ config, db, localRegistry: registry });
}

function appWithConnectedRegistry(dir: string, remoteClient: RemotePullClient): Hono<AppEnv> {
  return appWithBinding(dir, remoteClient, {
    name: "origin",
    host: "remote.example",
    owner: IDENTITY.owner,
    repo: IDENTITY.repo,
    url: git(dir, ["remote", "get-url", "origin"]).trim(),
  });
}

function commitCount(dir: string): number {
  return Number(git(dir, ["rev-list", "--count", "HEAD"]).trim());
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
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("No Cosheaf server connected") });
  });

  it("commits, pushes the branch to origin, and opens a PR on the remote", async () => {
    const { work, bare } = repoWithOrigin();
    const calls: Array<Record<string, unknown>> = [];
    const remote = fakeRemote({
      branchHead: async () => git(work, ["rev-parse", "HEAD"]).trim(),
      openPull: async (owner, repo, body) => {
        calls.push({ owner, repo, ...body });
        return { number: 7 };
      },
    });

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

  it("checks the configured remote before committing", async () => {
    const { work } = repoWithOrigin();
    let opened = false;
    const remote = fakeRemote({
      whoami: async () => null,
      openPull: async () => {
        opened = true;
        return { number: 1 };
      },
    });

    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("before committing") });
    expect(opened).toBe(false);
    expect(commitCount(work)).toBe(1);
  });

  it("rejects a push remote that points at a different owner/repo before committing", async () => {
    const { work } = repoWithOrigin();
    const url = "ssh://git@remote.example/other/notes.git";
    git(work, ["remote", "set-url", "origin", url]);

    const res = await appWithBinding(work, fakeRemote(), {
      name: "origin",
      host: "remote.example",
      owner: "me",
      repo: "notes",
      url,
    }).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("points at other/notes") });
    expect(commitCount(work)).toBe(1);
  });

  it("stops after push when the Cosheaf server does not observe the pushed head", async () => {
    const { work } = repoWithOrigin();
    let opened = false;
    const remote = fakeRemote({
      branchHead: async () => "0000000000000000000000000000000000000000",
      openPull: async () => {
        opened = true;
        return { number: 1 };
      },
    });

    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("server sees 000000000000") });
    expect(opened).toBe(false);
  });

  it("409s opening a PR from a detached HEAD (no silent orphan commit)", async () => {
    const { work } = repoWithOrigin();
    git(work, ["checkout", "-q", "--detach"]);
    const remote = fakeRemote();
    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "t" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PR whose head equals its base", async () => {
    const { work } = repoWithOrigin();
    const remote = fakeRemote();
    const res = await app(work, remote).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "main", base: "main" }),
    });
    expect(res.status).toBe(400);
  });

  it("redirects /pulls/:n to the remote PR url", async () => {
    const { work } = repoWithOrigin();
    const remote = fakeRemote({ openPull: async () => ({ number: 7 }) });
    const res = await app(work, remote).request("/me/notes/pulls/7");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://remote.example/me/notes/pulls/7");
  });

  it("labels the local PR list as remote Cosheaf server state", async () => {
    const { work } = repoWithOrigin();
    const remote = fakeRemote({
      listPulls: async () => [
        {
          number: 7,
          title: "Review branch",
          state: "open",
          merged: false,
          author_username: "me",
          head_ref: "feature",
          base_ref: "main",
        },
      ],
    });
    const res = await appWithConnectedRegistry(work, remote).request("/me/notes/pulls");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Remote pull requests");
    expect(body).toContain("Cosheaf server connected");
    expect(body).toContain("remote.example");
    expect(body).toContain("Remote PR #7 Review branch");
    expect(body).toContain("Local commits stay in this folder until pushed");
  });
});
