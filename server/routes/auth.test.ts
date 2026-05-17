// Auth route tests. Stubs global fetch so we exercise the PAT-exchange
// flow without a live Forgejo. Each test starts from a fresh in-memory
// DB and the per-username serialization map is implicit (process-global,
// cleared between tests because each test uses a fresh username).

import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { AppEnv } from "../types.js";
import { createSession, upsertUserFromForgejo } from "../users.js";
import { auth } from "./auth.js";
import { freshTestDb } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-auth-test",
  port: 3030,
  sessionSecret: "test-secret-test-secret-test-secret",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
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
  it("201 from Forgejo → stores encrypted PAT and sets session cookie", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(ok({ sha1: "pat-aaa" }));
    const res = await login(db, "alice", "secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: expect.any(Number), username: "alice" });
    expect(res.headers.get("set-cookie")).toMatch(/session=/);

    // Forgejo got Basic auth + the right token name/scopes
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://forgejo.test/api/v1/users/alice/tokens");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("alice:secret").toString("base64")}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.name).toBe("cosheaf");
    expect(body.scopes).toContain("write:repository");

    // PAT row landed
    const row = db
      .prepare("SELECT forgejo_token_ciphertext FROM users WHERE username = 'alice'")
      .get() as { forgejo_token_ciphertext: Buffer };
    expect(row.forgejo_token_ciphertext.byteLength).toBeGreaterThan(0);
  });

  it("401 from Forgejo → bad credentials, no row, no cookie", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(401, { message: "bad" }));
    const res = await login(db, "bob", "wrong");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it.each([
    [422, "token name in use"],
    [400, "access token name has been used already"],
  ])("%i name-already-used → delete then retry → success", async (status, message) => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(failure(status, { message }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // DELETE
      .mockResolvedValueOnce(ok({ sha1: "pat-fresh" }));         // POST retry
    const res = await login(db, "carol", "secret");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "http://forgejo.test/api/v1/users/carol/tokens/cosheaf",
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
  });

  it("400 without name-in-use marker is a real error → 502", async () => {
    // Generic Forgejo 400 (e.g. invalid scope, password complexity rejected
    // at PAT-creation time) must not loop into the delete-retry path.
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(400, { message: "PasswordComplexityTooLow" }));
    const res = await login(db, "carol", "secret");
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it("name-in-use + delete fails → 502 forgejo unavailable", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(failure(400, { message: "name has been used" }))
      .mockResolvedValueOnce(failure(500));                      // DELETE blew up
    const res = await login(db, "dan", "secret");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("bad_gateway");
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

describe("GET /api/v1/me", () => {
  it("returns null for a valid cookie session whose Forgejo PAT is missing", async () => {
    const db = freshDb();
    const user = upsertUserFromForgejo(db, "iris");
    const session = createSession(db, user.id);

    const res = await appFor(db).request("/api/v1/me", {
      headers: { cookie: `session=${session}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });
});
