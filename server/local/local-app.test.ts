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
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
  originId: "local-test-origin",
};

function localApp(seed: Record<string, string> = {}): { app: Hono<AppEnv>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-app-"));
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("cosheaf-local-app-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  const app = createApp({ config, db, localRegistry: testLocalRegistry(db, backend, IDENTITY, dir) });
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
    const { app, dir } = localApp({ "hello.md": "# Hello\n" });
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
      count: 0,
      sidecar: ".cosheaf/local-annotations.json",
    });
  });

  it("serves unresolved local annotations with source excerpts for agents", async () => {
    const { app } = localApp({
      "paper.md": [
        "# Paper",
        "",
        "Before.",
        "Needs work.[@local:a1]",
        "After.",
        "",
      ].join("\n"),
      ".cosheaf/local-annotations.json": JSON.stringify({
        annotations: [
          {
            id: "a1",
            path: "paper.md",
            kind: "task",
            status: "open",
            messages: [{ author: "me", timestamp: "2026-07-02T00:00:00Z", text: "Clarify this step." }],
          },
          {
            id: "done",
            path: "paper.md",
            kind: "comment",
            status: "resolved",
            messages: [{ text: "Already handled." }],
          },
        ],
      }),
    });

    const res = await app.request("/api/v1/repos/me/notes/local-annotations/unresolved");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      count: 1,
      annotations: [
        {
          id: "a1",
          anchor: "local:a1",
          path: "paper.md",
          kind: "task",
          status: "open",
          messages: [{ author: "me", timestamp: "2026-07-02T00:00:00Z", text: "Clarify this step." }],
          source_excerpt: {
            line: 4,
            start_line: 2,
            end_line: 6,
            text: "\nBefore.\nNeeds work.[@local:a1]\nAfter.\n",
          },
        },
      ],
    });
  });

  it("serves all local annotations and toggles their status", async () => {
    const { app, dir } = localApp({
      "paper.md": "Needs work.[@local:a1]\nDone.[@local:done]\n",
      ".cosheaf/local-annotations.json": JSON.stringify({
        annotations: [
          { id: "a1", path: "paper.md", kind: "task", status: "open", messages: [{ text: "Clarify this step." }] },
          { id: "done", path: "paper.md", kind: "comment", status: "resolved", messages: [{ text: "Already handled." }] },
        ],
      }),
    });

    const list = await app.request("/api/v1/repos/me/notes/local-annotations");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      count: 2,
      annotations: [
        { id: "a1", status: "open", source_excerpt: { line: 1 } },
        { id: "done", status: "resolved", source_excerpt: { line: 2 } },
      ],
    });

    const updated = await app.request("/api/v1/repos/me/notes/local-annotations/a1", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ annotation: { id: "a1", status: "resolved" } });

    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "local-annotations.json"), "utf8")) as {
      annotations: Array<{ id: string; status: string }>;
    };
    expect(sidecar.annotations.find((entry) => entry.id === "a1")?.status).toBe("resolved");
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
