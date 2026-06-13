// The anti-enumeration security invariant: a web caller who lacks the required
// role on a repo gets the SAME 404 "Repository not found" as a non-member —
// never a distinct 403, which would let them probe which private repos they
// hold some access to by status code. resolveWebRepoForWrite/ForAdmin (via
// resolveWithMinRole) and the webRoute* HOFs all enforce this; these tests pin
// it so a future change can't silently reintroduce the 403 oracle.

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBearerAuthCacheForTests, _resetFormatCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { webRoute, webRouteForAdmin, webRouteForWrite } from "./web-context.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-context");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => {
    // Probe routes that echo the resolved role on success; the HOF short-circuits
    // to the resolver's response (404/redirect) on failure.
    app.get("/:owner/:repo/probe-read", webRoute((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.get("/:owner/:repo/probe-write", webRouteForWrite((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
    app.get("/:owner/:repo/probe-admin", webRouteForAdmin((_c, ctx) => new Response(`ok:${ctx.ws.role}`)));
  });
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetBearerAuthCacheForTests();
  _resetPermCacheForTests();
  _resetFormatCacheForTests();
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

describe("unauthenticated web access redirects to login", () => {
  it("redirects (303) when no credential is present", async () => {
    const db = freshTestDb("cosheaf-webctx-");
    seedTestWorkspace(db);
    const res = await appFor(db).request("/owner/w/probe-read");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });
});
