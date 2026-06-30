// The anti-enumeration security invariant: a web caller who lacks the required
// role on a repo gets the SAME 404 "Repository not found" as a non-member —
// never a distinct 403, which would let them probe which private repos they
// hold some access to by status code. resolveWebRepoForWrite/ForAdmin (via
// resolveWithMinRole) and the webRoute* HOFs all enforce this; these tests pin
// it so a future change can't silently reintroduce the 403 oracle.

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { clientIp, globalRoute, positiveInt, positiveIntFields, userLink, webRoute, webRouteForAdmin, webRouteForWrite } from "./web-context.js";

const config = testConfig("web-context");
const proxiedConfig = testConfig("web-context-proxy", { trustedProxyHops: 1 });
const overconfiguredProxyConfig = testConfig("web-context-proxy-overconfigured", { trustedProxyHops: 2 });
const publicOriginConfig = testConfig("web-context-public-origin", {
  trustedProxyHops: 1,
  publicOrigin: "https://cosheaf.lab",
});

function appFor(db: Database.Database, appConfig = config): Hono<AppEnv> {
  return testApp(db, appConfig, (app) => {
    // Probe routes that echo the resolved role on success; the HOF short-circuits
    // to the resolver's response (404/redirect) on failure.
    app.get("/:owner/:repo/probe-read", webRoute((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.get("/:owner/:repo/probe-write", webRouteForWrite((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.get("/:owner/:repo/probe-admin", webRouteForAdmin((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.get("/:owner/:repo/probe-title", webRoute((_c, ctx) => new Response(ctx.wsTitle)));
    app.post("/:owner/:repo/probe-write", webRouteForWrite((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.post("/probe-global", globalRoute(() => new Response("ok:global")));
    app.get("/probe-ip", (c) => new Response(clientIp(c, c.get("config").trustedProxyHops)));
  });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetMiddlewareCachesForTests();
  // A non-member has no seeded perm-cache entry, so resolveRepoRole falls
  // through to Forgejo; the collaborator-permission endpoint 404s → role "none".
  fetchMock.mockImplementation(
    fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/collaborators/:user/permission", (c) => c.text("not found", 404));
      forge.get("/api/v1/user", (c) => c.json({ login: "stranger" }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function get(app: Hono<AppEnv>, path: string, token: string): Promise<Response> {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

async function expect404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("Repository not found");
}

describe("web role gates return 404 (not 403) on insufficient role", () => {
  it("write gate: read-only member gets 404, never a 403", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "reader", role: "read" });
    const res = await get(appFor(db), "/owner/w/probe-write", token);
    await expect404(res);
  });

  it("admin gate: write member gets 404, never a 403", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    const res = await get(appFor(db), "/owner/w/probe-admin", token);
    await expect404(res);
  });

  it("admin gate: read member gets 404", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "reader", role: "read" });
    const res = await get(appFor(db), "/owner/w/probe-admin", token);
    await expect404(res);
  });

  it("non-member gets the SAME 404 as an insufficient-role member (no enumeration oracle)", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    // No role seeded → resolveRepoRole hits the stubbed 404 permission endpoint → "none".
    const token = seedAuthUser(db, config, { username: "stranger" });
    const writeRes = await get(appFor(db), "/owner/w/probe-write", token);
    const adminRes = await get(appFor(db), "/owner/w/probe-admin", token);
    await expect404(writeRes);
    await expect404(adminRes);
  });
});

describe("web numeric parsers", () => {
  it("accept only digit-shaped positive integer strings", () => {
    expect(positiveInt("7")).toBe(7);
    expect(positiveInt(" 7 ")).toBe(7);
    expect(positiveInt("0")).toBeNull();
    expect(positiveInt("7.0")).toBeNull();
    expect(positiveInt("1e2")).toBeNull();
    expect(positiveInt("true")).toBeNull();
  });

  it("does not coerce malformed form id lists", () => {
    expect(positiveIntFields(["1", " 2 "])).toEqual([1, 2]);
    expect(positiveIntFields(["1e2", "3.0", "4"])).toBeNull();
    expect(positiveIntFields([4])).toBeNull();
  });
});

describe("userLink", () => {
  it("links the author to their profile in hosted mode", () => {
    const body = String(userLink("alice"));
    expect(body).toContain('href="/users/alice"');
    expect(body).toContain("alice");
  });

  it("renders the author name as plain text (no /users/ link) in local mode", () => {
    const body = String(userLink("alice", true));
    expect(body).not.toContain("/users/");
    expect(body).not.toContain("<a");
    expect(body).toContain("alice");
  });
});

describe("web role gates pass through on sufficient role", () => {
  it("read member reaches a read route", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "reader", role: "read" });
    const res = await get(appFor(db), "/owner/w/probe-read", token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:read");
  });

  it("write member reaches a write route", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    const res = await get(appFor(db), "/owner/w/probe-write", token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:write");
  });

  it("admin member reaches an admin route", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "boss", role: "admin" });
    const res = await get(appFor(db), "/owner/w/probe-admin", token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok:admin");
  });
});

describe("web workspace title", () => {
  it("uses the indexed README title without reindexing during repo resolution", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    db.prepare("INSERT INTO doc_map (workspace_slug, cosheaf_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("owner/w", "readme", "README.md", "Indexed Sidecar Title", "2026-06-16T00:00:00Z");
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "writer" }));
        forge.get("/api/v1/repos/owner/w", () => Response.json({ name: "w", full_name: "owner/w", description: "Old Repo Description" }));
      }),
    );

    const res = await get(appFor(db), "/owner/w/probe-title", token);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Indexed Sidecar Title");
    expect(db.prepare("SELECT title FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?").get("owner/w", "README.md"))
      .toEqual({ title: "Indexed Sidecar Title" });
  });

  it("falls back to Forgejo repo metadata when no README title is indexed", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "writer" }));
        forge.get("/api/v1/repos/owner/w", () => Response.json({ name: "w", full_name: "owner/w", description: "Repo Description" }));
      }),
    );

    const res = await get(appFor(db), "/owner/w/probe-title", token);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Repo Description");
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes("/raw/README.md"))).toBe(false);
  });
});

describe("unauthenticated web access redirects to login", () => {
  it("redirects (303) when no credential is present", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const res = await appFor(db).request("/owner/w/probe-read");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("web mutating routes reject cross-origin form posts", () => {
  it("rejects a mismatched Origin before a repo write handler runs", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });

    const res = await appFor(db).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://evil.example",
        host: "cosheaf.test",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("allows same-origin web POSTs and rejects originless mutations", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    const app = appFor(db);

    const sameOrigin = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://cosheaf.test",
        host: "cosheaf.test",
      },
    });
    const originless = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(sameOrigin.status).toBe(200);
    expect(originless.status).toBe(403);
    expect(await originless.text()).toBe("forbidden");
  });

  it("falls back to Referer when Origin is absent", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    const app = appFor(db);

    const sameOrigin = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "cosheaf.test",
        referer: "http://cosheaf.test/owner/w",
      },
    });
    const crossOrigin = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "cosheaf.test",
        referer: "http://evil.example/owner/w",
      },
    });

    expect(sameOrigin.status).toBe(200);
    expect(crossOrigin.status).toBe(403);
  });

  it("rejects malformed Origin and Referer headers", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });
    const app = appFor(db);

    const badOrigin = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "cosheaf.test",
        origin: "not a url",
      },
    });
    const badReferer = await app.request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "cosheaf.test",
        referer: "not a url",
      },
    });

    expect(badOrigin.status).toBe(403);
    expect(badReferer.status).toBe(403);
  });

  it("compares normalized origins", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });

    const res = await appFor(db).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://cosheaf.test",
        host: "cosheaf.test:80",
      },
    });

    expect(res.status).toBe(200);
  });

  it("applies the same Origin check to signed-in global POSTs", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });

    const res = await appFor(db).request("/probe-global", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://evil.example",
        host: "cosheaf.test",
      },
    });

    expect(res.status).toBe(403);
  });

  it("ignores spoofed forwarded origin headers when no proxy is trusted", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "writer", role: "write" });

    const res = await appFor(db).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://evil.example",
        host: "cosheaf.test",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });

    expect(res.status).toBe(403);
  });

  it("allows same-origin posts through a trusted reverse proxy", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, proxiedConfig, { username: "writer", role: "write" });

    const res = await appFor(db, proxiedConfig).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cosheaf.lab",
        host: "127.0.0.1:3030",
        "x-forwarded-host": "cosheaf.lab",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.status).toBe(200);
  });

  it("uses the trusted forwarded origin hop from the right", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, proxiedConfig, { username: "writer", role: "write" });

    const res = await appFor(db, proxiedConfig).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cosheaf.lab",
        host: "127.0.0.1:3030",
        "x-forwarded-host": "evil.example, cosheaf.lab",
        "x-forwarded-proto": "http, https",
      },
    });

    expect(res.status).toBe(200);
  });

  it("does not trust forwarded origin headers when fewer entries than trusted hops are present", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, overconfiguredProxyConfig, { username: "writer", role: "write" });

    const res = await appFor(db, overconfiguredProxyConfig).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cosheaf.lab",
        host: "127.0.0.1:3030",
        "x-forwarded-host": "cosheaf.lab",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.status).toBe(403);
  });

  it("does not trust forwarded client IP headers when fewer entries than trusted hops are present", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    const app = appFor(db, overconfiguredProxyConfig);

    const tooFew = await app.request("/probe-ip", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    const enough = await app.request("/probe-ip", {
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
    });

    expect(await tooFew.text()).toBe("unknown");
    expect(await enough.text()).toBe("198.51.100.7");
  });

  it("uses configured public origin instead of forwarded headers for mutation checks", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, publicOriginConfig, { username: "writer", role: "write" });

    const samePublicOrigin = await appFor(db, publicOriginConfig).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://cosheaf.lab",
        host: "127.0.0.1:3030",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const spoofedForwardedOrigin = await appFor(db, publicOriginConfig).request("/owner/w/probe-write", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
        host: "127.0.0.1:3030",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(samePublicOrigin.status).toBe(200);
    expect(spoofedForwardedOrigin.status).toBe(403);
  });
});
