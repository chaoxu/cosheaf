// Auth route tests. Stubs global fetch so we exercise the PAT-exchange
// flow without a live Forgejo. Login returns an opaque Cosheaf token for API
// clients and also sets an HttpOnly cookie so server-rendered web pages can
// authenticate normal GET requests without receiving the backing Forgejo PAT.

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashApiToken } from "../api-tokens.js";
import { _resetBearerAuthCacheForTests, _seedBearerAuthCacheForTests } from "../middleware.js";
import { auth } from "./auth.js";
import { freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("auth");
const publicOriginConfig = testConfig("auth-public-origin", { publicOrigin: "https://cosheaf.lab" });

function freshDb(): Database.Database {
  return freshTestDb("cosheaf-auth-");
}

function appFor(db: Database.Database, appConfig = config) {
  return testApp(db, appConfig, (app) => app.route("/api/v1", auth));
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

function mintOk(pat: string, username: string): void {
  fetchMock
    .mockResolvedValueOnce(ok({ sha1: pat }))
    .mockResolvedValueOnce(ok({ login: username }, 200));
}

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

async function expectOpaqueLoginToken(
  db: Database.Database,
  res: Response,
  username: string,
  forgejoPat: string,
): Promise<string> {
  const body = await res.json() as { username: string; pat: string; token_type: string };
  expect(body.username).toBe(username);
  expect(body.token_type).toBe("cosheaf");
  expect(body.pat).toMatch(/^cosheaf_[A-Za-z0-9_-]+$/);
  expect(body.pat).not.toBe(forgejoPat);
  const row = db.prepare("SELECT username, forgejo_pat FROM api_tokens WHERE token_hash = ?")
    .get(hashApiToken(body.pat)) as { username: string; forgejo_pat: string } | undefined;
  expect(row).toEqual({ username, forgejo_pat: forgejoPat });
  return body.pat;
}

describe("POST /api/v1/login", () => {
  it("201 from Forgejo → returns an opaque Cosheaf token and sets the web auth cookie", async () => {
    const db = freshDb();
    mintOk("pat-aaa", "alice");
    const res = await login(db, "alice", "secret");
    expect(res.status).toBe(200);
    const apiToken = await expectOpaqueLoginToken(db, res, "alice", "pat-aaa");
    expect(res.headers.get("set-cookie")).toContain(`cosheaf_pat=${apiToken}`);
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

  it("sets Secure on the login cookie when the configured public origin is https", async () => {
    const db = freshDb();
    mintOk("pat-secure", "alice");

    const res = await appFor(db, publicOriginConfig).request("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects explicit cross-origin browser login posts before minting a PAT", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.test",
        host: "localhost",
      },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("allows originless API login clients", async () => {
    const db = freshDb();
    mintOk("pat-api", "alice");

    const res = await appFor(db).request("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });

    expect(res.status).toBe(200);
    await expectOpaqueLoginToken(db, res, "alice", "pat-api");
  });

  it("rejects non-string credentials before contacting Forgejo", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: { login: "alice" }, password: ["secret"] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing credentials" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("serves the public Gitea-compatible version probe", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "cosheaf" });
  });

  it("serves the authenticated Gitea-compatible current user probe", async () => {
    const db = freshDb();
    mintOk("pat-user", "alice");
    const loginRes = await login(db, "alice", "secret");
    const token = await expectOpaqueLoginToken(db, loginRes, "alice", "pat-user");

    const res = await appFor(db).request("/api/v1/user", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      login: "alice",
      username: "alice",
      active: true,
    });
  });

  it("serves an empty Gitea-compatible SSH key list for tea login", async () => {
    const db = freshDb();
    mintOk("pat-user", "alice");
    const loginRes = await login(db, "alice", "secret");
    const token = await expectOpaqueLoginToken(db, loginRes, "alice", "pat-user");

    const res = await appFor(db).request("/api/v1/user/keys?limit=0&page=0", {
      headers: { authorization: `token ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("401 from Forgejo → bad credentials, no cookie", async () => {
    const db = freshDb();
    fetchMock.mockResolvedValueOnce(failure(401, { message: "bad" }));
    const res = await login(db, "test-bob", "wrong");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthorized");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    [422, "token name in use"],
    [400, "access token name has been used already"],
  ])("%i name-already-used retries with a fresh token name", async (status, message) => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(failure(status, { message }))
      .mockResolvedValueOnce(ok({ sha1: "pat-carol" }))
      .mockResolvedValueOnce(ok({ login: "carol" }, 200));

    const res = await login(db, "carol", "secret");
    expect(res.status).toBe(200);
    await expectOpaqueLoginToken(db, res, "carol", "pat-carol");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstName = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name;
    const secondName = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).name;
    expect(secondName).not.toBe(firstName);
  });

  it("returns 502 after repeated token-name collisions", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(failure(422, { message: "token name in use" }))
      .mockResolvedValueOnce(failure(422, { message: "token name in use" }))
      .mockResolvedValueOnce(failure(422, { message: "token name in use" }));

    const res = await login(db, "carol", "secret");

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce(ok({ login: "gwen" }, 200))
      .mockResolvedValueOnce(failure(401, { message: "bad" }));

    const a = login(db, "gwen", "secret");
    await waitForFetchCalls(1);
    const b = login(db, "gwen", "wrong");

    resolveFirst?.(ok({ sha1: "pat-gwen" }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses a cached PAT after revalidating the password", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-hen" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200))
      .mockResolvedValueOnce(failure(400, { message: "access token name has been used already" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200));

    const first = await login(db, "hen", "secret");
    const second = await login(db, "hen", "secret");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expectOpaqueLoginToken(db, second, "hen", "pat-hen");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).name)
      .toBe(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name);
    expect(String(fetchMock.mock.calls[3][0])).toBe("http://forgejo.test/api/v1/user");
    expect(((fetchMock.mock.calls[3][1] as RequestInit).headers as Record<string, string>).authorization)
      .toBe("token pat-hen");
  });

  it("stores login PATs under Forgejo's canonical username casing", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-chao" }))
      .mockResolvedValueOnce(ok({ login: "chao" }, 200));

    const res = await login(db, "Chao", "secret");

    expect(res.status).toBe(200);
    await expectOpaqueLoginToken(db, res, "chao", "pat-chao");
    const rows = db.prepare("SELECT username, pat FROM login_tokens WHERE username = ? COLLATE NOCASE")
      .all("chao") as Array<{ username: string; pat: string }>;
    expect(rows).toEqual([{ username: "chao", pat: "pat-chao" }]);
  });

  it("removes stale case aliases after verifying a cached PAT", async () => {
    const db = freshDb();
    db.prepare(`
      INSERT INTO login_tokens (username, pat, token_name, scopes, created_at, updated_at)
      VALUES
        ('Chao', 'pat-old', 'cosheaf-old', ?, 1, 1),
        ('chao', 'pat-current', 'cosheaf-current', ?, 2, 2)
    `).run("read:repository", "read:repository");
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-new" }))
      .mockResolvedValueOnce(ok({ login: "chao" }, 200));

    const res = await login(db, "Chao", "secret");

    expect(res.status).toBe(200);
    await expectOpaqueLoginToken(db, res, "chao", "pat-new");
    const rows = db.prepare("SELECT username, pat FROM login_tokens WHERE username = ? COLLATE NOCASE ORDER BY username")
      .all("chao") as Array<{ username: string; pat: string }>;
    expect(rows).toEqual([{ username: "chao", pat: "pat-new" }]);
  });

  it("re-mints a cached PAT when Forgejo reports the stored PAT was revoked", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-old" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200))
      .mockResolvedValueOnce(failure(400, { message: "access token name has been used already" }))
      .mockResolvedValueOnce(failure(401, { message: "revoked" }))
      .mockResolvedValueOnce(ok({ sha1: "pat-new" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200));

    const first = await login(db, "hen", "secret");
    const second = await login(db, "hen", "secret");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expectOpaqueLoginToken(db, second, "hen", "pat-new");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const firstTokenName = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name;
    const cachedTokenName = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).name;
    const remintedTokenName = JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string).name;
    expect(cachedTokenName).toBe(firstTokenName);
    expect(remintedTokenName).not.toBe(firstTokenName);
    expect(String(fetchMock.mock.calls[3][0])).toBe("http://forgejo.test/api/v1/user");
    expect(((fetchMock.mock.calls[3][1] as RequestInit).headers as Record<string, string>).authorization)
      .toBe("token pat-old");

    const row = db.prepare("SELECT pat, token_name FROM login_tokens WHERE username = 'hen'")
      .get() as { pat: string; token_name: string };
    expect(row).toEqual({ pat: "pat-new", token_name: remintedTokenName });
  });

  it("replaces a cached PAT when Forgejo lets the cached token name be recreated", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-old" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200))
      .mockResolvedValueOnce(ok({ sha1: "pat-new" }))
      .mockResolvedValueOnce(ok({ login: "hen" }, 200));

    const first = await login(db, "hen", "secret");
    const second = await login(db, "hen", "secret");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expectOpaqueLoginToken(db, second, "hen", "pat-new");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstTokenName = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name;
    const recreatedTokenName = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).name;
    expect(recreatedTokenName).toBe(firstTokenName);
    const row = db.prepare("SELECT pat, token_name FROM login_tokens WHERE username = 'hen'")
      .get() as { pat: string; token_name: string };
    expect(row).toEqual({ pat: "pat-new", token_name: firstTokenName });
  });

  it("does not return a cached PAT when the password is wrong", async () => {
    const db = freshDb();
    fetchMock
      .mockResolvedValueOnce(ok({ sha1: "pat-ivy" }))
      .mockResolvedValueOnce(ok({ login: "ivy" }, 200))
      .mockResolvedValueOnce(failure(401, { message: "bad" }));

    const first = await login(db, "ivy", "secret");
    const res = await login(db, "ivy", "wrong");

    expect(first.status).toBe(200);
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe("http://forgejo.test/api/v1/users/ivy/tokens");
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).name)
      .toBe(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).name);
  });

  it("re-mints a cached PAT when the stored scope set no longer matches (#148)", async () => {
    const db = freshDb();
    // A token cached before the scope set changed — stale signature.
    db.prepare(`
      INSERT INTO login_tokens (username, pat, token_name, scopes, created_at, updated_at)
      VALUES ('jon', 'pat-old', 'cosheaf-stale', 'read:repository', 1, 1)
    `).run();
    mintOk("pat-new", "jon");

    const res = await login(db, "jon", "secret");

    expect(res.status).toBe(200);
    await expectOpaqueLoginToken(db, res, "jon", "pat-new");
    // One mint call plus canonical user verification — the stale PAT is not served.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/users/jon/tokens");
    // The row now records the current full scope signature.
    const row = db.prepare("SELECT pat, scopes FROM login_tokens WHERE username = 'jon'")
      .get() as { pat: string; scopes: string };
    expect(row.pat).toBe("pat-new");
    expect(row.scopes).toContain("write:user");
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
    const res = await appFor(db).request("/api/v1/logout", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects explicit cross-origin browser logout posts", async () => {
    const db = freshDb();
    const crossOrigin = await appFor(db).request("/api/v1/logout", {
      method: "POST",
      headers: { origin: "http://evil.test", host: "localhost" },
    });

    expect(crossOrigin.status).toBe(403);
  });

  it("rejects originless browser logout posts", async () => {
    const db = freshDb();
    const res = await appFor(db).request("/api/v1/logout", { method: "POST" });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
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
