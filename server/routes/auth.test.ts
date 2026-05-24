// Auth route tests. Stubs global fetch so we exercise the PAT-exchange
// flow without a live Forgejo. Login does not touch the database: it returns
// { username, pat } for API/SPAs and also sets an HttpOnly cookie so
// server-rendered web pages can authenticate normal GET requests.

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { AppEnv } from "../types.js";
import { _resetBearerAuthCacheForTests, _seedBearerAuthCacheForTests } from "../middleware.js";
import { auth } from "./auth.js";
import { freshTestDb } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-auth-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoAdminToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  return freshTestDb("cosheaf-auth-");
}

function appFor(db: Database.Database) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    await next();
  });
  app.route("/api/v1", auth);
  return app;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  _resetBearerAuthCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body: unknown, status = 201): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status });

function login(db: Database.Database, username: string, password: string) {
  return appFor(db).request("/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

async function waitForFetchCalls(count: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (fetchMock.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`expected ${count} fetch calls, saw ${fetchMock.mock.calls.length}`);
}

describe("POST /api/v1/login", () => {
  it("201 from Forgejo → returns { username, pat } and sets the web auth cookie", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(ok({ sha1: "pat-aaa" }));
    const res = await login(db, "alice", "secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice", pat: "pat-aaa" });
    expect(res.headers.get("set-cookie")).toContain("cosheaf_pat=pat-aaa");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Lax");

    // Forgejo got Basic auth + a non-shared token name/scopes.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/users/alice/tokens");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("alice:secret").toString("base64")}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toMatch(/^cosheaf-[0-9a-f-]{36}$/);
    expect(body.scopes).toContain("write:repository");
  });

  it("401 from Forgejo → bad credentials, no cookie", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(401, { message: "bad" }));
    const res = await login(db, "bob", "wrong");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    [422, "token name in use"],
    [400, "access token name has been used already"],
  ])("%i name-already-used → 502 without deleting another token", async (status, message) => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(status, { message }));
    const res = await login(db, "carol", "secret");
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx from Forgejo → 502 (operator-visible) not 401", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(503, { message: "down" }));
    const res = await login(db, "ed", "secret");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("bad_gateway");
  });

  it("network error → 502", async () => {
    const db = freshDb();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"));
    const res = await login(db, "fay", "secret");
    expect(res.status).toBe(502);
  });

  it("serializes concurrent logins for the same user without sharing credential results", async () => {
    const db = freshDb();
    let resolveFirst: ((value: Response) => void) | undefined;
    fetchMock
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce(failure(401, { message: "bad" }));

    const a = login(db, "gwen", "secret");
    await waitForFetchCalls(1);
    const b = login(db, "gwen", "wrong");

    resolveFirst?.(ok({ sha1: "pat-gwen" }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("400 when username or password missing", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "h" }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/logout", () => {
  it("always returns ok", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/v1/me", () => {
  it("returns { user: null } without Bearer", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it("returns the user when Bearer is valid (cached)", async () => {
    const db = freshDb();
    _seedBearerAuthCacheForTests("pat-iris", "iris");
    const res = await appFor(db).request("/api/v1/me", {
      headers: { authorization: "Bearer pat-iris" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { username: "iris" } });
  });
});
