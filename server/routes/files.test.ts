import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPage } from "../indexer.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import { _clearTreeCacheForTests } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { files, safeRel } from "./files.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("files");

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-files-");
  seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/api/v1/repos", files));
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
  _resetBearerAuthCacheForTests();
  _clearTreeCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(safeRel("docs/./loop")).toBe("docs/./loop"); // "." segment is allowed; ".." is the only blocked literal
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
        { id: "thm:target", path: "target.md", kind: "block", label: "Theorem 1", fragment: "thm:target", line: 3 },
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

    const res = await appFor(db).request("/api/v1/repos/owner/w/suggest?prefix=alpha&limit=abc", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ id: string }> };
    expect(body.suggestions).toHaveLength(10);
    expect(body.suggestions[0].id).toBe("alpha-0");
  });
});

describe("files mutation gates", () => {
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

  it("renames a markdown file on the target branch and updates sidecar rows", async () => {
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
      forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => c.json({ sha: "old-sha" }));
      forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
        const body = (await c.req.json()) as { message: string };
        expect(body.message).toBe("rename old.md to new.md");
        return c.json({ commit: { sha: "new-commit" } });
      });
      forge.delete("/api/v1/repos/owner/w/contents/old.md", (c) => c.body(null, 200));
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
    expect(rows).toEqual([{ cosheaf_id: "new", forgejo_id: "new.md" }]);
  });
});

describe("files tree cache", () => {
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
