import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import { forgejoPassthrough } from "./forgejo-passthrough.js";
import { freshTestDb, seedTestWorkspace } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-passthrough-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  return freshTestDb("cosheaf-passthrough-");
}

function seedUser(db: Database.Database, id: number, username: string, role: Role): string {
  // Skip the requireMembership Forgejo call by pre-populating its cache so the
  // fetchMock can be asserted purely against the request under test.
  // seedWorkspace uses repo='repo', forgejoOwner='owner'.
  return seedAuthUser(db, config, { id, username, role, owner: "owner", repo: "w" });
}

function seedWorkspace(db: Database.Database): void {
  seedTestWorkspace(db);
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    // Real Forgejo client; we mock global fetch instead so we exercise the
    // passthrough wiring end-to-end.
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", forgejoPassthrough);
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
  _resetBearerAuthCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Forgejo passthrough", () => {
  it("GET /forgejo/pulls proxies to /repos/{owner}/{repo}/pulls and returns body verbatim", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([{ number: 7 }], { link: "<next>; rel=\"next\"" }));

    const res = await appFor(db).request("/api/v1/w/w/forgejo/pulls?state=open", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ number: 7 }]);
    expect(res.headers.get("link")).toBe('<next>; rel="next"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/repos/owner/w/pulls?state=open");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    // Forwards the caller's own PAT — no admin token, no impersonation header.
    expect(headers.authorization).toBe("token fake-pat-alice");
    expect(headers.sudo).toBeUndefined();
  });

  it("POST /forgejo/issues forwards body verbatim and returns Forgejo's response", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 42, title: "hi" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await appFor(db).request("/api/v1/w/w/forgejo/issues", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "hi", body: "world" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ number: 42, title: "hi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/repos/owner/w/issues");
    expect(init.method).toBe("POST");
    const body = init.body as ArrayBuffer;
    expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ title: "hi", body: "world" }));
  });

  it("PUT /forgejo/issues/:number/labels forwards issue metadata updates", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([{ id: 9, name: "ready" }]));

    const res = await appFor(db).request("/api/v1/w/w/forgejo/issues/42/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [9] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 9, name: "ready" }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/42/labels");
    expect(init.method).toBe("PUT");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(JSON.stringify({ labels: [9] }));
  });

  it("allows repo-scoped notifications through passthrough", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    fetchMock.mockResolvedValueOnce(ok([]));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const app = appFor(db);
    const list = await app.request("/api/v1/w/w/forgejo/notifications?status=unread", {
      headers: { authorization: `Bearer ${token}` },
    });
    const markAll = await app.request("/api/v1/w/w/forgejo/notifications", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(list.status).toBe(200);
    expect(markAll.status).toBe(204);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/notifications?status=unread",
    );
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
  });

  it("rejects admin paths with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const res = await appFor(db).request("/api/v1/w/w/forgejo/admin/users", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "passthrough path not allowed", code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects traversal segments with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    // Hono normalizes ../ in the URL — exercise the explicit `..` segment.
    const res = await appFor(db).request("/api/v1/w/w/forgejo/pulls/..", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects encoded-separator traversal that would escape repo scope (#52)", async () => {
    // `..%2fadmin` survives WHATWG URL normalization as literal text but
    // Forgejo's path parser may treat %2f as a slash. We reject it before
    // forwarding.
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const res = await appFor(db).request(
      "/api/v1/w/w/forgejo/pulls/..%2fadmin",
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown prefixes with 403", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");
    const res = await appFor(db).request("/api/v1/w/w/forgejo/unknown-thing", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks write methods on GET-only prefixes (branches/contents)", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "write");

    for (const target of [
      { method: "POST", url: "/api/v1/w/w/forgejo/branches" },
      { method: "DELETE", url: "/api/v1/w/w/forgejo/branches/feature-x" },
      { method: "PUT", url: "/api/v1/w/w/forgejo/contents/file.md" },
      { method: "POST", url: "/api/v1/w/w/forgejo/contents/file.md" },
    ]) {
      const res = await appFor(db).request(target.url, {
        method: target.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      expect(res.status, `${target.method} ${target.url}`).toBe(405);
      expect(fetchMock, `${target.method} ${target.url}`).not.toHaveBeenCalled();
    }
  });

  it("blocks pulls/:n/merge passthrough (must go through requireAdminFresh route)", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const token = seedUser(db, 1, "alice", "admin");
    const res = await appFor(db).request("/api/v1/w/w/forgejo/pulls/7/merge", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "passthrough path not allowed", code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-owner member can hit /forgejo/issues with their own PAT", async () => {
    const db = freshDb();
    seedWorkspace(db);
    const memberToken = seedUser(db, 1, "bob", "write");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ number: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await appFor(db).request("/api/v1/w/w/forgejo/issues", {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "from-member" }),
    });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // The member's own PAT is forwarded without an impersonation header.
    expect(headers.authorization).toBe("token fake-pat-bob");
    expect(headers.sudo).toBeUndefined();
  });
});
