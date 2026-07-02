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

// Minimal PrMeta the core's typed routes return; consumers read the arrays, so
// they must be present even in tests that only assert the PR number.
function prMeta(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "t",
    body: "",
    state: "open",
    merged: false,
    merged_at: null,
    mergeable: true,
    additions_total: 0,
    deletions_total: 0,
    files_changed: 0,
    labels: [],
    milestone: null,
    requested_reviewers: [],
    requested_reviewer_teams: [],
    head_ref: "feature",
    head_sha: "h",
    base_ref: "main",
    base_sha: "b",
    author_username: "other",
    created_at: 0,
    ...over,
  };
}

function app(dir: string): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("wb-pulls-");
  const backend = new LocalGitWorkspaceBackend(dir);
  return createApp({
    config,
    db,
    localRegistry: testLocalRegistry(db, backend, IDENTITY),
  });
}

function appWithBinding(
  dir: string,
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
  });
  return createApp({ config, db, localRegistry: registry });
}

// A connected core (so the web /pulls coreConnectGate passes) with no gitRemote
// binding (so validatePublishBinding short-circuits past the unparseable local
// bare-repo path), exercising the full local commit→push→openPull happy path
// through the server-rendered POST.
function appConnectedNoBinding(dir: string): Hono<AppEnv> {
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("wb-pulls-conn-");
  const registry = new WorkspaceRegistry(db, { user: IDENTITY.user });
  registry.register({
    slug: workspaceSlug(IDENTITY.owner, IDENTITY.repo),
    path: "",
    identity: IDENTITY,
    backend: new LocalGitWorkspaceBackend(dir),
    remote: { url: "https://remote.example", token: "token" },
    gitRemote: null,
  });
  return createApp({ config, db, localRegistry: registry });
}

function appWithConnectedRegistry(dir: string): Hono<AppEnv> {
  return appWithBinding(dir, {
    name: "origin",
    host: "remote.example",
    owner: IDENTITY.owner,
    repo: IDENTITY.repo,
    url: git(dir, ["remote", "get-url", "origin"]).trim(),
  });
}

function stubCore(route: (method: string, path: string) => unknown): Array<{ method: string; path: string; body: unknown }> {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname;
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const payload = route(method, path);
      return payload === undefined ? Response.json({}) : Response.json(payload);
    }),
  );
  return calls;
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
    const calls = stubCore((method, path) => {
      if (method === "GET" && path === "/api/v1/me") return { user: { username: "me" } };
      if (method === "GET" && path.endsWith("/branches")) {
        return [{ name: "feature", commit: { id: git(work, ["rev-parse", "HEAD"]).trim() } }];
      }
      if (method === "POST" && path.endsWith("/pulls")) return prMeta({ number: 7 });
      return {};
    });

    const res = await appConnectedNoBinding(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello", body: "b" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 7 });

    // The feature branch was committed and pushed to the bare origin.
    expect(git(bare, ["rev-parse", "--verify", "feature"]).trim()).toMatch(/^[0-9a-f]{40}$/);
    // The PR was opened on the remote with the right head/base.
    const opened = calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    expect(opened?.body).toMatchObject({ head: "feature", base: "main", title: "edit hello", body: "b" });
  });

  it("checks the configured remote before committing", async () => {
    const { work } = repoWithOrigin();
    const calls = stubCore((method, path) => {
      if (method === "GET" && path === "/api/v1/me") return { user: null };
      return {};
    });

    const res = await appConnectedNoBinding(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("before committing") });
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls"))).toBe(false);
    expect(commitCount(work)).toBe(1);
  });

  it("rejects a push remote that points at a different owner/repo before committing", async () => {
    const { work } = repoWithOrigin();
    const url = "ssh://git@remote.example/other/notes.git";
    git(work, ["remote", "set-url", "origin", url]);

    const res = await appWithBinding(work, {
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
    const calls = stubCore((method, path) => {
      if (method === "GET" && path === "/api/v1/me") return { user: { username: "me" } };
      if (method === "GET" && path.endsWith("/branches")) {
        return [{ name: "feature", commit: { id: "0000000000000000000000000000000000000000" } }];
      }
      if (method === "POST" && path.endsWith("/pulls")) return { number: 1 };
      return {};
    });

    const res = await appConnectedNoBinding(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "edit hello" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("server sees 000000000000") });
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls"))).toBe(false);
  });

  it("409s opening a PR from a detached HEAD (no silent orphan commit)", async () => {
    const { work } = repoWithOrigin();
    git(work, ["checkout", "-q", "--detach"]);
    const res = await appConnectedNoBinding(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "feature", base: "main", title: "t" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PR whose head equals its base", async () => {
    const { work } = repoWithOrigin();
    const res = await appConnectedNoBinding(work).request("/api/v1/repos/me/notes/pulls", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ head: "main", base: "main" }),
    });
    expect(res.status).toBe(400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The pre-#268 external bounce on /pulls/:n is gone. A workspace with no
  // connected core now renders the Connect prompt for every collaboration
  // surface, including a PR detail path, rather than redirecting externally.
  it("shows the Connect prompt on /pulls/:n when no core is connected", async () => {
    const { work } = repoWithOrigin();
    const res = await app(work).request("/me/notes/pulls/7");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("no connected Cosheaf server");
    expect(body).toContain('data-testid="connect-form"');
  });

  // With a connected core, the local PR list is the SAME shared route the hosted
  // app uses, reading the core through ctx.collab (an OriginCollaborationClient).
  // Stub global fetch so the Origin API calls resolve without a live server.
  it("renders the shared PR list against the connected core (#268)", async () => {
    const { work } = repoWithOrigin();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/pulls")) return Response.json({ pulls: [] });
        if (url.includes("/labels")) return Response.json({ labels: [] });
        if (url.includes("/milestones")) return Response.json({ milestones: [] });
        return Response.json({});
      }),
    );
    const res = await appWithConnectedRegistry(work).request("/me/notes/pulls");
    expect(res.status).toBe(200);
    const body = await res.text();
    // The shared PRs page (heading + empty state), not the old remote-PR-list page.
    expect(body).toContain("<h1>PRs</h1>");
    expect(body).toContain("No matching pull requests");
  });

  // The /pulls/new compare page must be local-aware: head defaults to the
  // checked-out working-tree branch (sourced from the LOCAL backend), not a core
  // branch — otherwise base and head both default to "main" and no PR can be
  // opened. Stub the core /branches call for the base selector.
  function stubBranches(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes("/branches")) return Response.json([{ name: "main", commit: { id: "x" } }]);
        return Response.json({});
      }),
    );
  }

  it("/pulls/new preselects the working-tree branch as head, not main", async () => {
    const { work } = repoWithOrigin(); // checked out on `feature`
    stubBranches();
    const res = await appWithConnectedRegistry(work).request("/me/notes/pulls/new");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="pull-create-form"');
    expect(body).toContain('<option value="feature" selected>feature</option>');
    expect(body).not.toContain('data-testid="pull-create-no-branch"');
  });

  it("/pulls/new shows a friendly create-a-branch state when on the base branch", async () => {
    const { work } = repoWithOrigin();
    git(work, ["checkout", "-q", "main"]);
    stubBranches();
    const res = await appWithConnectedRegistry(work).request("/me/notes/pulls/new");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="pull-create-no-branch"');
    expect(body).toContain("create a feature branch");
    expect(body).not.toContain('data-testid="pull-create-form"');
  });

  it("POST /pulls/new routes through the local commit→push→openPull flow", async () => {
    const { work, bare } = repoWithOrigin(); // on `feature` with a pending edit
    const calls = stubCore((method, path) => {
      if (method === "GET" && path === "/api/v1/me") return { user: { username: "me" } };
      if (method === "GET" && path.endsWith("/branches")) {
        return [{ name: "feature", commit: { id: git(work, ["rev-parse", "HEAD"]).trim() } }];
      }
      if (method === "POST" && path.endsWith("/pulls")) return prMeta({ number: 9 });
      return {};
    });
    const res = await appConnectedNoBinding(work).request("/me/notes/pulls/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ head: "feature", base: "main", title: "edit hello", body: "b" }).toString(),
    });
    // Server-rendered POST redirects to the new PR on success.
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/me/notes/pulls/9");
    // The branch was actually committed and pushed to origin, then opened on the core.
    expect(git(bare, ["rev-parse", "--verify", "feature"]).trim()).toMatch(/^[0-9a-f]{40}$/);
    const opened = calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    expect(opened?.body).toMatchObject({ head: "feature", base: "main", title: "edit hello", body: "b" });
  });
});

// Typed PR API in the local Workbench. These hit the SAME typed routes
// the agent-facing API and editor island use, served by the local app whose
// ctx.collab is an OriginCollaborationClient against a connected core. Global
// fetch is stubbed so the Origin API calls resolve without a live core.
describe("local Workbench typed PR API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges a PR through the core and skips local branch cleanup when there is no forge", async () => {
    const { work } = repoWithOrigin();
    const calls = stubCore((method, path) => {
      if (method === "POST" && path.endsWith("/pulls/7/merge")) return { ok: true };
      if (method === "GET" && path.endsWith("/pulls/7")) return { pull: prMeta() };
      return {};
    });
    const res = await appWithConnectedRegistry(work).request("/api/v1/repos/me/notes/pulls/7/merge", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ Do: "squash" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The proxied merge ran; no forge branch-delete call (the core owns cleanup).
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls/7/merge"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && /\/branches\//.test(c.path))).toBe(false);
  });

  it("replaces repo topics through the core's typed route", async () => {
    const { work } = repoWithOrigin();
    const calls = stubCore(() => ({ ok: true }));
    const res = await appWithConnectedRegistry(work).request("/api/v1/repos/me/notes/topics", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ topics: ["cosheaf-format-coflat", "math"] }),
    });
    expect(res.status).toBe(200);
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/topics"));
    expect(put?.body).toEqual({ topics: ["cosheaf-format-coflat", "math"] });
  });

  it("updates min_approvals through the core's typed settings route", async () => {
    const { work } = repoWithOrigin();
    const calls = stubCore((method) => (method === "GET" ? { min_approvals: 1 } : { min_approvals: 2 }));
    const res = await appWithConnectedRegistry(work).request("/api/v1/repos/me/notes/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ min_approvals: 2 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { min_approvals: number }).toMatchObject({ min_approvals: 2 });
    const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/settings"));
    expect(put?.body).toEqual({ min_approvals: 2 });
  });

  it("accepts legacy coflat format payload without a core format write", async () => {
    const { work } = repoWithOrigin();
    const calls = stubCore(() => ({}));
    const res = await appWithConnectedRegistry(work).request("/api/v1/repos/me/notes/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ default_md_format: COFLAT_FORMAT_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ default_md_format: COFLAT_FORMAT_ID });
    expect(calls.some((c) => c.path.endsWith("/topics"))).toBe(false);
  });

	it("submits a staged pending review, resolving the caller's own draft via the core", async () => {
		const { work } = repoWithOrigin();
		const submitted = { id: 9, username: "me", decision: "approve", comment: null, created_at: 10 };
		const calls = stubCore((method, path) => {
			if (method === "GET" && path.endsWith("/pulls/7")) return { pull: prMeta({ author_username: "other" }) };
			if (method === "GET" && path.endsWith("/pulls/7/reviews")) {
				return { reviews: [{ id: 9, username: "me", decision: "pending", comment: null, created_at: 0 }], approvals: 0, rejections: 0 };
			}
			if (method === "POST" && path.endsWith("/pending-review/9/submit")) return { ok: true, review: submitted };
			return { ok: true };
		});
    const res = await appWithConnectedRegistry(work).request("/api/v1/repos/me/notes/pulls/7/pending-review/9/submit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ event: "approve" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, review: submitted });
		const submit = calls.find((c) => c.method === "POST" && c.path.endsWith("/pending-review/9/submit"));
		expect(submit?.body).toMatchObject({ event: "approve" });
	});
});
