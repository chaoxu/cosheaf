import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb, testLocalRegistry } from "../routes/test-fixtures.js";
import { type SSEEvent, SSEHub } from "../sse.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { gitBlobHash, LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { suggestingHunks } from "../../shared/suggesting-diff.js";

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
  originId: "local-test-origin",
};

function localApp(seed: Record<string, string> = {}, options: { sse?: SSEHub } = {}): { app: Hono<AppEnv>; dir: string; registry: WorkspaceRegistry } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-app-"));
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("cosheaf-local-app-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  const registry = testLocalRegistry(db, backend, IDENTITY, dir);
  const app = createApp({ config, db, localRegistry: registry, sse: options.sse });
  return { app, dir, registry };
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function localGitApp(seed: Record<string, string> = {}, options: { sse?: SSEHub } = {}): { app: Hono<AppEnv>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-git-app-"));
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Tester"]);
  if (Object.keys(seed).length > 0) {
    git(dir, ["add", "-A", "--", ...Object.keys(seed)]);
    git(dir, ["commit", "-qm", "init"]);
  }
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("cosheaf-local-git-app-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  const app = createApp({ config, db, localRegistry: testLocalRegistry(db, backend, IDENTITY, dir), sse: options.sse });
  return { app, dir };
}

describe("local Workbench app (Tier 0)", () => {
  it("serves the file API for the working tree with no auth", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; sha: string };
    expect(body.content).toBe("# Hello\n");
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists the working tree via the tree route", async () => {
    const { app } = localApp({ "a.md": "# A\n", "b.md": "# B\n" });
    const res = await app.request("/api/v1/repos/me/notes/tree?branch=main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("writes a file to disk through PUT /file on main (direct mode)", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/notes", (event) => events.push(event));
    const { app, dir } = localApp({ "hello.md": "# Hello\n" }, { sse });
    const read = (await (await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main")).json()) as { sha: string };
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "# Changed\n", expected_sha: read.sha }),
    });
    expect(res.status).toBe(200);
    const onDisk = readFileSync(join(dir, "hello.md"), "utf8");
    expect(onDisk).toContain("# Changed");
    // Coflat markdown gets a frontmatter id stamped on write.
    expect(onDisk).toMatch(/id:/);
    unsubscribe();
    expect(events).toContainEqual({ type: "file_changed", action: "changed", path: "hello.md" });
    expect(events).toContainEqual({ type: "git_changed", action: "status_changed", paths: ["hello.md"] });
    expect(events).toContainEqual({ type: "change", path: "hello.md" });
  });

  it("publishes typed file and git events for local asset uploads", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/notes", (event) => events.push(event));
    const { app, dir } = localApp({}, { sse });
    const form = new FormData();
    form.set("file", new File(["image-bytes"], "diagram.png", { type: "image/png" }));

    const res = await app.request("/api/v1/repos/me/notes/assets?branch=main", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/^assets\/diagram-[a-z0-9]+\.png$/);
    expect(readFileSync(join(dir, body.path), "utf8")).toBe("image-bytes");

    unsubscribe();
    expect(events).toContainEqual({ type: "file_changed", action: "changed", path: body.path });
    expect(events).toContainEqual({ type: "git_changed", action: "status_changed", paths: [body.path] });
    expect(events).toContainEqual({ type: "change", path: body.path });
  });

  it("rejects a stale-sha write with a conflict", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "# Changed\n", expected_sha: "0000000000000000000000000000000000000000" }),
    });
    expect(res.status).toBe(409);
  });

  it("blocks an editor save based on a stale revision after an external typed write", async () => {
    const { app, dir } = localApp({ "hello.md": "# Hello\n" });
    const loaded = (await (await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main")).json()) as { sha: string };
    const external = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "# External\n" }),
    });
    expect(external.status).toBe(200);

    const staleSave = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "# Human stale buffer\n", expected_sha: loaded.sha }),
    });
    expect(staleSave.status).toBe(409);
    await expect(staleSave.json()).resolves.toMatchObject({
      code: "conflict",
      details: {
        branch_moved: true,
        expected_sha: loaded.sha,
      },
    });
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toContain("# External");
  });

  it("reindexes the sidecar on save so search finds the new content", async () => {
    const { app } = localApp({ "hello.md": "---\nid: hello\n---\n# Hello\n" });
    const read = (await (await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main")).json()) as { sha: string };
    const put = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: "---\nid: hello\n---\n# Hello\n\nzzuniquewordzz\n", expected_sha: read.sha }),
    });
    expect(put.status).toBe(200);
    const res = await app.request("/api/v1/repos/me/notes/search?q=zzuniquewordzz");
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results.length).toBeGreaterThan(0);
  });

  it("serves HEAD content as the suggesting base for a git-backed file", async () => {
    const { app, dir } = localGitApp({ "hello.md": "# Hello\n" });
    writeFileSync(join(dir, "hello.md"), "# Changed\n");

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { base_text: string; head_sha: string; current_sha: string };
    expect(body.base_text).toBe("# Hello\n");
    expect(body.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.current_sha).toBe(gitBlobHash(Buffer.from("# Changed\n")));
  });

  it("serves an empty suggesting base for an untracked git-backed file", async () => {
    const { app, dir } = localGitApp({ "README.md": "# Seed\n" });
    writeFileSync(join(dir, "new.md"), "# New\n\nDraft\n");

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=new.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { base_text: string; head_sha: string; current_sha: string };
    expect(body.base_text).toBe("");
    expect(body.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.current_sha).toBe(gitBlobHash(Buffer.from("# New\n\nDraft\n")));
    expect(suggestingHunks(body.base_text, "# New\n\nDraft\n")).toMatchObject([{ kind: "insert" }]);
  });

  it("reverts a suggesting hunk after verifying it against live HEAD", async () => {
    const base = "---\nid: hello\ntitle: Hello\n---\n# Hello\n\nOld\n";
    const current = "---\nid: hello\ntitle: Hello\n---\n# Hello\n\nNew\n";
    const { app, dir } = localGitApp({ "hello.md": base });
    writeFileSync(join(dir, "hello.md"), current);
    const [hunk] = suggestingHunks(base, current);
    expect(hunk).toBeDefined();
    const load = await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md");
    const loaded = (await load.json()) as { head_sha: string; current_sha: string };

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/revert", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        hunk,
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; hunks: unknown[]; current_sha: string };
    expect(body.content).toBe(base);
    expect(body.hunks).toEqual([]);
    expect(body.current_sha).toBe(gitBlobHash(Buffer.from(base)));
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toBe(base);
  });

  it("returns the rewritten frontmatter content when reverting a non-normalized markdown file", async () => {
    const base = "# Hello\n\nOld\n";
    const current = "# Hello\n\nNew\n";
    const { app, dir } = localGitApp({ "hello.md": base });
    writeFileSync(join(dir, "hello.md"), current);
    const [hunk] = suggestingHunks(base, current);
    expect(hunk).toBeDefined();
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/revert", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        hunk,
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; hunks: unknown[] };
    expect(body.content).toContain("id:");
    expect(body.content).toContain("# Hello\n\nOld\n");
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toBe(body.content);
  });

  it("reverts a deletion-only suggesting hunk", async () => {
    const base = "---\nid: hello\ntitle: Hello\n---\n# Hello\n\nKeep\nRestore me\nAfter\n";
    const current = "---\nid: hello\ntitle: Hello\n---\n# Hello\n\nKeep\nAfter\n";
    const { app, dir } = localGitApp({ "hello.md": base });
    writeFileSync(join(dir, "hello.md"), current);
    const [hunk] = suggestingHunks(base, current);
    expect(hunk).toMatchObject({ kind: "delete" });
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/revert", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        hunk,
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; hunks: unknown[] };
    expect(body.content).toBe(base);
    expect(body.hunks).toEqual([]);
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toBe(base);
  });

  it("rejects stale suggesting revert and checkpoint writes", async () => {
    const base = "---\nid: hello\n---\n# Hello\n\nOld\n";
    const current = "---\nid: hello\n---\n# Hello\n\nNew\n";
    const { app, dir } = localGitApp({ "hello.md": base });
    writeFileSync(join(dir, "hello.md"), current);
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };
    writeFileSync(join(dir, "hello.md"), "---\nid: hello\n---\n# Hello\n\nExternal\n");
    const [hunk] = suggestingHunks(base, current);

    const revert = await app.request("/api/v1/repos/me/notes/local-suggesting/revert", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        hunk,
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(revert.status).toBe(409);
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toContain("External");

    const checkpoint = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(checkpoint.status).toBe(409);
    expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  });

  it("requires suggesting mutation callers to send the reviewed HEAD and file SHA", async () => {
    const base = "---\nid: hello\n---\n# Hello\n\nOld\n";
    const current = "---\nid: hello\n---\n# Hello\n\nNew\n";
    const { app, dir } = localGitApp({ "hello.md": base });
    writeFileSync(join(dir, "hello.md"), current);
    const [hunk] = suggestingHunks(base, current);

    const revert = await app.request("/api/v1/repos/me/notes/local-suggesting/revert", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "hello.md", hunk }),
    });
    expect(revert.status).toBe(400);
    expect(readFileSync(join(dir, "hello.md"), "utf8")).toBe(current);

    const checkpoint = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "hello.md" }),
    });
    expect(checkpoint.status).toBe(400);
    expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
  });

  it("commits the active file as a checkpoint and advances the suggesting base", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/notes", (event) => events.push(event));
    const { app, dir } = localGitApp({ "hello.md": "# Hello\n" }, { sse });
    writeFileSync(join(dir, "hello.md"), "# Checkpoint\n");
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit_sha: string; base_text: string; head_sha: string };
    expect(body.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.base_text).toBe("# Checkpoint\n");
    expect(body.head_sha).toBe(body.commit_sha);
    expect(git(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("Checkpoint: hello.md");
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
    unsubscribe();
    expect(events).toContainEqual({ type: "git_changed", action: "committed", sha: body.commit_sha, paths: ["hello.md"] });
  });

  it("commits an untracked active file as a suggesting checkpoint", async () => {
    const { app, dir } = localGitApp({ "README.md": "# Seed\n" });
    writeFileSync(join(dir, "new.md"), "# New\n");
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=new.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };

    const res = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "new.md",
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit_sha: string; base_text: string; head_sha: string };
    expect(body.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.base_text).toBe("# New\n");
    expect(body.head_sha).toBe(body.commit_sha);
    expect(git(dir, ["status", "--porcelain", "--", "new.md"]).trim()).toBe("");
    expect(git(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("Checkpoint: new.md");
  });

  it("rejects a suggesting checkpoint after another checkpoint advanced HEAD", async () => {
    const { app, dir } = localGitApp({ "hello.md": "---\nid: hello\n---\n# Hello\n" });
    writeFileSync(join(dir, "hello.md"), "---\nid: hello\n---\n# Changed\n");
    const loaded = (await (await app.request("/api/v1/repos/me/notes/local-suggesting/base?path=hello.md")).json()) as {
      head_sha: string;
      current_sha: string;
    };

    const first = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(first.status).toBe(200);

    const stale = await app.request("/api/v1/repos/me/notes/local-suggesting/checkpoint", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        path: "hello.md",
        expected_head_sha: loaded.head_sha,
        expected_sha: loaded.current_sha,
      }),
    });
    expect(stale.status).toBe(409);
    expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
  });

  it("rejects an origin-less (cross-origin) mutation with 403", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json" }, // no Origin/Referer — a cross-origin page
      body: JSON.stringify({ content: "# x\n" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s a workspace that is not the one this Workbench serves", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/someone/else/file?path=hello.md&branch=main");
    expect(res.status).toBe(404);
  });

  it("renders the workspace switcher at home, linking each registered workspace", async () => {
    const { app } = localApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="workspace-list"');
    // The single registered workspace is listed and links to its landing.
    expect(body).toContain('href="/me/notes"');
    // A local-only folder (no git upstream) is labelled as such.
    expect(body).toContain("Local-only workspace");
    expect(body).toContain("Collaboration features need a connected Cosheaf server");
  });

  it("labels the PR tab as remote server collaboration when disconnected", async () => {
    const { app } = localApp();
    const res = await app.request("/me/notes/pulls");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Remote pull requests");
    expect(body).toContain("Local git state only");
    expect(body).toContain("no connected Cosheaf server");
    expect(body).toContain("open remote pull requests");
  });

  // A workspace WITH a connected core (#268): the shared collaboration routes are
  // mounted locally and read the connected core through ctx.collab (an
  // OriginCollaborationClient). Stub global fetch so the Origin API calls resolve
  // without a live server.
  function connectedApp(): { app: Hono<AppEnv> } {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-connected-"));
    writeFileSync(join(dir, "hello.md"), "# Hello\n");
    const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
    const db = freshTestDb("cosheaf-local-connected-db-");
    const backend = new LocalGitWorkspaceBackend(dir);
    const registry = new WorkspaceRegistry(db, { user: "me" });
    registry.register({
      slug: workspaceSlug(IDENTITY.owner, IDENTITY.repo),
      path: dir,
      identity: { ...IDENTITY, canOpenPull: true },
      backend,
      remote: { url: "https://core.example", token: "tok" },
      gitRemote: null,
    });
    const app = createApp({ config, db, localRegistry: registry });
    return { app };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the issues page against a connected core via the shared route", async () => {
    const { app } = connectedApp();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/issues")) {
        return Response.json({
          issues: [
            {
              number: 7,
              title: "Connected core issue",
              state: "open",
              author_username: "me",
              labels: [],
              comment_count: 0,
              created_at: 0,
              updated_at: 0,
            },
          ],
        });
      }
      if (url.includes("/labels")) return Response.json({ labels: [] });
      if (url.includes("/milestones")) return Response.json({ milestones: [] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.request("/me/notes/issues");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Connected core issue");
    // The shared issues route called the Origin API on the connected core.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("https://core.example/api/v1/repos/me/notes/issues"))).toBe(true);
  });

  it("shows the Connect prompt on a collaboration surface when no core is connected", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/me/notes/issues");
    expect(res.status).toBe(200);
    const body = await res.text();
    // The connect gate intercepts before ctx.collab is called (no NoCoreConnectedError).
    expect(body).toContain("no connected Cosheaf server");
    expect(body).toContain('data-testid="connect-form"');
  });

  it("renders saved remote server API keys on the Workbench remotes page and connect prompt", async () => {
    const { app, registry } = localApp({ "hello.md": "# Hello\n" });
    registry.saveRemote({
      url: "https://core.example",
      token: "tok",
      username: "alice",
      label: "Alice prod",
    });

    const page = await app.request("/_remotes");
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Remote servers");
    expect(body).toContain('data-testid="remote-list"');
    expect(body).toContain("core.example");
    expect(body).toContain("Alice prod");

    const prompt = await app.request("/me/notes/pulls");
    expect(prompt.status).toBe(200);
    const promptBody = await prompt.text();
    expect(promptBody).toContain('data-testid="connect-saved-form"');
    expect(promptBody).toContain('data-testid="connect-saved-remote"');
    expect(promptBody).toContain("Alice prod (alice)");
  });

  it("saves a validated remote key from the Workbench remotes page", async () => {
    const { app, registry } = localApp();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ user: { username: "alice" } }));
    vi.stubGlobal("fetch", fetchMock);

    const form = new URLSearchParams({
      url: "https://core.example/",
      token: "tok",
      label: "Alice prod",
    });
    const res = await app.request("/_remotes/add", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form,
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("Saved%20core.example");
    expect(registry.getSavedRemotes()).toHaveLength(1);
    expect(registry.getSavedRemotes()[0]).toMatchObject({
      url: "https://core.example",
      token: "tok",
      username: "alice",
      label: "Alice prod",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example/api/v1/me");
  });

  it("connects a local workspace using a saved remote key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-saved-remote-"));
    writeFileSync(join(dir, "hello.md"), "# Hello\n");
    const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
    const db = freshTestDb("cosheaf-local-saved-remote-db-");
    const registry = new WorkspaceRegistry(db, { user: "me" });
    const entry = await registry.addFolder(dir);
    const saved = registry.saveRemote({
      url: "https://core.example",
      token: "tok",
      username: "alice",
      label: "Alice prod",
    });
    const app = createApp({ config, db, localRegistry: registry });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: { username: "alice" } })));

    const form = new URLSearchParams({ remote_id: saved?.id ?? "" });
    const res = await app.request(`/${entry.identity.owner}/${entry.identity.repo}/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form,
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`/${entry.identity.owner}/${entry.identity.repo}/pulls`);
    expect(JSON.parse(readFileSync(join(dir, ".cosheaf", "remote.json"), "utf8"))).toEqual({
      url: "https://core.example",
      token: "tok",
    });
    expect(registry.get(entry.slug)?.remote).toEqual({ url: "https://core.example", token: "tok" });
  });

  it("maps disconnected typed collaboration API requests to a stable not-found envelope", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/issues");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: "not_found",
      error: "no connected Cosheaf server",
    });
  });

  it("serves an empty local annotation queue when the sidecar is absent", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/local-annotations/unresolved");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      annotations: [],
    });
  });

  it("serves unresolved local annotations with source excerpts for agents", async () => {
    const { app } = localApp({
      "paper.md": [
        "# Paper",
        "",
        "Before.",
        "Needs work.[@local:la_aaaaaaaaaaaa]",
        "After.",
        "",
      ].join("\n"),
      ".cosheaf/local-annotations.json": JSON.stringify({
        annotations: {
          la_aaaaaaaaaaaa: {
            id: "la_aaaaaaaaaaaa",
            path: "paper.md",
            anchor: "[@local:la_aaaaaaaaaaaa]",
            kind: "task",
            status: "open",
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            messages: [{
              id: "msg_aaaaaaaaaaaa",
              author: "me",
              created_at: "2026-07-02T00:00:00Z",
              body: "Clarify this step.",
            }],
          },
          la_bbbbbbbbbbbb: {
            id: "la_bbbbbbbbbbbb",
            path: "paper.md",
            anchor: "[@local:la_bbbbbbbbbbbb]",
            kind: "comment",
            status: "resolved",
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            messages: [{
              id: "msg_bbbbbbbbbbbb",
              author: "me",
              created_at: "2026-07-02T00:00:00Z",
              body: "Already handled.",
            }],
          },
        },
      }),
    });

    const res = await app.request("/api/v1/repos/me/notes/local-annotations/unresolved");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      annotations: [
        {
          id: "la_aaaaaaaaaaaa",
          anchor: "[@local:la_aaaaaaaaaaaa]",
          path: "paper.md",
          kind: "task",
          status: "open",
          messages: [{ author: "me", created_at: "2026-07-02T00:00:00Z", body: "Clarify this step." }],
          context: {
            line: 4,
            excerpt: "Before.\nNeeds work.[@local:la_aaaaaaaaaaaa]\nAfter.",
            anchor_found: true,
          },
        },
      ],
    });
  });

  it("serves all local annotations and toggles their status", async () => {
    const { app, dir } = localApp({
      "paper.md": "Needs work.[@local:la_aaaaaaaaaaaa]\nDone.[@local:la_bbbbbbbbbbbb]\n",
      ".cosheaf/local-annotations.json": JSON.stringify({
        annotations: {
          la_aaaaaaaaaaaa: {
            id: "la_aaaaaaaaaaaa",
            path: "paper.md",
            anchor: "[@local:la_aaaaaaaaaaaa]",
            kind: "task",
            status: "open",
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            messages: [{
              id: "msg_aaaaaaaaaaaa",
              author: "me",
              created_at: "2026-07-02T00:00:00Z",
              body: "Clarify this step.",
            }],
          },
          la_bbbbbbbbbbbb: {
            id: "la_bbbbbbbbbbbb",
            path: "paper.md",
            anchor: "[@local:la_bbbbbbbbbbbb]",
            kind: "comment",
            status: "resolved",
            created_at: "2026-07-02T00:00:00Z",
            updated_at: "2026-07-02T00:00:00Z",
            messages: [{
              id: "msg_bbbbbbbbbbbb",
              author: "me",
              created_at: "2026-07-02T00:00:00Z",
              body: "Already handled.",
            }],
          },
        },
      }),
    });

    const list = await app.request("/api/v1/repos/me/notes/local-annotations");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      annotations: [
        { id: "la_aaaaaaaaaaaa", status: "open" },
        { id: "la_bbbbbbbbbbbb", status: "resolved" },
      ],
    });

    const updated = await app.request("/api/v1/repos/me/notes/local-annotations/la_aaaaaaaaaaaa", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ annotation: { id: "la_aaaaaaaaaaaa", status: "resolved" } });

    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "local-annotations.json"), "utf8")) as {
      annotations: Record<string, { status: string }>;
    };
    expect(sidecar.annotations.la_aaaaaaaaaaaa?.status).toBe("resolved");
  });

  it("renders the edit page in direct write-mode with PR affordances off", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/me/notes/src/branch/main/hello.md?mode=edit");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-write-mode="direct"');
    expect(body).toContain('data-can-open-pull="0"');
    expect(body).toContain('data-origin-id="local-test-origin"');
    expect(body).toContain('data-branch="main"');
  });
});
