import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import type { WorkspaceValidation } from "../../shared/validation.js";
import { indexCitationFile, indexPage } from "../indexer.js";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import { _clearTreeCacheForTests } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { _clearBranchRefCacheForTests, files, safeRel } from "./files.js";
import {
  fakeForgejo,
  fakeWorkspaceBackend,
  freshTestDb,
  seedTestWorkspace,
  testApp,
  testConfig,
  testLocalRouteApp,
} from "./test-fixtures.js";

const config = testConfig("files");

function freshDb(defaultMdFormat = COFLAT_FORMAT_ID): Database.Database {
  const db = freshTestDb("cosheaf-files-");
  seedTestWorkspace(db, { default_md_format: defaultMdFormat });
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/api/v1/repos", files));
}

function localFilesAppFor(db: Database.Database, backend = fakeWorkspaceBackend()): Hono<AppEnv> {
  return testLocalRouteApp(db, config, backend, (app) => app.route("/api/v1/repos", files));
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
  _clearBranchRefCacheForTests();
  _clearTreeCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function seedStaleXrefs(db: Database.Database): void {
  db.prepare("INSERT INTO doc_map (workspace_slug, cosheaf_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("owner/w", "source", "source.md", "Source", "2026-06-16T00:00:00Z");
  db.prepare("INSERT INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)")
    .run("owner/w", "source", "source.md", "thm:stale", "[@thm:stale]", 3);
  db.prepare("INSERT INTO xref_targets (workspace_slug, target_id, source_path, kind, display_label, line) VALUES (?, ?, ?, ?, ?, ?)")
    .run("owner/w", "thm:stale", "stale.md", "block", "Theorem 1", 7);
  db.prepare("INSERT INTO xref_target_duplicates (workspace_slug, target_id, source_path, count) VALUES (?, ?, ?, ?)")
    .run("owner/w", "thm:dup", "stale.md", 2);
}

describe("safeRel repo-path validator", () => {
  // Imported via the route module's export so all consumers share one
  // implementation (#22). Each accept/reject case exercises a documented
  // rule from the helper's comment.
  it("accepts safe nested paths", () => {
    for (const p of ["a.md", "docs/intro.md", "deep/nested/x.md", "assets/img.png"]) {
      expect(safeRel(p)).toBe(p);
    }
  });
  it("rejects empty / undefined", () => {
    expect(safeRel(undefined)).toBeNull();
    expect(safeRel("")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(safeRel("/etc/passwd")).toBeNull();
    expect(safeRel("\\windows\\path")).toBeNull();
  });
  it("rejects traversal segments", () => {
    expect(safeRel("..")).toBeNull();
    expect(safeRel("../etc/passwd")).toBeNull();
    expect(safeRel("docs/../escape")).toBeNull();
    expect(safeRel("docs/./loop")).toBeNull();
  });
  it("rejects encoded traversal forms", () => {
    expect(safeRel("docs/%2e%2e/escape")).toBeNull();
    expect(safeRel("docs/%2E%2E/escape")).toBeNull();
    expect(safeRel("docs%2fescape")).toBeNull();
    expect(safeRel("docs%5cintro.md")).toBeNull();
  });
  it("rejects backslashes (Forgejo treats / as the only separator)", () => {
    expect(safeRel("docs\\intro.md")).toBeNull();
  });
  it("rejects control characters", () => {
    expect(safeRel("docs/intro\x00.md")).toBeNull();
    expect(safeRel("docs/\nintro.md")).toBeNull();
  });
  it("rejects empty segments", () => {
    expect(safeRel("docs//intro.md")).toBeNull();
    expect(safeRel("docs/")).toBeNull();
  });
});

describe("Gitea-shaped contents compatibility", () => {
  it("GET /contents/:path returns base64 file content", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/hello.md", () => new Response("# Hello\n"));
      forge.get("/api/v1/repos/owner/w/contents/hello.md", () =>
        Response.json({ name: "hello.md", path: "hello.md", sha: "blob-sha", size: 8, type: "file" }));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/contents/hello.md?ref=main", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; sha: string; encoding: string; content: string };
    expect(body.path).toBe("hello.md");
    expect(body.sha).toBe("blob-sha");
    expect(body.encoding).toBe("base64");
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("# Hello\n");
  });

  it("POST /contents/:path writes Markdown through Cosheaf frontmatter handling", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let writtenBody: unknown = null;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/agent%2Ftea", () => new Response("not found", { status: 404 }));
      forge.post("/api/v1/repos/owner/w/branches", () => Response.json({ name: "agent/tea" }, { status: 201 }));
      forge.get("/api/v1/repos/owner/w/contents/notes/tea.md", () => new Response("not found", { status: 404 }));
      forge.post("/api/v1/repos/owner/w/contents/notes/tea.md", async (c) => {
        writtenBody = await c.req.json();
        return Response.json({ commit: { sha: "commit-sha" }, content: { sha: "new-sha" } }, { status: 201 });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/contents/notes/tea.md", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        branch: "main",
        new_branch: "agent/tea",
        message: "Create tea note",
        content: Buffer.from("# Tea note\n\nBody.\n", "utf8").toString("base64"),
      }),
    });

    expect(res.status).toBe(201);
    expect(writtenBody).toMatchObject({
      branch: "agent/tea",
      message: "Create tea note",
    });
    const encoded = (writtenBody as { content: string }).content;
    const written = Buffer.from(encoded, "base64").toString("utf8");
    expect(written).toContain("id:");
    expect(written).toContain("# Tea note");
    const body = await res.json() as { content: { path: string; sha: string; content: string }; commit: { sha: string } };
    expect(body.content.path).toBe("notes/tea.md");
    expect(body.content.sha).toBe("new-sha");
    expect(body.commit.sha).toBe("commit-sha");
  });

  it("PUT /contents/:path without a sha refuses to overwrite an existing file (#277)", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let wrote = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/work", () => Response.json({ name: "work", commit: { id: "head-sha" } }));
      forge.get("/api/v1/repos/owner/w/contents/exists.md", () =>
        Response.json({ path: "exists.md", sha: "current-sha", content: Buffer.from("old\n", "utf8").toString("base64"), encoding: "base64" }),
      );
      forge.put("/api/v1/repos/owner/w/contents/exists.md", () => {
        wrote = true;
        return Response.json({ commit: { sha: "x" }, content: { sha: "y" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/contents/exists.md", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ branch: "work", message: "blind overwrite", content: Buffer.from("new\n", "utf8").toString("base64") }),
    });

    expect(res.status).toBe(409);
    expect((await res.json() as { details: { current_sha: string } }).details.current_sha).toBe("current-sha");
    expect(wrote).toBe(false);
  });
});

describe("files validation route", () => {
  it("reports broken references with source lines and orphan page ids", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "source.md",
      bodyText: "---\nid: source\n---\n# Source\n\nSee [@target], [@thm:target], [@missing], and [Gone](gone.md).\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "target.md",
      bodyText: "---\nid: target\n---\n# Target\n\n::: {#thm:target .theorem}\nTarget theorem.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "orphan.md",
      bodyText: "---\nid: orphan\n---\n# Orphan\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      broken_refs: [
        {
          source_id: "source",
          source_path: "source.md",
          source_title: "Source",
          target_id: "missing",
          target_label: "[@missing]",
          line: 6,
        },
        {
          source_id: "source",
          source_path: "source.md",
          source_title: "Source",
          target_id: null,
          target_label: "[Gone](gone.md)",
          line: 6,
        },
      ],
      duplicate_xrefs: [],
      orphan_labels: [
        { id: "orphan", path: "orphan.md", title: "Orphan" },
        { id: "source", path: "source.md", title: "Source" },
      ],
    });
  });

  it("does not report citations whose keys exist in a BibTeX companion file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexCitationFile(db, {
      workspaceSlug: "owner/w",
      filePath: "refs/main.bib",
      bodyText: "@article{BoysenKW19, title={Valid citation}}\n",
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "source.md",
      bodyText: [
        "---",
        "id: source",
        "bibliography: refs/main.bib",
        "---",
        "# Source",
        "",
        "See [@BoysenKW19], [@missing-page], and [@thm:missing].",
        "",
      ].join("\n"),
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceValidation;
    expect(body.broken_refs).toEqual([
      {
        source_id: "source",
        source_path: "source.md",
        source_title: "Source",
        target_id: "missing-page",
        target_label: "[@missing-page]",
        line: 7,
      },
      {
        source_id: "source",
        source_path: "source.md",
        source_title: "Source",
        target_id: "thm:missing",
        target_label: "[@thm:missing]",
        line: 7,
      },
    ]);
  });

  it("reports duplicate Coflat xref ids", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "a.md",
      bodyText: "---\nid: a\n---\n# A\n\n::: {#thm:dup .theorem}\nA.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "b.md",
      bodyText: "---\nid: b\n---\n# B\n\n::: {#thm:dup .theorem}\nB.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { duplicate_xrefs: Array<{ id: string; paths: string; count: number }> };
    expect(body.duplicate_xrefs).toEqual([{ id: "thm:dup", paths: "a.md, b.md", count: 2 }]);
  });

  it("reports duplicate Coflat xref ids inside one file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "a.md",
      bodyText: [
        "---",
        "id: a",
        "---",
        "# A",
        "",
        "::: {#thm:dup .theorem}",
        "A.",
        ":::",
        "",
        "::: {#thm:dup .theorem}",
        "B.",
        ":::",
        "",
      ].join("\n"),
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { duplicate_xrefs: Array<{ id: string; paths: string; count: number }> };
    expect(body.duplicate_xrefs).toEqual([{ id: "thm:dup", paths: "a.md (2 definitions)", count: 2 }]);
  });

  it("reports stale Coflat xref validation rows for Coflat workspaces", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    seedStaleXrefs(db);

    const res = await appFor(db).request("/api/v1/repos/owner/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceValidation;
    expect(body.duplicate_xrefs).toEqual([{ id: "thm:dup", paths: "stale.md (2 definitions)", count: 2 }]);
    expect(body.broken_refs).toEqual([]);
  });
});

describe("files refs route", () => {
  it("resolves page ids and Coflat theorem ids to file targets", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "target.md",
      bodyText: "---\nid: target\n---\n# Target\n\n::: {#thm:target .theorem}\nTarget theorem.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=target,thm:target,missing", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [
        { id: "target", path: "target.md", kind: "page", label: "Target" },
        { id: "thm:target", path: "target.md", kind: "block", label: "Theorem 1", fragment: "thm:target", line: 6 },
      ],
      ambiguous_refs: [],
    });
  });

  it("does not silently resolve duplicate Coflat theorem ids", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    for (const filePath of ["a.md", "b.md"]) {
      indexPage(db, {
        workspaceSlug: "owner/w",
        filePath,
        bodyText: `---\nid: ${filePath[0]}\n---\n# ${filePath[0].toUpperCase()}\n\n::: {#thm:dup .theorem}\nDuplicate.\n:::\n`,
        formatId: COFLAT_FORMAT_ID,
      });
    }

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=thm:dup", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [],
      ambiguous_refs: [{ id: "thm:dup", paths: ["a.md", "b.md"] }],
    });
  });

  it("does not silently resolve duplicate Coflat theorem ids inside one file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "a.md",
      bodyText: "---\nid: a\n---\n# A\n\n::: {#thm:dup .theorem}\nA.\n:::\n\n::: {#thm:dup .theorem}\nB.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=thm:dup", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [],
      ambiguous_refs: [{ id: "thm:dup", paths: ["a.md (2 definitions)"] }],
    });
  });

  it("exposes stale Coflat xrefs for Coflat workspaces", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    seedStaleXrefs(db);

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=thm:stale,thm:dup", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [
        { id: "thm:stale", path: "stale.md", kind: "block", label: "Theorem 1", fragment: "thm:stale", line: 7 },
      ],
      ambiguous_refs: [],
    });
  });

  it("resolves refs from the requested branch instead of the main sidecar", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "main.md",
      bodyText: "---\nid: main-page\n---\n# Main\n\n::: {#thm:main .theorem}\nMain theorem.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
        expect(c.req.param("ref")).toBe("user/alice/wip");
        return c.json({
          tree: [{ path: "draft.md", type: "blob", size: 200, sha: "draft-sha" }],
          truncated: false,
        });
      });
      forge.get("/api/v1/repos/owner/w/raw/draft.md", (c) => {
        expect(c.req.query("ref")).toBe("user/alice/wip");
        return c.text("---\nid: branch-page\ntitle: Branch Page\n---\n# Branch\n\n::: {#thm:branch .theorem}\nBranch theorem.\n:::\n");
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=branch-page,thm:branch,thm:main&ref=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [
        { id: "branch-page", path: "draft.md", kind: "page", label: "Branch Page" },
        { id: "thm:branch", path: "draft.md", kind: "block", label: "Theorem 1", fragment: "thm:branch", line: 7 },
      ],
      ambiguous_refs: [],
    });
  });

  it("does not silently resolve duplicate branch-local refs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", () =>
        Response.json({
          tree: [
            { path: "a.md", type: "blob", size: 200, sha: "a-sha" },
            { path: "b.md", type: "blob", size: 200, sha: "b-sha" },
          ],
          truncated: false,
        }),
      );
      forge.get("/api/v1/repos/owner/w/raw/:path", (c) => {
        const name = c.req.param("path");
        return c.text(`---\nid: ${name[0]}\n---\n# ${name}\n\n::: {#thm:dup .theorem}\nDuplicate.\n:::\n`);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=thm:dup&ref=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [],
      ambiguous_refs: [{ id: "thm:dup", paths: ["a.md", "b.md"] }],
    });
  });

  it("does not cap branch-local refs during render resolution", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    const tree = Array.from({ length: 81 }, (_, index) => ({
      path: index === 80 ? "target.md" : `filler-${index}.md`,
      type: "blob",
      size: 200,
      sha: `sha-${index}`,
    }));
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", () => Response.json({ tree, truncated: false }));
      forge.get("/api/v1/repos/owner/w/raw/:path", (c) => {
        const name = c.req.param("path");
        return c.text(name === "target.md"
          ? "---\nid: target-page\ntitle: Target Page\n---\n# Target\n"
          : `---\nid: filler-${name}\n---\n# Filler\n`);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/refs?ids=target-page&ref=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refs: [{ id: "target-page", path: "target.md", kind: "page", label: "Target Page" }],
      ambiguous_refs: [],
    });
  });
});

describe("files suggest route", () => {
  it("defaults malformed limits before querying SQLite", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    for (let i = 0; i < 12; i += 1) {
      indexPage(db, {
        workspaceSlug: "owner/w",
        filePath: `note-${i}.md`,
        bodyText: `---\nid: alpha-${i}\n---\n# Alpha ${i}\n`,
        formatId: COFLAT_FORMAT_ID,
      });
    }

    for (const limit of ["abc", "1.5"]) {
      const res = await appFor(db).request(`/api/v1/repos/owner/w/suggest?prefix=alpha&limit=${limit}`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { suggestions: Array<{ id: string; insert: string }> };
      expect(body.suggestions).toHaveLength(10);
      expect(body.suggestions[0].id).toBe("alpha-0");
      expect(body.suggestions[0].insert).toBe("[@alpha-0]");
    }
  });

  it("suggests stale Coflat xrefs for Coflat workspaces", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    seedStaleXrefs(db);

    const res = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=thm", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestions: [
        { id: "thm:stale", display: "thm:stale — Theorem 1 (stale.md)", insert: "[@thm:stale]" },
      ],
    });
  });

  it("adds branch-local page ids and Coflat labels that are not indexed on main", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    let rawFetches = 0;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
        expect(c.req.param("ref")).toBe("user/alice/wip");
        return c.json({
          tree: [
            { path: "draft.md", type: "blob", size: 200, sha: "draft-sha" },
            { path: "image.png", type: "blob", size: 20 },
          ],
          truncated: false,
        });
      });
      forge.get("/api/v1/repos/owner/w/raw/draft.md", (c) => {
        rawFetches++;
        expect(c.req.query("ref")).toBe("user/alice/wip");
        return c.text("---\nid: branch-page\ntitle: Branch Page\n---\n# Branch\n\n::: {#thm:branch .theorem}\nBranch theorem.\n:::\n");
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=branch&branch=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestions: [
        { id: "branch-page", insert: "[@branch-page]", display: "branch-page — Branch Page (draft.md)" },
      ],
    });

    const theoremRes = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=thm&branch=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(theoremRes.status).toBe(200);
    expect(await theoremRes.json()).toEqual({
      suggestions: [
        { id: "thm:branch", insert: "[@thm:branch]", display: "thm:branch — Theorem 1 (draft.md)" },
      ],
    });
    expect(rawFetches).toBe(1);
  });

  it("does not let indexed main suggestions crowd out branch-local refs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    for (let i = 0; i < 12; i += 1) {
      indexPage(db, {
        workspaceSlug: "owner/w",
        filePath: `main-${i}.md`,
        bodyText: `---\nid: alpha-main-${i}\n---\n# Alpha Main ${i}\n`,
        formatId: COFLAT_FORMAT_ID,
      });
    }
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", () =>
        Response.json({ tree: [{ path: "draft.md", type: "blob", size: 200, sha: "draft-sha" }], truncated: false }),
      );
      forge.get("/api/v1/repos/owner/w/raw/draft.md", () =>
        new Response("---\nid: alpha-branch-local-extra-long\ntitle: Alpha Branch\n---\n# Branch\n"),
      );
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=alpha&branch=user%2Falice%2Fwip&limit=10", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ id: string }> };
    expect(body.suggestions[0]?.id).toBe("alpha-branch-local-extra-long");
    expect(body.suggestions).toHaveLength(10);
  });

  it("uses the Coflat parser for branch-local page title suggestions", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", () =>
        Response.json({ tree: [{ path: "draft.md", type: "blob", size: 200, sha: "draft-sha" }], truncated: false }),
      );
      forge.get("/api/v1/repos/owner/w/raw/draft.md", () =>
        new Response("---\nid: branch-page\n---\n```md\n# Not The Title\n```\n\n# Real Branch Title\n"),
      );
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=branch&branch=user%2Falice%2Fwip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suggestions: [
        { id: "branch-page", insert: "[@branch-page]", display: "branch-page — Real Branch Title (draft.md)" },
      ],
    });
  });
});

describe("files read route", () => {
  it("returns the file content and blob sha for compare-and-set saves", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        expect(c.req.param("name")).toBe("user/alice/wip");
        return c.json({ name: "user/alice/wip", commit: { id: "wip-head" } });
      });
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        expect(c.req.query("ref")).toBe("wip-head");
        return c.text("# Notes\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        expect(c.req.query("ref")).toBe("wip-head");
        return c.json({ sha: "blob-sha" });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "# Notes\n", sha: "blob-sha" });
  });

  it("returns a null CAS sha when falling back to main for an existing branch missing the file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        if (c.req.query("ref") === "wip-head") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.text("# Main Notes\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "wip-head") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.json({ sha: "main-sha" });
      });
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        if (c.req.param("name") === "main") return c.json({ name: "main", commit: { id: "main-head" } });
        expect(c.req.param("name")).toBe("user/alice/wip");
        return c.json({ name: "user/alice/wip", commit: { id: "wip-head" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "# Main Notes\n", sha: null, source_ref: "main", source_sha: "main-sha" });
  });

  it("returns the main sha when falling back for a branch that will be created from main", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.text("# Main Notes\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.json({ sha: "main-sha" });
      });
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        if (c.req.param("name") === "main") return c.json({ name: "main", commit: { id: "main-head" } });
        expect(c.req.param("name")).toBe("user/alice/new");
        return c.text("not found", 404);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/new", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "# Main Notes\n", sha: "main-sha", source_ref: "main", source_sha: "main-sha" });
  });

  it("keeps the fallback CAS base from the initial missing-branch snapshot", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    let branchLookups = 0;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.text("# Main Notes\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main-head");
        return c.json({ sha: "main-sha" });
      });
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        if (c.req.param("name") === "main") return c.json({ name: "main", commit: { id: "main-head" } });
        expect(c.req.param("name")).toBe("user/alice/new");
        branchLookups++;
        return branchLookups === 1
          ? c.text("not found", 404)
          : c.json({ name: "user/alice/new", commit: { id: "created-after-read-start" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/new", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "# Main Notes\n", sha: "main-sha", source_ref: "main", source_sha: "main-sha" });
    expect(branchLookups).toBe(1);
  });

  it("does not treat a transient branch lookup failure as a missing branch during file fallback", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/wip") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main");
        return c.text("# Main Notes\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "user/alice/wip") return c.text("not found", 404);
        expect(c.req.query("ref")).toBe("main");
        return c.json({ sha: "main-sha" });
      });
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.text("temporary Forgejo failure", 500));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(500);
  });

  it("pins file content and metadata reads to one branch-head snapshot", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        expect(c.req.param("name")).toBe("user/alice/wip");
        return c.json({ name: "user/alice/wip", commit: { id: "head-snapshot" } });
      });
      forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
        expect(c.req.query("ref")).toBe("head-snapshot");
        return c.text("# Notes from snapshot\n");
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        expect(c.req.query("ref")).toBe("head-snapshot");
        return c.json({ sha: "snapshot-blob" });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "# Notes from snapshot\n", sha: "snapshot-blob" });
  });
});

describe("files mutation gates", () => {
  it("rejects invalid branch names before typed file operations reach Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const requests = [
      appFor(db).request("/api/v1/repos/owner/w/tree?branch=bad..branch", {
        headers: { authorization: `Bearer ${token}` },
      }),
      appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=bad..branch", {
        headers: { authorization: `Bearer ${token}` },
      }),
      appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=bad..branch", {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "# Notes\n" }),
      }),
      appFor(db).request("/api/v1/repos/owner/w/assets?branch=bad..branch", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new FormData(),
      }),
      appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=bad..branch", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    ];

    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "valid branch name required",
        code: "validation",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects read-only users before forwarding file writes to Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Notes\n" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "write access required", code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves malformed delimited yaml frontmatter instead of prepending generated metadata", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const source = [
      "---",
      "id: ztrcpji2",
      "bibliography: ref.bib",
      "title: \"Rank-k-reduction on matroid intersection\"",
      "math:",
      "\t\\cl: \"\\operatorname{cl}\"",
      "---",
      "",
      "body.",
      "",
    ].join("\n");
    let written = "";

    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/paper.md", (c) => c.text("not found", 404));
      forge.post("/api/v1/repos/owner/w/contents/paper.md", async (c) => {
        const body = (await c.req.json()) as { content: string };
        written = Buffer.from(body.content, "base64").toString("utf8");
        return c.json({ commit: { sha: "paper-commit" }, content: { sha: "paper-sha" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=paper.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: source }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; content?: string };
    expect(json.ok).toBe(true);
    expect(json.content).toBeUndefined();
    expect(written).toBe(source);
  });

  it("rejects asset uploads to main before forwarding to Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await appFor(db).request("/api/v1/repos/owner/w/assets?branch=main", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "branch required (cannot upload assets to main)",
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads assets into the cosheaf.yaml asset folder with readable filenames", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let uploadedPath = "";
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", (c) => {
        expect(c.req.query("ref")).toBe("user/alice/wip");
        return c.text("assets: figures\n");
      });
      forge.post("/api/v1/repos/owner/w/contents/figures/:name", async (c) => {
        uploadedPath = `figures/${c.req.param("name")}`;
        const body = (await c.req.json()) as { message: string; content: string; branch: string };
        expect(body.branch).toBe("user/alice/wip");
        expect(body.message).toBe("upload diagram.png");
        expect(Buffer.from(body.content, "base64").toString("utf8")).toBe("image-bytes");
        return c.json({ commit: { sha: "asset-commit" }, content: { sha: "asset-sha" } });
      });
    }));
    const form = new FormData();
    form.set("file", new File(["image-bytes"], "diagram.png", { type: "image/png" }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/assets?branch=user%2Falice%2Fwip", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/^figures\/diagram-[a-z0-9]+\.png$/);
    expect(uploadedPath).toBe(body.path);
  });

  it("does not publish unmerged branch markdown saves into the main sidecar", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Main Notes\n\nmain body\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "branch-sha" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", () =>
        Response.json({ commit: { sha: "branch-commit" }, content: { sha: "new-branch-sha" } }),
      );
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "---\nid: notes\n---\n# Branch Notes\n\nbranch-only body\n" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, branch: "user/alice/wip", commit: "branch-commit" });
    expect(
      db.prepare("SELECT title FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?").get("owner/w", "notes.md"),
    ).toEqual({ title: "Main Notes" });
    expect(
      db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = ? AND notes_fts MATCH ?").get("owner/w", "branch"),
    ).toEqual({ c: 0 });
  });

  it("does not move sidecar rows for a branch-only markdown rename", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });

    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/new.md", (c) => c.text("not found", 404));
      forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
        if (c.req.query("ref") === "main") return c.text("not found", 404);
        return c.json({ sha: "old-sha" });
      });
      forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
        const body = (await c.req.json()) as { message: string };
        expect(body.message).toBe("rename old.md to new.md");
        return c.json({ commit: { sha: "new-commit" } });
      });
      forge.delete("/api/v1/repos/owner/w/contents/old.md", (c) => c.body(null, 200));
      forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => c.text("not found", 404));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: new\n---\n# New\n" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, branch: "user/alice/wip", commit: "new-commit" });
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("rewrites branch content without moving the sidecar row for a branch-only markdown rename", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    let written = "";

    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/new.md", (c) => c.text("not found", 404));
      forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
        if (c.req.query("ref") === "main") return c.text("not found", 404);
        return c.json({ sha: "old-sha" });
      });
      forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
        const body = (await c.req.json()) as { content: string };
        written = Buffer.from(body.content, "base64").toString("utf8");
        return c.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
      });
      forge.delete("/api/v1/repos/owner/w/contents/old.md", (c) => c.body(null, 200));
      forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => c.text("not found", 404));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: old\n---\n# New\n" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: string; meta: { id: string | null } };
    expect(body.meta.id).toBe("old");
    expect(body.content).toBeUndefined();
    expect(written).toContain("id: old");
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ?")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("renames a fallback main file onto an existing branch when the source sha is fresh", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let deletedOld = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "branch-head" } }));
      forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
      forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
        if (c.req.query("ref") === "main") return c.json({ sha: "main-loaded" });
        return new Response("not found", { status: 404 });
      });
      forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
        const body = (await c.req.json()) as { message: string; sha?: string };
        expect(body).toMatchObject({ message: "rename old.md to new.md" });
        expect(body.sha).toBeUndefined();
        return c.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
      });
      forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
        deletedOld = true;
        return new Response(null, { status: 200 });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        previous_path: "old.md",
        content: "---\nid: new\n---\n# New\n",
        expected_sha: null,
        expected_source_sha: "main-loaded",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, branch: "user/alice/wip", commit: "new-commit", sha: "new-sha" });
    expect(deletedOld).toBe(false);
  });

  it("renaming a branch copy with the same id preserves the main sidecar row and rewrites the branch id", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    let written = "";

    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/new.md", (c) => c.text("not found", 404));
      forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => c.json({ sha: "old-sha" }));
      forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
        const body = (await c.req.json()) as { content: string };
        written = Buffer.from(body.content, "base64").toString("utf8");
        return c.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
      });
      forge.delete("/api/v1/repos/owner/w/contents/old.md", (c) => c.body(null, 200));
      forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => c.text("---\nid: old\n---\n# Old\n"));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: old\n---\n# New\n" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: string; meta: { id: string | null } };
    expect(body.meta.id).toBeTruthy();
    expect(body.meta.id).not.toBe("old");
    expect(body.content).toContain(`id: ${body.meta.id}`);
    expect(written).toContain(`id: ${body.meta.id}`);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w") as Array<{ cosheaf_id: string; forgejo_id: string }>;
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });
});

describe("files non-markdown text files (#178)", () => {
  it("writes a .bib file verbatim without indexing it as a page", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let written: string | undefined;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/refs.bib", (c) => c.text("not found", 404));
      forge.post("/api/v1/repos/owner/w/contents/refs.bib", async (c) => {
        const body = (await c.req.json()) as { content: string };
        written = Buffer.from(body.content, "base64").toString("utf8");
        return c.json({ commit: { sha: "bib-commit" }, content: { sha: "bib-sha" } });
      });
    }));

    const bib = "@book{knuth1984,\n  title={The TeXbook}\n}\n";
    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=refs.bib&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: bib }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; meta: { id: string | null }; content?: string };
    expect(json.ok).toBe(true);
    expect(json.meta.id).toBeNull(); // not a page
    expect(json.content).toBeUndefined(); // no frontmatter id was injected
    expect(written).toBe(bib); // committed verbatim, no YAML frontmatter added
    // It must NOT have been indexed as a page.
    const rows = db.prepare("SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ?").all("owner/w");
    expect(rows).toEqual([]);
  });

  it("still rejects a non-text (binary/image) path", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=logo.png&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid path", code: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a .bib file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/refs.bib", (c) => c.json({ sha: "bib-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/refs.bib", (c) => {
        deleted = true;
        return c.body(null, 200);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=refs.bib&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(deleted).toBe(true);
  });

  it("deletes a branch markdown file without removing global sidecar state", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "gone.md",
      bodyText: "---\nid: gone\n---\n# Gone\n\nSee [@missing].\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const events: unknown[] = [];
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/gone.md", (c) => c.json({ sha: "gone-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/gone.md", (c) => c.body(null, 200));
      forge.get("/api/v1/repos/owner/w/raw/gone.md", (c) => c.text("---\nid: gone\n---\n# Gone\n\nSee [@missing].\n"));
    }));
    const app = testApp(db, config, (hono) => {
      hono.use("*", (c, next) => {
        c.get("sse").subscribe("owner/w", (event) => events.push(event));
        return next();
      });
      hono.route("/api/v1/repos", files);
    });

    const res = await app.request("/api/v1/repos/owner/w/file?path=gone.md&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
    expect(events).toContainEqual({ type: "change", path: "gone.md" });
  });

  it("does not remove sidecar rows for branch-only markdown deletes", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "branch-only.md",
      bodyText: "---\nid: branch-only\n---\n# Branch only\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name") }));
      forge.get("/api/v1/repos/owner/w/contents/branch-only.md", (c) => c.json({ sha: "branch-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/branch-only.md", (c) => c.body(null, 200));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=branch-only.md&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
  });

  it("rejects a stale delete before removing a newer branch file", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head-now" } }));
      forge.get("/api/v1/repos/owner/w/contents/gone.md", (c) => c.json({ sha: "newer-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/gone.md", () => {
        deleted = true;
        return new Response(null);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=gone.md&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expected_sha: "old-sha" }),
    });

    expect(res.status).toBe(409);
    expect(deleted).toBe(false);
    expect(await res.json()).toMatchObject({
      code: "conflict",
      details: { expected_sha: "old-sha", current_sha: "newer-sha", branch_moved: true },
    });
  });

  it("rejects malformed delete JSON instead of deleting without CAS", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/contents/gone.md", () => Response.json({ sha: "current-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/gone.md", () => {
        deleted = true;
        return new Response(null);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=gone.md&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body", code: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleted).toBe(false);
  });

  it("accepts an empty JSON object delete body as no CAS token", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/contents/gone.md", () => Response.json({ sha: "current-sha" }));
      forge.delete("/api/v1/repos/owner/w/contents/gone.md", () => {
        deleted = true;
        return new Response(null, { status: 204 });
      });
      forge.get("/api/v1/repos/owner/w/raw/gone.md", (c) => c.text("not found", 404));
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=gone.md&branch=user/alice/wip", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(deleted).toBe(true);
  });

  it("does not create a missing branch as a side effect of delete", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const calls: string[] = [];
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/contents/gone.md", (c) => {
        expect(c.req.query("ref")).toBe("user/alice/typo");
        return c.text("not found", 404);
      });
      forge.post("/api/v1/repos/owner/w/branches", () => {
        calls.push("create-branch");
        return Response.json({ name: "user/alice/typo" });
      });
      forge.delete("/api/v1/repos/owner/w/contents/gone.md", () => {
        calls.push("delete-file");
        return new Response(null);
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=gone.md&branch=user/alice/typo", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("files concurrent-write conflicts (#92)", () => {
  function writeReq(db: ReturnType<typeof freshDb>, token: string, body: unknown) {
    return appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("continues when a concurrent writer creates the missing branch first", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const calls: string[] = [];
    let branchExists = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", () =>
        branchExists
          ? Response.json({ name: "user/alice/wip", commit: { id: "head-now" } })
          : new Response("not found", { status: 404 }),
      );
      forge.post("/api/v1/repos/owner/w/branches", async (c) => {
        calls.push("create-branch");
        const body = (await c.req.json()) as { new_branch_name: string; old_branch_name: string };
        expect(body).toMatchObject({ new_branch_name: "user/alice/wip", old_branch_name: "main" });
        branchExists = true;
        return new Response("branch already exists", { status: 409 });
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", () => new Response("not found", { status: 404 }));
      forge.post("/api/v1/repos/owner/w/contents/notes.md", () => {
        calls.push("write-file");
        return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-file-sha" } });
      });
    }));

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, commit: "new-commit", sha: "new-file-sha" });
    expect(calls).toEqual(["create-branch", "write-file"]);
  });

  it("maps a backend stale-sha error to a typed 409 with recovery details", async () => {
    const db = freshDb();
    const backend = fakeWorkspaceBackend({
      getBranch: async () => ({ name: "user/alice/wip", commit: { id: "head-now" } }),
      getFileMeta: async () => ({ sha: "sha-now", size: 8 }),
      putFile: async () => {
        throw new WorkspaceBackendError(409, "stale_sha", "branch head moved");
      },
    });

    const res = await localFilesAppFor(db, backend).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Notes\n" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe("conflict");
    expect(body.details).toMatchObject({ path: "notes.md", branch: "user/alice/wip", head_sha: "head-now", current_sha: "sha-now", branch_moved: true });
  });

  it("compare-and-set: rejects before writing when expected_sha is stale", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head-now" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", (c) => { putCalled = true; return c.json({ commit: { sha: "x" }, content: { sha: "y" } }); });
    }));

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: "based-on-old" });
    expect(res.status).toBe(409);
    expect(putCalled).toBe(false);
    const conflictBody = (await res.json()) as { details: Record<string, unknown> };
    expect(conflictBody.details).toMatchObject({ expected_sha: "based-on-old", current_sha: "current", branch_moved: true });
  });

  it("compare-and-set: proceeds and returns the new blob sha when expected_sha matches", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ commit: { sha: "new-commit" }, content: { sha: "new-blob" } }));
    }));

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: "current" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, commit: "new-commit", sha: "new-blob" });
  });

  it("compare-and-set: rejects before writing when the caller expected the file to be absent", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head-now" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "created-by-other-tab" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
        putCalled = true;
        return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-blob" } });
      });
    }));

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: null });

    expect(res.status).toBe(409);
    expect(putCalled).toBe(false);
    const conflictBody = (await res.json()) as { details: Record<string, unknown> };
    expect(conflictBody.details).toMatchObject({
      expected_sha: null,
      current_sha: "created-by-other-tab",
      branch_moved: true,
    });
  });

  it("compare-and-set: rejects fallback saves when the main source changed", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "branch-head" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "main") return c.json({ sha: "main-newer" });
        return c.text("not found", 404);
      });
      forge.post("/api/v1/repos/owner/w/contents/notes.md", () => {
        putCalled = true;
        return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-blob" } });
      });
    }));

    const res = await writeReq(db, token, {
      content: "# Notes\n",
      expected_sha: null,
      expected_source_sha: "main-loaded",
    });

    expect(res.status).toBe(409);
    expect(putCalled).toBe(false);
    expect(await res.json()).toMatchObject({
      code: "conflict",
      details: {
        path: "notes.md",
        branch: "user/alice/wip",
        source_ref: "main",
        expected_source_sha: "main-loaded",
        current_source_sha: "main-newer",
        branch_moved: true,
      },
    });
  });

  it("resets a retired default edit branch before the fallback save", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const calls: string[] = [];
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/pulls", (c) => {
        expect(c.req.query("state")).toBe("all");
        calls.push("list-pulls");
        return c.json([
          { number: 7, state: "closed", merged: false, head: { ref: "user/alice/web-edit" }, base: { ref: "main" } },
        ]);
      });
      forge.delete("/api/v1/repos/owner/w/branches/:name", (c) => {
        expect(c.req.param("name")).toBe("user/alice/web-edit");
        calls.push("delete-branch");
        return new Response(null, { status: 204 });
      });
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => {
        expect(c.req.param("name")).toBe("user/alice/web-edit");
        calls.push("get-branch");
        return c.text("not found", 404);
      });
      forge.post("/api/v1/repos/owner/w/branches", async (c) => {
        const body = (await c.req.json()) as { new_branch_name: string; old_branch_name: string };
        expect(body).toMatchObject({ new_branch_name: "user/alice/web-edit", old_branch_name: "main" });
        calls.push("create-branch");
        return c.json({ name: "user/alice/web-edit" });
      });
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
        if (c.req.query("ref") === "main") return c.json({ sha: "main-loaded" });
        expect(c.req.query("ref")).toBe("user/alice/web-edit");
        return c.text("not found", 404);
      });
      forge.post("/api/v1/repos/owner/w/contents/notes.md", () => {
        calls.push("write-file");
        return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-blob" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=notes.md&branch=user/alice/web-edit", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        content: "# Notes\n",
        expected_sha: null,
        expected_source_sha: "main-loaded",
        reset_edit_branch: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, commit: "new-commit", sha: "new-blob" });
    expect(calls).toEqual(["list-pulls", "delete-branch", "get-branch", "create-branch", "write-file"]);
  });

  it("compare-and-set: rejects malformed expected_sha instead of disabling CAS", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: 123 });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "expected_sha must be a string or null",
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compare-and-set: rejects non-string content before indexing or writing", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await writeReq(db, token, { content: null, expected_sha: null });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "content must be a string",
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compare-and-set: rejects malformed expected_source_sha instead of disabling fallback CAS", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: null, expected_source_sha: null });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "expected_source_sha must be a string",
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a rename from a non-editable source path before deleting it", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });

    const res = await writeReq(db, token, {
      previous_path: "assets/logo.png",
      content: "# Notes\n",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid previous_path",
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a CAS base sha after save even when Forgejo omits content from the write response", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current-after-save" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ commit: { sha: "new-commit" }, content: null }));
    }));

    const res = await writeReq(db, token, { content: "# Notes\n", expected_sha: "current-after-save" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, commit: "new-commit", sha: "current-after-save" });
  });

  it("rejects a rename when the source path is already missing", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    let putCalled = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "head-now" } }));
      forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
      forge.get("/api/v1/repos/owner/w/contents/old.md", () => new Response("not found", { status: 404 }));
      forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
        putCalled = true;
        return Response.json({ commit: { sha: "created-commit" }, content: { sha: "new-created" } });
      });
    }));

    const res = await appFor(db).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: new\n---\n# New\n" }),
    });

    expect(res.status).toBe(409);
    expect(putCalled).toBe(false);
    expect(await res.json()).toMatchObject({
      code: "conflict",
      details: { path: "old.md", branch_moved: true },
    });
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ?")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("rolls back a rename destination when deleting the source loses a sha race", async () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const calls: string[] = [];
    const backend = fakeWorkspaceBackend({
      getBranch: async (_owner, _repo, branch) => ({ name: branch, commit: { id: "head-now" } }),
      getFileMeta: async (_owner, _repo, _branch, path) => path === "old.md" ? { sha: "old-now", size: 5 } : null,
      putFile: async () => {
        calls.push("create-new");
        return { commit: { sha: "created-commit" }, content: { sha: "new-created" } };
      },
      deleteFile: async (_owner, _repo, opts) => {
        if (opts.path === "old.md") {
          calls.push("delete-old");
          throw new WorkspaceBackendError(409, "stale_sha", "source changed");
        }
        calls.push("rollback-new");
        expect(opts).toMatchObject({ path: "new.md", sha: "new-created", message: "rollback incomplete rename to new.md" });
      },
    });

    const res = await localFilesAppFor(db, backend).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: new\n---\n# New\n" }),
    });

    expect(res.status).toBe(409);
    expect(calls).toEqual(["create-new", "delete-old", "rollback-new"]);
    expect(await res.json()).toMatchObject({
      code: "conflict",
      details: { path: "old.md", current_sha: "old-now", branch_moved: true },
    });
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ?")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("does not rollback-delete a destination when the backend omitted the created blob sha", async () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const calls: string[] = [];
    const backend = fakeWorkspaceBackend({
      getBranch: async (_owner, _repo, branch) => ({ name: branch, commit: { id: "head-now" } }),
      getFileMeta: async (_owner, _repo, _branch, path) => path === "old.md" ? { sha: "old-now", size: 5 } : null,
      putFile: async () => {
        calls.push("create-new");
        return { commit: { sha: "created-commit" }, content: null };
      },
      deleteFile: async (_owner, _repo, opts) => {
        if (opts.path === "old.md") {
          calls.push("delete-old");
          throw new WorkspaceBackendError(409, "stale_sha", "source changed");
        }
        calls.push("rollback-new");
      },
    });

    const res = await localFilesAppFor(db, backend).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: new\n---\n# New\n" }),
    });

    expect(res.status).toBe(500);
    expect(calls).toEqual(["create-new", "delete-old"]);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ?")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("fails loudly when an incomplete rename rollback cannot delete the new destination", async () => {
    const db = freshDb();
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const calls: string[] = [];
    const backend = fakeWorkspaceBackend({
      getBranch: async (_owner, _repo, branch) => ({ name: branch, commit: { id: "head-now" } }),
      getFileMeta: async (_owner, _repo, _branch, path) => path === "old.md" ? { sha: "old-now", size: 5 } : null,
      putFile: async () => {
        calls.push("create-new");
        return { commit: { sha: "created-commit" }, content: { sha: "new-created" } };
      },
      deleteFile: async (_owner, _repo, opts) => {
        if (opts.path === "old.md") {
          calls.push("delete-old");
          throw new WorkspaceBackendError(409, "stale_sha", "source changed");
        }
        calls.push("rollback-new");
        throw new WorkspaceBackendError(500, "error", "temporary backend failure");
      },
    });

    const res = await localFilesAppFor(db, backend).request("/api/v1/repos/owner/w/file?path=new.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previous_path: "old.md", content: "---\nid: new\n---\n# New\n" }),
    });

    expect(res.status).toBe(500);
    expect(calls).toEqual(["create-new", "delete-old", "rollback-new"]);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ?")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("does not map an unrelated 422 (non-sha) to a conflict", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/branches/:name", (c) => c.json({ name: c.req.param("name"), commit: { id: "h" } }));
      forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "s" }));
      forge.put("/api/v1/repos/owner/w/contents/notes.md", (c) => c.text("content is invalid", 422));
    }));

    const res = await writeReq(db, token, { content: "# Notes\n" });
    expect(res.status).not.toBe(409);
  });
});

describe("files tree cache", () => {
  it("includes branchless document metadata only for the main tree", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Main title\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
        const ref = c.req.param("ref");
        if (ref === "main" || ref === "feature") {
          return c.json({
            tree: [
              { type: "blob", path: "notes.md", size: 1 },
              { type: "blob", path: "plain.txt", size: 2 },
            ],
            truncated: false,
          });
        }
        return c.notFound();
      });
    }));

    const main = await appFor(db).request("/api/v1/repos/owner/w/tree?branch=main", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(main.status).toBe(200);
    expect(await main.json()).toEqual({
      files: [
        { path: "notes.md", size: 1, kind: "markdown", doc: { id: "notes", title: "Main title" } },
        { path: "plain.txt", size: 2, kind: "text" },
      ],
    });

    const branch = await appFor(db).request("/api/v1/repos/owner/w/tree?branch=feature", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(branch.status).toBe(200);
    expect(await branch.json()).toEqual({
      files: [
        { path: "notes.md", size: 1, kind: "markdown" },
        { path: "plain.txt", size: 2, kind: "text" },
      ],
    });
  });

  it("does not cache a missing-branch fallback tree under the missing branch", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });
    let branchExists = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
        const ref = c.req.param("ref");
        if (ref === "user/stale") {
          if (!branchExists) return c.text("sha not found", 400);
          return c.json({
            tree: [{ type: "blob", path: "branch.md", size: 2 }],
            truncated: false,
          });
        }
        if (ref === "main") {
          return c.json({
            tree: [
              { type: "blob", path: "main.md", size: 1 },
              { type: "blob", path: "notes/plain.txt", size: 2 },
            ],
            truncated: false,
          });
        }
        return c.notFound();
      });
    }));

    const first = await appFor(db).request("/api/v1/repos/owner/w/tree?branch=user/stale", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      files: [
        { path: "main.md", size: 1, kind: "markdown" },
        { path: "notes/plain.txt", size: 2, kind: "text" },
      ],
    });

    branchExists = true;
    const second = await appFor(db).request("/api/v1/repos/owner/w/tree?branch=user/stale", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ files: [{ path: "branch.md", size: 2, kind: "markdown" }] });
  });
});
