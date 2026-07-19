import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { formHeaders, seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerIssueRoutes } from "./web-issues.js";

const config = testConfig("web-issues");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => registerIssueRoutes(app));
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
});

afterEach(() => vi.unstubAllGlobals());

describe("web issue routes", () => {
  function forgejoIssue(labels: Array<{ id: number; name: string; color: string }> = []): Record<string, unknown> {
    return {
      number: 7,
      title: "Bug",
      body: "",
      state: "open",
      labels,
      user: { login: "bob" },
      pull_request: null,
    };
  }

  it("adds user autocomplete to username filters", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    let listedCollaborators = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/milestones", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/collaborators", () => {
          listedCollaborators = true;
          return Response.json([{ id: 1, login: "bob" }]);
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/issues", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="created_by"');
    expect(body).toContain('data-user-autocomplete="/owner/w/user-suggestions"');
    expect(body).toContain('/cosheaf-user-autocomplete.js');
    expect(listedCollaborators).toBe(false);
  });

  it("preserves multiple labels from the inline label form", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let labelBody: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
        forge.get("/api/v1/repos/owner/w/labels", () =>
          Response.json([
            { id: 1, name: "bug", color: "ee0000" },
            { id: 2, name: "docs", color: "0055ee" },
          ]),
        );
        forge.put("/api/v1/repos/owner/w/issues/7/labels", async (c) => {
          labelBody = await c.req.json();
          return Response.json([]);
        });
      }),
    );

    const form = new URLSearchParams();
    form.append("labels_present", "1");
    form.append("labels", "1");
    form.append("labels", "2");
    const res = await appFor(db).request("/owner/w/issues/7/labels", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(labelBody).toEqual({ labels: [1, 2] });
  });

  it("rejects empty comments before creating an issue comment", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let commented = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
        forge.post("/api/v1/repos/owner/w/issues/7/comments", () => {
          commented = true;
          return Response.json({ id: 1, body: "created" });
        });
      }),
    );

    const form = new URLSearchParams({ body: "  " });
    const res = await appFor(db).request("/owner/w/issues/7/comments", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Comment body is required");
    expect(commented).toBe(false);
  });

  it("lets read users submit issue comments through Forgejo", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    let commentBody: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
        forge.post("/api/v1/repos/owner/w/issues/7/comments", async (c) => {
          commentBody = await c.req.json();
          return Response.json({ id: 1, body: "created" });
        });
      }),
    );

    const form = new URLSearchParams({ body: "question" });
    const res = await appFor(db).request("/owner/w/issues/7/comments", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(commentBody).toEqual({ body: "question" });
  });

  it("shows the comment composer to a read-role member (read members may comment)", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
      }),
    );

    const res = await appFor(db).request("/owner/w/issues/7", { headers: { cookie: `cosheaf_pat=${token}` } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("comment-form");
  });

  it("hides the comment composer from a logged-out visitor on a public repo", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    // No cookie → resolveAnonymousWebRepo; the public repo mock lets the tokenless
    // getRepo succeed so the issue renders as an anonymous read-only page.
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w", () => Response.json({ name: "w", full_name: "owner/w", description: "Public", private: false }));
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
      }),
    );

    const res = await appFor(db).request("/owner/w/issues/7");

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("comment-form");
  });

  it("does not edit comments outside the requested issue", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let edited = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/8", body: "other", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.patch("/api/v1/repos/owner/w/issues/comments/123", () => {
          edited = true;
          return Response.json({ id: 123, body: "updated" });
        });
      }),
    );

    const form = new URLSearchParams({ body: "updated" });
    const res = await appFor(db).request("/owner/w/issues/7/comments/123/edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(404);
    expect(edited).toBe(false);
  });

  it("does not delete comments outside the requested issue", async () => {
    const db = freshTestDb("cosheaf-web-issues-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/issues/7", () => Response.json(forgejoIssue()));
        forge.get("/api/v1/repos/owner/w/issues/comments/123", () => Response.json({ id: 123, issue_url: "http://forgejo.test/owner/w/issues/8", body: "other", user: { login: "bob" }, created_at: "2026-05-20T00:00:00Z", updated_at: "2026-05-20T00:00:00Z" }));
        forge.delete("/api/v1/repos/owner/w/issues/comments/123", () => {
          deleted = true;
          return new Response(null, { status: 204 });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/issues/7/comments/123/delete", {
      method: "POST",
      headers: formHeaders(token),
    });

    expect(res.status).toBe(404);
    expect(deleted).toBe(false);
  });
});
