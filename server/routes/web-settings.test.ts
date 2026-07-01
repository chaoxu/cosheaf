import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { indexPage } from "../indexer.js";
import {
  _resetMiddlewareCachesForTests,
  _seedTitleCacheForTests,
} from "../middleware.js";
import { authHeaders, seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { mergeRepoTopics, registerSettingsRoutes } from "./web-settings.js";

const config = testConfig("web-settings");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => registerSettingsRoutes(app));
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("mergeRepoTopics", () => {
  it("preserves the cosheaf-format-* topic across a topics edit", () => {
    // The format topic drives the workspace markdown format and must survive a
    // topics edit even though the user never sees it in the input.
    expect(mergeRepoTopics(["cosheaf-format-coflat", "math"], "notes physics")).toEqual([
      "cosheaf-format-coflat",
      "notes",
      "physics",
    ]);
  });

  it("does not let the user inject or change the format topic via the input", () => {
    expect(mergeRepoTopics(["cosheaf-format-coflat"], "cosheaf-format-legacy notes")).toEqual([
      "cosheaf-format-coflat",
      "notes",
    ]);
  });

  it("normalizes case and dedupes", () => {
    expect(mergeRepoTopics([], "Notes NOTES notes")).toEqual(["notes"]);
  });

  it("drops invalid topic shapes", () => {
    expect(mergeRepoTopics([], "valid-1 _bad has space @nope")).toEqual(["valid-1", "has", "space"]);
  });

  it("clears free topics when the input is empty but keeps the format topic", () => {
    expect(mergeRepoTopics(["cosheaf-format-coflat", "old"], "")).toEqual(["cosheaf-format-coflat"]);
  });

  it("returns an empty list for an untagged repo cleared to nothing", () => {
    expect(mergeRepoTopics([], "")).toEqual([]);
  });
});

describe("web repository settings", () => {
  it("allows disabling the approval gate in the rendered review policy form", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({
        name: "w",
        full_name: "owner/w",
        description: "Workspace",
        private: true,
        owner: { login: "owner" },
      }));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", () => Response.json({ required_approvals: 2 }));
      forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/milestones", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/collaborators", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/branches", () => Response.json([]));
    }));

    const res = await appFor(db).request("/owner/w/settings", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="required_approvals" type="number" min="0" value="2"');
  });

  it("renders collaborator username autocomplete on the access form", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({
        name: "w",
        full_name: "owner/w",
        description: "Workspace",
        private: true,
        owner: { login: "owner" },
      }));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", () => Response.json({ required_approvals: 2 }));
      forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/milestones", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/collaborators", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/branches", () => Response.json([]));
    }));

    const res = await appFor(db).request("/owner/w/settings", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-user-autocomplete="/owner/w/user-suggestions"');
    expect(body).toContain('list="settings-access-usernames"');
    expect(body).toContain('id="settings-access-usernames"');
    expect(body).toContain('/cosheaf-user-autocomplete.js');
  });

  it("accepts zero required approvals", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let patched: unknown;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "admin" }));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", () => Response.json({ required_approvals: 2 }));
      forge.patch("/api/v1/repos/owner/w/branch_protections/main", async (c) => {
        patched = await c.req.json();
        return Response.json({ required_approvals: 0 });
      });
    }));

    const res = await appFor(db).request("/owner/w/settings", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ required_approvals: "0" }).toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/settings");
    expect(patched).toEqual({ required_approvals: 0 });
  });

  it("rejects invalid required approval counts before mutating branch protection", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let mutated = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "admin" }));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", () => Response.json({ required_approvals: 2 }));
      forge.patch("/api/v1/repos/owner/w/branch_protections/main", () => {
        mutated = true;
        return Response.json({ required_approvals: 0 });
      });
      forge.post("/api/v1/repos/owner/w/branch_protections", () => {
        mutated = true;
        return Response.json({ required_approvals: 0 });
      });
    }));

    for (const form of [
      new URLSearchParams({ required_approvals: "1e2" }),
      new URLSearchParams(),
    ]) {
      const res = await appFor(db).request("/owner/w/settings", {
        method: "POST",
        headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
        body: form.toString(),
      });

      expect(res.status, `expected ${form.toString() || "missing field"} to be rejected`).toBe(400);
      expect(await res.text()).toContain("Required approvals must be a non-negative integer");
    }
    expect(mutated).toBe(false);
  });

  it("clears sidecar rows immediately after repository deletion", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Notes\n",
      formatId: COFLAT_FORMAT_ID,
    });
    db.prepare(`
      INSERT INTO issue_claims (
        workspace_slug, issue_number, runner_name, purpose, holder_username,
        created_at, heartbeat_at, expires_at
      ) VALUES ('owner/w', 7, 'runner', 'triage', 'alice', 1, 1, 999)
    `).run();
    let deleted = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "admin" }));
      forge.delete("/api/v1/repos/owner/w", () => {
        deleted = true;
        return new Response(null, { status: 204 });
      });
    }));

    const form = new URLSearchParams({ confirm: "owner/w" });
    const res = await appFor(db).request("/owner/w/settings/delete", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(deleted).toBe(true);
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM issue_claims WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("still clears sidecar rows when deleteRepo reports 404 after fresh admin verification", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Notes\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "admin" }));
      forge.delete("/api/v1/repos/owner/w", () => new Response("not found", { status: 404 }));
    }));

    const form = new URLSearchParams({ confirm: "owner/w" });
    const res = await appFor(db).request("/owner/w/settings/delete", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("clears stale sidecar rows when the repo is already gone before fresh admin verification", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Notes\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => new Response("not found", { status: 404 }));
      forge.get("/api/v1/repos/owner/w", () => new Response("not found", { status: 404 }));
      forge.delete("/api/v1/repos/owner/w", () => {
        throw new Error("deleteRepo should not be called when the repo is already gone");
      });
    }));

    const form = new URLSearchParams({ confirm: "owner/w" });
    const res = await appFor(db).request("/owner/w/settings/delete", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM notes_fts WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("fresh-checks web access updates before mutating collaborators", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let collaboratorMutated = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "write" }));
      forge.put("/api/v1/repos/owner/w/collaborators/bob", () => {
        collaboratorMutated = true;
        return new Response(null, { status: 204 });
      });
    }));

    const form = new URLSearchParams({ username: "bob", role: "write" });
    const res = await appFor(db).request("/owner/w/settings/access", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Repository not found");
    expect(collaboratorMutated).toBe(false);
  });

  it("fresh-checks label creation before mutating repository labels", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let labelMutated = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "write" }));
      forge.post("/api/v1/repos/owner/w/labels", () => {
        labelMutated = true;
        return Response.json({ id: 1, name: "triage", color: "71717a" });
      });
    }));

    const form = new URLSearchParams({ name: "triage", color: "71717a" });
    const res = await appFor(db).request("/owner/w/settings/labels", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Repository not found");
    expect(labelMutated).toBe(false);
  });

  it("rejects invalid web access usernames before mutating collaborators", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let collaboratorMutated = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.put("/api/v1/repos/owner/w/collaborators/bad%20name", () => {
        collaboratorMutated = true;
        return new Response(null, { status: 204 });
      });
      forge.delete("/api/v1/repos/owner/w/collaborators/bad%20name", () => {
        collaboratorMutated = true;
        return new Response(null, { status: 204 });
      });
    }));

    const addForm = new URLSearchParams({ username: "bad name", role: "write" });
    const add = await appFor(db).request("/owner/w/settings/access", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: addForm.toString(),
    });

    const removeForm = new URLSearchParams({ username: "bad name" });
    const remove = await appFor(db).request("/owner/w/settings/access/remove", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: removeForm.toString(),
    });

    expect(add.status).toBe(400);
    expect(await add.text()).toContain("Invalid access update");
    expect(remove.status).toBe(400);
    expect(await remove.text()).toContain("Invalid username");
    expect(collaboratorMutated).toBe(false);
  });

  it("refreshes the cached workspace title after repository metadata changes", async () => {
    const db = freshTestDb("cosheaf-web-settings-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    _seedTitleCacheForTests("owner", "w", "Old title");
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", () => Response.json({ permission: "admin" }));
      forge.patch("/api/v1/repos/owner/w", () => Response.json({ ok: true }));
      forge.get("/api/v1/repos/owner/w", () => Response.json({
        name: "w",
        full_name: "owner/w",
        description: "New title",
        private: true,
        owner: { login: "owner" },
      }));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", () => Response.json({ required_approvals: 1 }));
      forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/milestones", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/collaborators", () => Response.json([]));
      forge.get("/api/v1/repos/owner/w/branches", () => Response.json([]));
    }));

    const form = new URLSearchParams({ description: "New title", visibility: "private" });
    const update = await appFor(db).request("/owner/w/settings/meta", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: form.toString(),
    });
    expect(update.status).toBe(303);

    const settings = await appFor(db).request("/owner/w/settings", { headers: authHeaders(token) });
    const html = await settings.text();
    expect(settings.status).toBe(200);
    expect(html).toContain("New title");
    expect(html).not.toContain("Old title");
  });
});
