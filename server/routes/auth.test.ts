// Auth route tests. Stubs global fetch so we exercise the PAT-exchange
// flow without a live Forgejo. Each test starts from a fresh in-memory
// DB and the per-username serialization map is implicit (process-global,
// cleared between tests because each test uses a fresh username).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { AppEnv } from "../types.js";
import { auth } from "./auth.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-auth-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  return db;
}

function appFor(db: Database.Database) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    await next();
  });
  app.route("/api/v1/auth", auth);
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
  return appFor(db).request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

describe("POST /api/v1/auth/login", () => {
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

  it("concurrent logins for same user share one PAT exchange (no race)", async () => {
    // Two simultaneous logins must not both POST + DELETE — the loser would
    // clobber the winner's freshly-issued token. The in-process serializer
    // collapses them onto one fetch chain.
    const db = freshDb();
    let resolveFirst: ((v: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => { resolveFirst = r; }),
    );
    const a = login(db, "gwen", "secret");
    const b = login(db, "gwen", "secret");
    // Yield to the event loop so both handlers reach the in-flight check.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    resolveFirst?.(ok({ sha1: "shared-pat" }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400 when username or password missing", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "h" }),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
