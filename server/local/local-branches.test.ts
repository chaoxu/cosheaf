import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb, testLocalRegistry } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// A working clone with an `origin` bare remote and one commit on main.
function repoWithOrigin(): { work: string } {
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
  return { work };
}

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: true,
};

function app(dir: string): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("wb-branches-");
  const backend = new LocalGitWorkspaceBackend(dir);
  return createApp({
    config,
    db,
    localRegistry: testLocalRegistry(db, backend, IDENTITY),
  });
}

function appWithConnectedRegistry(dir: string): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("wb-branches-bound-");
  const registry = new WorkspaceRegistry(db, { user: IDENTITY.user });
  registry.register({
    slug: workspaceSlug(IDENTITY.owner, IDENTITY.repo),
    path: dir,
    identity: IDENTITY,
    backend: new LocalGitWorkspaceBackend(dir),
    remote: { url: "https://remote.example", token: "token" },
    gitRemote: {
      name: "origin",
      host: "remote.example",
      owner: IDENTITY.owner,
      repo: IDENTITY.repo,
      url: git(dir, ["remote", "get-url", "origin"]).trim(),
    },
  });
  return createApp({ config, db, localRegistry: registry });
}

describe("local Workbench branches + commit pages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // With no connected core, the branches page must not 404 — it shows the same
  // Connect prompt the other collaboration surfaces use.
  it("shows the Connect prompt on /branches when no core is connected", async () => {
    const { work } = repoWithOrigin();
    const res = await app(work).request("/me/notes/branches");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("no connected Cosheaf server");
    expect(body).toContain('data-testid="connect-form"');
  });

  // With a connected core, the shared branches route lists the core's branches
  // through ctx.collab (an OriginCollaborationClient). Stub global fetch so the
  // Origin API calls resolve without a live server.
  it("renders the branches list against the connected core", async () => {
    const { work } = repoWithOrigin();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/branches")) {
          return Response.json([
            { name: "main", commit: { id: "1111111111111111111111111111111111111111" } },
            { name: "feature-x", commit: { id: "2222222222222222222222222222222222222222" } },
          ]);
        }
        if (url.includes("/pulls")) return Response.json({ pulls: [] });
        return Response.json({});
      }),
    );
    const res = await appWithConnectedRegistry(work).request("/me/notes/branches");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Branches</h1>");
    expect(body).toContain("feature-x");
    // Local mode is read-only for branches: no create panel, no delete buttons.
    expect(body).not.toContain('data-testid="branch-create-form"');
    expect(body).not.toContain('data-testid="branch-delete"');
  });

  // The /commits/:sha page reads the local git working tree (ungated): a sha the
  // clone actually has renders the commit card.
  it("renders a local commit from the working tree", async () => {
    const { work } = repoWithOrigin();
    const sha = git(work, ["rev-parse", "HEAD"]).trim();
    const res = await app(work).request(`/me/notes/commits/${sha}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("commit-card");
    expect(body).toContain("init");
    expect(body).toContain(sha);
  });

  // A sha the local clone does not have degrades to a clear "not available"
  // state rather than 500ing or showing the hosted 404.
  it("degrades gracefully for a commit not in the local working tree", async () => {
    const { work } = repoWithOrigin();
    const res = await app(work).request(`/me/notes/commits/${"0".repeat(40)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="commit-unavailable"');
  });
});
