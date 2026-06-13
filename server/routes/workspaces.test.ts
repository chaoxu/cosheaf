import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetBearerAuthCacheForTests,
  _resetFormatCacheForTests,
  _resetPermCacheForTests,
  _seedFormatCacheForTests,
} from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import { members, workspaces } from "./workspaces.js";
import { freshTestDb, testApp, testConfig } from "./test-fixtures.js";
import { fakeForgejo, responseOk } from "./test-fixtures.js";

const config = testConfig("workspaces");

function appFor() {
  const db = freshTestDb("cosheaf-workspaces-");
  const app = testApp(db, config, (a) => {
    a.route("/api/v1/workspaces", workspaces);
    a.route("/api/v1/repos", members);
  });
  return { app, db };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetBearerAuthCacheForTests();
  _resetPermCacheForTests();
  _resetFormatCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/v1/workspaces", () => {
  it("lists every accessible repo across owners, untagged as passthrough, derives role from inline permissions", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    // Discovery is topic-agnostic: one `/repos/search` with no filter returns
    // every repo the PAT can see. Candidates: a coflat repo (admin), a
    // passthrough repo under another owner (write), an UNTAGGED repo (read —
    // must surface as forgejo-passthrough), and one with no access (dropped).
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/search", (c) =>
        c.json({ data: [
          {
            id: 1, name: "alpha", full_name: "owner/alpha", default_branch: "main",
            description: "Alpha workspace", owner: { id: 1, login: "owner" },
            topics: ["cosheaf-format-coflat"],
            permissions: { admin: true, push: true, pull: true },
          },
          {
            id: 2, name: "beta", full_name: "other/beta", default_branch: "main",
            description: "Beta", owner: { id: 2, login: "other" },
            topics: ["cosheaf-format-forgejo-passthrough"],
            permissions: { admin: false, push: true, pull: true },
          },
          {
            id: 3, name: "plain", full_name: "owner/plain", default_branch: "main",
            description: "Plain notes", owner: { id: 1, login: "owner" },
            topics: [],
            permissions: { admin: false, push: false, pull: true },
          },
          {
            id: 4, name: "private", full_name: "owner/private", default_branch: "main",
            owner: { id: 1, login: "owner" },
            topics: ["cosheaf-format-coflat"],
            permissions: {},
          },
        ] }),
      );
    }));

    const res = await app.request("/api/v1/workspaces", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ owner: string; repo: string; full_name: string; name: string; role: string; default_md_format: string }> };
    expect(body.workspaces).toEqual([
      { owner: "other", repo: "beta", full_name: "other/beta", name: "Beta", role: "write", default_md_format: "forgejo-passthrough" },
      { owner: "owner", repo: "alpha", full_name: "owner/alpha", name: "Alpha workspace", role: "admin", default_md_format: "coflat" },
      { owner: "owner", repo: "plain", full_name: "owner/plain", name: "Plain notes", role: "read", default_md_format: "forgejo-passthrough" },
    ]);
  });

  it("requires a bearer token", async () => {
    const { app } = appFor();
    const res = await app.request("/api/v1/workspaces");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/workspaces", () => {
  it("creates a workspace in the caller's namespace and writes the cosheaf-format topic", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    let topicPutBody: unknown = null;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      // existence pre-check: repo does not yet exist (owner defaults to the caller)
      forge.get("/api/v1/repos/chao/new-ws", (c) => c.text("", 404));
      forge.post("/api/v1/user/repos", (c) =>
        c.json({
          id: 99, name: "new-ws", full_name: "chao/new-ws",
          default_branch: "main", description: "New workspace",
          owner: { id: 1, login: "chao" },
        }),
      );
      forge.get("/api/v1/repos/chao/new-ws/topics", (c) => c.json({ topics: [] }));
      forge.put("/api/v1/repos/chao/new-ws/topics", async (c) => {
        topicPutBody = await c.req.json();
        return c.body(null, 204);
      });
      // permissions / branch protection / hooks / .gitattributes / reindex tree
      forge.put("/api/v1/repos/chao/new-ws/collaborators/:username", (c) => c.body(null, 204));
      forge.get("/api/v1/repos/chao/new-ws/hooks", (c) => c.json([]));
      forge.post("/api/v1/repos/chao/new-ws/hooks", (c) => c.json({ id: 1, type: "forgejo", events: ["push"] }));
      forge.get("/api/v1/repos/chao/new-ws/contents/*", (c) => c.text("", 404));
      forge.get("/api/v1/repos/chao/new-ws/git/trees/:ref", (c) => c.json({ tree: [] }));
      // provisioning sends incidental traffic (branch protection, file writes)
      forge.all("*", (c) => c.json({}));
    }));

    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "new-ws", name: "New workspace" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { owner: string; repo: string; full_name: string; name: string; default_md_format: string };
    expect(body.owner).toBe("chao");
    expect(body.repo).toBe("new-ws");
    expect(body.full_name).toBe("chao/new-ws");
    expect(body.name).toBe("New workspace");
    expect(body.default_md_format).toBe("forgejo-passthrough");
    expect(topicPutBody).toEqual({ topics: ["cosheaf-format-forgejo-passthrough"] });
  });

  it("creates under an explicit owner via the org endpoint", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    let orgCreateBody: unknown = null;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/the-org/new-ws", (c) => c.text("", 404));
      forge.post("/api/v1/orgs/the-org/repos", async (c) => {
        orgCreateBody = await c.req.json();
        return c.json({
          id: 99, name: "new-ws", full_name: "the-org/new-ws",
          default_branch: "main", description: "New workspace",
          owner: { id: 7, login: "the-org" },
        });
      });
      forge.get("/api/v1/repos/the-org/new-ws/topics", (c) => c.json({ topics: [] }));
      forge.put("/api/v1/repos/the-org/new-ws/topics", (c) => c.body(null, 204));
      forge.put("/api/v1/repos/the-org/new-ws/collaborators/:username", (c) => c.body(null, 204));
      forge.get("/api/v1/repos/the-org/new-ws/hooks", (c) => c.json([]));
      forge.post("/api/v1/repos/the-org/new-ws/hooks", (c) => c.json({ id: 1, type: "forgejo", events: ["push"] }));
      forge.get("/api/v1/repos/the-org/new-ws/contents/*", (c) => c.text("", 404));
      forge.get("/api/v1/repos/the-org/new-ws/git/trees/:ref", (c) => c.json({ tree: [] }));
      forge.all("*", (c) => c.json({}));
    }));

    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ owner: "the-org", slug: "new-ws", name: "New workspace" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { owner: string; full_name: string };
    expect(body.owner).toBe("the-org");
    expect(body.full_name).toBe("the-org/new-ws");
    expect(orgCreateBody).toMatchObject({ name: "new-ws" });
  });

  it("creates a coflat workspace when requested", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    let topicPutBody: unknown = null;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/chao/coflat-ws", (c) => c.text("", 404));
      forge.post("/api/v1/user/repos", (c) =>
        c.json({
          id: 100, name: "coflat-ws", full_name: "chao/coflat-ws",
          default_branch: "main", description: "Coflat workspace",
          owner: { id: 1, login: "chao" },
        }),
      );
      forge.get("/api/v1/repos/chao/coflat-ws/topics", (c) => c.json({ topics: [] }));
      forge.put("/api/v1/repos/chao/coflat-ws/topics", async (c) => {
        topicPutBody = await c.req.json();
        return c.body(null, 204);
      });
      forge.put("/api/v1/repos/chao/coflat-ws/collaborators/:username", (c) => c.body(null, 204));
      forge.get("/api/v1/repos/chao/coflat-ws/hooks", (c) => c.json([]));
      forge.post("/api/v1/repos/chao/coflat-ws/hooks", (c) => c.json({ id: 1, type: "forgejo", events: ["push"] }));
      forge.get("/api/v1/repos/chao/coflat-ws/contents/*", (c) => c.text("", 404));
      forge.get("/api/v1/repos/chao/coflat-ws/git/trees/:ref", (c) => c.json({ tree: [] }));
      // provisioning sends incidental traffic (branch protection, file writes)
      forge.all("*", (c) => c.json({}));
    }));

    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "coflat-ws", name: "Coflat workspace", default_md_format: "coflat" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { default_md_format: string };
    expect(body.default_md_format).toBe("coflat");
    expect(topicPutBody).toEqual({ topics: ["cosheaf-format-coflat"] });
  });

  it("rejects an invalid slug", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "Bad Slug!", name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid default markdown format", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "new-ws", name: "x", default_md_format: "plain" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the slug already exists in Forgejo", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });
    fetchMock.mockImplementation(async () =>
      responseOk({
        id: 5, name: "taken", full_name: "chao/taken",
        default_branch: "main", description: "",
        owner: { id: 1, login: "chao" },
      }),
    );
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "taken", name: "Taken" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PUT /api/v1/repos/:owner/:repo/members/:username", () => {
  it("lets a workspace admin set a reviewer role and keeps admin direct-push whitelist unchanged", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao", role: "admin", owner: "owner", repo: "w" });
    _seedFormatCacheForTests("owner", "w", "coflat");

    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.use("*", async (c, next) => {
        const raw = await c.req.text();
        calls.push({ url: c.req.url, method: c.req.method, body: raw ? JSON.parse(raw) : null });
        await next();
      });
      forge.get("/api/v1/repos/owner/w/collaborators/chao/permission", (c) => c.json({ permission: "admin" }));
      forge.put("/api/v1/repos/owner/w/collaborators/test-vera", (c) => c.body(null, 204));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", (c) => c.json({ push_whitelist_usernames: ["chao"] }));
    }));

    const res = await app.request("/api/v1/repos/owner/w/members/test-vera", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "write" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, username: "test-vera", role: "write" });
    expect(calls).toContainEqual({
      url: "http://forgejo.test/api/v1/repos/owner/w/collaborators/test-vera",
      method: "PUT",
      body: { permission: "write" },
    });
    expect(calls.some((call) => call.method === "PATCH" && call.url.includes("branch_protections"))).toBe(false);
  });

  it("adds admin members to the direct-push whitelist", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao", role: "admin", owner: "owner", repo: "w" });
    _seedFormatCacheForTests("owner", "w", "coflat");

    let whitelistPatch: unknown = null;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/chao/permission", (c) => c.json({ permission: "admin" }));
      forge.put("/api/v1/repos/owner/w/collaborators/test-vera", (c) => c.body(null, 204));
      forge.get("/api/v1/repos/owner/w/branch_protections/main", (c) => c.json({ push_whitelist_usernames: ["chao"] }));
      forge.patch("/api/v1/repos/owner/w/branch_protections/main", async (c) => {
        whitelistPatch = await c.req.json();
        return c.json({});
      });
    }));

    const res = await app.request("/api/v1/repos/owner/w/members/test-vera", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });

    expect(res.status).toBe(200);
    expect(whitelistPatch).toEqual({
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["chao", "test-vera"],
    });
  });

  it("rejects non-admin callers", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao", role: "write", owner: "owner", repo: "w" });
    _seedFormatCacheForTests("owner", "w", "coflat");

    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/chao/permission", (c) => c.json({ permission: "write" }));
    }));

    const res = await app.request("/api/v1/repos/owner/w/members/test-vera", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "write" }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects invalid roles", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao", role: "admin", owner: "owner", repo: "w" });
    _seedFormatCacheForTests("owner", "w", "coflat");

    fetchMock.mockResolvedValueOnce(responseOk({ permission: "admin" }));

    const res = await app.request("/api/v1/repos/owner/w/members/test-vera", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "maintainer" }),
    });

    expect(res.status).toBe(400);
  });
});
