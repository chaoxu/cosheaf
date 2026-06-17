import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { indexPage } from "../indexer.js";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerBranchRoutes, registerFileRoutes } from "./web-files.js";

const config = testConfig("web-files");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => {
    registerFileRoutes(app);
    registerBranchRoutes(app);
  });
}

function authHeaders(token: string): Record<string, string> {
  return { cookie: `cosheaf_pat=${token}` };
}

function formHeaders(token: string, contentType = "application/x-www-form-urlencoded"): Record<string, string> {
  return { ...authHeaders(token), "content-type": contentType, origin: "http://localhost" };
}

describe("web file editor route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a repo-home overview above the README", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "README.md",
      bodyText: "---\nid: readme\n---\n# Read Me\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "alice" }));
        forge.get("/api/v1/repos/owner/w", () =>
          Response.json({
            name: "w",
            full_name: "owner/w",
            description: "A focused knowledge repo",
            ssh_url: "ssh://git@forge.cosheaf.test:2222/owner/w.git",
            updated_at: "2026-06-16T12:34:00Z",
            open_issues_count: 3,
          }),
        );
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "README.md", name: "README.md", type: "blob" },
              { path: "notes/a.md", name: "a.md", type: "blob" },
              { path: "assets/logo.png", name: "logo.png", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "draft" }]));
        forge.get("/api/v1/repos/owner/w/pulls", () =>
          Response.json([
            { number: 1, title: "One", state: "open", head: { ref: "draft" }, base: { ref: "main" }, user: { login: "alice" } },
            { number: 2, title: "Two", state: "open", head: { ref: "other" }, base: { ref: "main" }, user: { login: "bob" } },
          ]),
        );
        forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Read Me\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="repo-home-header"');
    expect(body).toContain("A focused knowledge repo");
    expect(body).toContain('<span class="repo-stat-num">2</span><span class="repo-stat-label">pages</span>');
    expect(body).toContain('<span class="repo-stat-num">2</span><span class="repo-stat-label">branches</span>');
    expect(body).toContain('<span class="repo-stat-num">3</span><span class="repo-stat-label">open issues</span>');
    expect(body).toContain('<span class="repo-stat-num">2</span><span class="repo-stat-label">open PRs</span>');
    expect(body).toContain('data-testid="repo-clone"');
    expect(body).toContain('aria-label="SSH clone URL"');
    expect(body).toContain('data-testid="repo-readme"');
    expect(body).toContain('<div class="repo-readme-label">README.md</div>');
    expect(body).toContain('value="ssh://git@forge.cosheaf.test:2222/owner/w.git"');
  });

  it("uses source freshness when an existing edit branch lacks the file and falls back to main content", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: "user/alice/wip" }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "user/alice/wip") return c.text("not found", 404);
          expect(c.req.query("ref")).toBe("main");
          return c.json({ sha: "main-sha" });
        });
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return c.text("# Main Notes\n");
        });
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("user/alice/wip");
          return c.json({ tree: [], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/_edit?branch=user%2Falice%2Fwip&path=notes.md", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-branch-exists="1"');
    expect(body).toContain('data-base-sha=""');
    expect(body).toContain('data-source-sha="main-sha"');
    expect(body).toContain('name="expected_sha" value=""');
    expect(body).toContain('name="expected_source_sha" value="main-sha"');
    expect(body).toContain("# Main Notes\\n");
  });

  it("uses the main blob sha as CAS base when a missing edit branch will be created from main", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.text("not found", 404));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
          expect(c.req.query("ref")).toBe("main");
          return c.json({ sha: "main-sha" });
        });
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return c.text("# Main Notes\n");
        });
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("main");
          return c.json({ tree: [], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/_edit?branch=user%2Falice%2Fnew&path=notes.md", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-branch-exists="0"');
    expect(body).toContain('data-base-sha="main-sha"');
    expect(body).toContain('data-source-sha=""');
    expect(body).toContain('name="expected_sha" value="main-sha"');
    expect(body).toContain("# Main Notes\\n");
  });

  it("rejects invalid edit branch names before loading editor data", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
      forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Workspace\n"));
    }));

    const res = await appFor(db).request("/owner/w/_edit?branch=bad..branch&path=notes.md", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid branch name is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/raw/README.md?ref=main");
  });

  it("rejects invalid edit paths instead of falling back to the default new file", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
      forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Workspace\n"));
    }));

    const res = await appFor(db).request("/owner/w/_edit?path=docs/./escape.md", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid file path is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/raw/README.md?ref=main");
  });

  it("rejects a stale plain form save before overwriting the branch file", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "notes.md",
      path: "notes.md",
      expected_sha: "loaded-sha",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("rejects a fallback plain form save when the main source changed", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "main") return c.json({ sha: "main-newer" });
          return c.text("not found", 404);
        });
        forge.post("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "notes.md",
      path: "notes.md",
      expected_sha: "",
      expected_source_sha: "main-loaded",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("rejects non-string plain form freshness tokens instead of disabling CAS", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new FormData();
    form.set("branch", "user/alice/wip");
    form.set("old_path", "notes.md");
    form.set("path", "notes.md");
    form.set("content", "# Edited\n");
    form.set("expected_sha", new Blob(["loaded-sha"]), "sha.txt");
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: { ...authHeaders(token), origin: "http://localhost" },
      body: form,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid edit freshness token");
    expect(putCalled).toBe(false);
  });

  it("rejects malformed original paths instead of treating the save as a non-rename", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "../old.md",
      path: "notes.md",
      expected_sha: "loaded-sha",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid original path");
    expect(putCalled).toBe(false);
  });

  it("rejects invalid plain form branch names before mutating Forgejo", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
      forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Workspace\n"));
    }));

    const form = new URLSearchParams({
      branch: "bad..branch",
      old_path: "notes.md",
      path: "notes.md",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid branch name is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/raw/README.md?ref=main");
  });

  it("rejects a plain form rename from a non-editable source path before deleting it", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let mutationCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/repos/owner/w/branches", () => {
          mutationCalled = true;
          return Response.json({ name: "user/alice/wip" });
        });
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          mutationCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/assets/logo.png", () => {
          mutationCalled = true;
          return new Response(null);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "assets/logo.png",
      path: "notes.md",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid original path");
    expect(mutationCalled).toBe(false);
  });

  it("returns a bad request when a plain form rename destination already exists", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => Response.json({ sha: "existing-new" }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("A file already exists at the new path");
    expect(putCalled).toBe(false);
  });

  it("rejects a plain form rename when the source path is already missing", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => new Response("not found", { status: 404 }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("allows a plain form rename from a main fallback when the source sha is fresh", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deletedOld = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
          if (c.req.query("ref") === "main") return Response.json({ sha: "main-loaded" });
          return new Response("not found", { status: 404 });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          const body = (await c.req.json()) as { message: string; sha?: string };
          expect(body).toMatchObject({ message: "rename old.md to new.md" });
          expect(body.sha).toBeUndefined();
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          deletedOld = true;
          return new Response(null, { status: 204 });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "",
      expected_source_sha: "main-loaded",
      content: "---\nid: new\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/src/branch/user/alice/wip/new.md");
    expect(deletedOld).toBe(false);
  });

  it("does not publish a branch-local plain form rename into the main sidecar", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("---\nid: old\n---\n# Old\n");
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", () =>
          Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } }),
        );
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => new Response(null, { status: 204 }));
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "---\nid: new\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("preserves branch-only markdown content without moving the main sidecar row", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: stable\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
          if (c.req.query("ref") === "main") return new Response("not found", { status: 404 });
          return Response.json({ sha: "old-sha" });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          const body = (await c.req.json()) as { content: string };
          expect(Buffer.from(body.content, "base64").toString("utf8")).toContain("id: stable");
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => new Response(null, { status: 204 }));
        forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("not found", { status: 404 });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "---\nid: stable\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id, title FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "stable", forgejo_id: "old.md", title: "Old" }]);
  });

  it("rolls back a plain form rename destination when source deletion loses a sha race", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const calls: string[] = [];
    let newCreated = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () =>
          newCreated ? Response.json({ sha: "concurrent-newer" }) : new Response("not found", { status: 404 }),
        );
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("create-new");
          newCreated = true;
          return Response.json({ commit: { sha: "created-commit" }, content: { sha: "new-created" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          calls.push("delete-old");
          return new Response("sha does not match [given: old, expected: newer]", { status: 422 });
        });
        forge.delete("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          calls.push("rollback-new");
          const body = (await c.req.json()) as { sha: string; message: string };
          expect(body).toMatchObject({ sha: "new-created", message: "rollback incomplete rename to new.md" });
          return c.body(null, 200);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(calls).toEqual(["create-new", "delete-old", "rollback-new"]);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
  });

  it("does not rollback-delete a plain form rename destination when Forgejo omitted the created blob sha", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const calls: string[] = [];
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("create-new");
          return Response.json({ commit: { sha: "created-commit" }, content: null });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          calls.push("delete-old");
          return new Response("sha does not match [given: old, expected: newer]", { status: 422 });
        });
        forge.delete("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("rollback-new");
          return new Response(null);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(500);
    expect(calls).toEqual(["create-new", "delete-old"]);
  });

  it("renders and enforces a freshness token for file delete forms", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
        forge.post("/api/v1/repos/owner/w/markdown", () => Response.json({ html: "<h1>Notes</h1>" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => {
          deleted = true;
          return Response.json({});
        });
      }),
    );

    const page = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      headers: authHeaders(token),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="expected_sha" value="current-sha"');

    const staleForm = new URLSearchParams({ action: "delete", expected_sha: "old-sha" });
    const stale = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: staleForm.toString(),
    });

    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("This file changed on the branch while you were viewing it");
    expect(deleted).toBe(false);
  });

  it("publishes a change event after browser file delete", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const events: unknown[] = [];
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => new Response(null, { status: 204 }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("not found", { status: 404 });
        });
      }),
    );
    const app = testApp(db, config, (hono) => {
      hono.use("*", (c, next) => {
        c.get("sse").subscribe("owner/w", (event) => events.push(event));
        return next();
      });
      registerFileRoutes(hono);
    });

    const form = new URLSearchParams({ action: "delete", expected_sha: "current-sha" });
    const res = await app.request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(events).toContainEqual({ type: "change", path: "notes.md" });
  });

  it("keeps main sidecar rows after browser file delete removes branch markdown", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Notes\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => new Response(null, { status: 204 }));
      }),
    );

    const form = new URLSearchParams({ action: "delete", expected_sha: "current-sha" });
    const res = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) AS n FROM doc_map WHERE workspace_slug = ?").get("owner/w")).toEqual({ n: 1 });
  });

  it("does not silently succeed when browser branch delete fails upstream", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.delete("/api/v1/repos/owner/w/branches/user%2Falice%2Fwip", () => new Response("forgejo down", { status: 500 }));
    }));

    const form = new URLSearchParams({ name: "user/alice/wip" });
    const res = await appFor(db).request("/owner/w/branches/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("treats an already-deleted browser branch as gone", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.delete("/api/v1/repos/owner/w/branches/user%2Falice%2Fwip", () => new Response("not found", { status: 404 }));
    }));

    const form = new URLSearchParams({ name: "user/alice/wip" });
    const res = await appFor(db).request("/owner/w/branches/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/branches");
  });
});
