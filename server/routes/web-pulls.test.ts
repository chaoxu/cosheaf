import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerPullRoutes } from "./web-pulls.js";

const config = testConfig("web-pulls");

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = testApp(db, config, (hono) => registerPullRoutes(hono));
  app.onError(handleAppError);
  return app;
}

function formHeaders(token: string): Record<string, string> {
  return {
    cookie: `cosheaf_pat=${token}`,
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
});

afterEach(() => vi.unstubAllGlobals());

describe("web pull request routes", () => {
  function forgejoPull(): Record<string, unknown> {
    return {
      number: 7,
      title: "Review me",
      body: "",
      state: "open",
      merged: false,
      mergeable: true,
      created_at: "2026-05-16T00:00:00Z",
      user: { login: "bob" },
      head: { ref: "user/bob/wip", sha: "h" },
      base: { ref: "main", sha: "b" },
      labels: [],
    };
  }

  function reviewComment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 123,
      pull_request_review_id: 9,
      path: "notes.md",
      body: "note",
      position: 1,
      original_position: 1,
      commit_id: "c",
      original_commit_id: "c",
      diff_hunk: "",
      user: { login: "alice" },
      created_at: "2026-05-20T00:00:00Z",
      updated_at: "2026-05-20T00:00:00Z",
      ...overrides,
    };
  }

  it("adds user autocomplete to username filters", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/milestones", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/collaborators", () => Response.json([{ id: 1, login: "bob" }]));
      }),
    );

    const res = await appFor(db).request("/owner/w/pulls", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="author"');
    expect(body).toContain('data-user-autocomplete="/owner/w/user-suggestions"');
    expect(body).toContain('/cosheaf-user-autocomplete.js');
  });

  it("lets read users submit PR review comments through Forgejo", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    let reviewBody: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.post("/api/v1/repos/owner/w/pulls/7/reviews", async (c) => {
          reviewBody = await c.req.json();
          return Response.json({ id: 1 });
        });
      }),
    );

    const form = new URLSearchParams({ event: "COMMENT", body: "question" });
    const res = await appFor(db).request("/owner/w/pulls/7/reviews", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(reviewBody).toEqual({ event: "COMMENT", body: "question" });
  });

  it("rejects malformed PR edit milestones before mutating the pull", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let edited = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.patch("/api/v1/repos/owner/w/pulls/7", () => {
          edited = true;
          return Response.json(forgejoPull());
        });
      }),
    );

    const form = new URLSearchParams({ title: "Review me", body: "", milestone: "1e2" });
    const res = await appFor(db).request("/owner/w/pulls/7/edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Milestone must be a positive integer id");
    expect(edited).toBe(false);
  });

  it("rejects malformed PR label ids before mutating labels", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let labelsMutated = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.put("/api/v1/repos/owner/w/issues/7/labels", () => {
          labelsMutated = true;
          return Response.json([]);
        });
      }),
    );

    const form = new URLSearchParams({ labels_present: "1", labels: "1e2" });
    const res = await appFor(db).request("/owner/w/pulls/7/labels", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Labels must be positive integer ids");
    expect(labelsMutated).toBe(false);
  });

  it("preserves multiple labels from the inline label form", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let labelBody: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
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
    const res = await appFor(db).request("/owner/w/pulls/7/labels", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(labelBody).toEqual({ labels: [1, 2] });
  });

  it("rejects invalid review events instead of silently redirecting", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let createdReview = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () =>
          Response.json({
            number: 7,
            title: "Review me",
            body: "",
            state: "open",
            merged: false,
            mergeable: true,
            created_at: "2026-05-16T00:00:00Z",
            user: { login: "bob" },
            head: { ref: "user/bob/wip", sha: "h" },
            base: { ref: "main", sha: "b" },
          }),
        );
        forge.post("/api/v1/repos/owner/w/pulls/7/reviews", () => {
          createdReview = true;
          return Response.json({ id: 1 });
        });
      }),
    );

    const form = new URLSearchParams({ event: "BOGUS", body: "looks wrong" });
    const res = await appFor(db).request("/owner/w/pulls/7/reviews", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Review event is required");
    expect(createdReview).toBe(false);
  });

  it("surfaces PR conversation review-state failures instead of rendering an empty timeline", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.get("/api/v1/repos/owner/w/pulls/7/reviews", () => new Response("down", { status: 503 }));
        forge.get("/api/v1/repos/owner/w/pulls/7/comments", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/issues/7/timeline", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/pulls/7/commits", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/reviewers", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
      }),
    );

    const res = await appFor(db).request("/owner/w/pulls/7", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain("Review me");
  });

  it("surfaces PR files review-comment failures instead of rendering no line comments", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.get("/api/v1/repos/owner/w/pulls/7/files", () =>
          Response.json([
            {
              filename: "notes.md",
              status: "modified",
              additions: 1,
              deletions: 0,
              previous_filename: "",
            },
          ]),
        );
        forge.get("/api/v1/repos/owner/w/pulls/7.diff", () => new Response("diff --git a/notes.md b/notes.md\n"));
        forge.get("/api/v1/repos/owner/w/pulls/7/comments", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/owner/w/pulls/7/files", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain("No changed files");
  });

  it("surfaces PR edit metadata failures instead of rendering a milestone-clearing form", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () =>
          Response.json({
            ...forgejoPull(),
            milestone: { id: 3, title: "v1" },
          }),
        );
        forge.get("/api/v1/repos/owner/w/labels", () => Response.json([]));
        forge.get("/api/v1/repos/owner/w/milestones", () => new Response("down", { status: 503 }));
      }),
    );

    const res = await appFor(db).request("/owner/w/pulls/7/edit", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("backing forge failed");
    expect(body).not.toContain('name="milestone"');
  });

  it("does not edit comments outside the requested pull request", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let edited = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.get("/api/v1/repos/owner/w/pulls/7/comments", () => Response.json([reviewComment({ id: 456 })]));
        forge.patch("/api/v1/repos/owner/w/issues/comments/123", () => {
          edited = true;
          return Response.json({ id: 123, body: "updated" });
        });
      }),
    );

    const form = new URLSearchParams({ body: "updated" });
    const res = await appFor(db).request("/owner/w/pulls/7/comments/123/edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(404);
    expect(edited).toBe(false);
  });

  it("does not delete comments when the review id does not match", async () => {
    const db = freshTestDb("cosheaf-web-pulls-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/pulls/7", () => Response.json(forgejoPull()));
        forge.get("/api/v1/repos/owner/w/pulls/7/comments", () => Response.json([reviewComment({ pull_request_review_id: 9 })]));
        forge.delete("/api/v1/repos/owner/w/pulls/7/reviews/11/comments/123", () => {
          deleted = true;
          return new Response(null, { status: 204 });
        });
      }),
    );

    const form = new URLSearchParams({ review_id: "11" });
    const res = await appFor(db).request("/owner/w/pulls/7/comments/123/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Review id does not match comment");
    expect(deleted).toBe(false);
  });
});
