import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiToken } from "../api-tokens.js";
import { createRegistrationInvite, setRegistrationOpen } from "../site-admin.js";

// The session cookie must be an opaque Cosheaf token that resolves to the user's
// backend credential — not the raw backend PAT (which would loop to /login).
function expectOpaqueCookie(db: Database.Database, setCookie: string | null, username: string, forgejoToken: string): void {
  const token = /cosheaf_pat=([^;]+)/.exec(setCookie ?? "")?.[1] ?? "";
  expect(token.startsWith("cosheaf_")).toBe(true);
  expect(resolveApiToken(db, token)).toEqual({ username, forgejoToken });
}
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, testApp, testConfig } from "./test-fixtures.js";
import { web } from "./web.js";

// trustedProxyHops: 1 makes clientIp honor the per-request X-Forwarded-For we
// set below, so each test keys the rate limiter on its own IP (no cross-test
// budget leak through the module-level limiter).
const openConfig = testConfig("web-register", { registrationOpen: true, trustedProxyHops: 1 });
const offConfig = testConfig("web-register-off"); // registrationOpen defaults false

function appFor(db: Database.Database, registrationOpen = true): Hono<AppEnv> {
  return testApp(db, registrationOpen ? openConfig : offConfig, (app) => app.route("/", web));
}

// Distinct x-forwarded-for per request so the module-level register rate
// limiter (keyed by IP) doesn't leak budget between tests in this file.
function form(fields: Record<string, string>, ip: string, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
      origin: "http://localhost",
      ...extraHeaders,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("web /register", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the signup form when registration is open", async () => {
    const db = freshTestDb("cosheaf-register-");
    const res = await appFor(db).request("/register");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/register"');
    expect(body).toContain("Create account");
  });

  it("404s GET and POST /register when registration is off", async () => {
    const db = freshTestDb("cosheaf-register-");
    const getRes = await appFor(db, false).request("/register");
    expect(getRes.status).toBe(404);
    const postRes = await appFor(db, false).request(
      "/register",
      form({ username: "newbie", password: "secret123" }, "10.0.0.1"),
    );
    expect(postRes.status).toBe(404);
  });

  it("allows a one-time invite to register while public registration is off", async () => {
    const db = freshTestDb("cosheaf-register-");
    const invite = createRegistrationInvite(db, "chao");
    let createBody: { username?: string; email?: string } | null = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
        forge.post("/api/v1/admin/users", async (c) => {
          createBody = await c.req.json();
          return c.json({ id: 1, login: "invitee" }, 201 as 200);
        });
        forge.post("/api/v1/users/:username/tokens", (c) => c.json({ sha1: "invitepat" }));
        forge.get("/api/v1/user", (c) => c.json({ login: "invitee" }));
      }),
    );

    const getRes = await appFor(db, false).request(`/register?invite=${invite}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.text();
    expect(body).toContain(`action="/register?invite=${invite}"`);
    expect(body).toContain(`name="invite" value="${invite}"`);

    const postRes = await appFor(db, false).request(
      `/register?invite=${invite}`,
      form({ username: "invitee", password: "secret123", invite }, "10.0.0.10"),
    );

    expect(postRes.status).toBe(303);
    expect(postRes.headers.get("location")).toBe("/");
    expectOpaqueCookie(db, postRes.headers.get("set-cookie"), "invitee", "invitepat");
    expect(createBody).toMatchObject({ username: "invitee", email: "invitee@cosheaf.local" });
    const row = db.prepare("SELECT used_by, used_at FROM registration_invites").get() as { used_by: string; used_at: number };
    expect(row.used_by).toBe("invitee");
    expect(row.used_at).toBeGreaterThan(0);

    const reused = await appFor(db, false).request(`/register?invite=${invite}`);
    expect(reused.status).toBe(404);
  });

  it("does not allow concurrent registrations to reuse the same invite", async () => {
    const db = freshTestDb("cosheaf-register-");
    const invite = createRegistrationInvite(db, "chao");
    const app = appFor(db, false);
    let createCalls = 0;
    let releaseCreate = (): void => {};
    const createStarted = new Promise<void>((resolve) => {
      fetchMock.mockImplementation(
        fakeForgejo((forge) => {
          forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
          forge.post("/api/v1/admin/users", async (c) => {
            createCalls += 1;
            resolve();
            if (createCalls === 1) await new Promise<void>((release) => { releaseCreate = release; });
            return c.json({ id: createCalls, login: "invitee" }, 201 as 200);
          });
          forge.post("/api/v1/users/:username/tokens", (c) => c.json({ sha1: "invitepat" }));
          forge.get("/api/v1/user", (c) => c.json({ login: "invitee" }));
        }),
      );
    });

    const first = app.request(
      `/register?invite=${invite}`,
      form({ username: "invitee", password: "secret123", invite }, "10.0.0.12"),
    );
    await createStarted;

    const second = await app.request(
      `/register?invite=${invite}`,
      form({ username: "other", password: "secret123", invite }, "10.0.0.13"),
    );
    expect(second.status).toBe(404);
    expect(createCalls).toBe(1);

    releaseCreate();
    const firstRes = await first;
    expect(firstRes.status).toBe(303);
    expect(firstRes.headers.get("location")).toBe("/");
  });

  it("does not allow an invalid invite while public registration is off", async () => {
    const db = freshTestDb("cosheaf-register-");
    const res = await appFor(db, false).request("/register?invite=missing");
    expect(res.status).toBe(404);
  });

  it("uses the site-admin registration setting over the environment default", async () => {
    const db = freshTestDb("cosheaf-register-");
    setRegistrationOpen(db, true, "chao");
    const opened = await appFor(db, false).request("/register");
    expect(opened.status).toBe(200);

    setRegistrationOpen(db, false, "chao");
    const closed = await appFor(db).request("/register");
    expect(closed.status).toBe(404);
  });

  it("creates the Forgejo user, mints a PAT, sets the cookie, and redirects home", async () => {
    const db = freshTestDb("cosheaf-register-");
    let createBody: { username?: string; email?: string } | null = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
        forge.post("/api/v1/admin/users", async (c) => {
          createBody = await c.req.json();
          return c.json({ id: 1, login: "newbie" }, 201 as 200);
        });
        forge.post("/api/v1/users/:username/tokens", (c) => c.json({ sha1: "newpat" }));
        forge.get("/api/v1/user", (c) => c.json({ login: "newbie" }));
      }),
    );

    const res = await appFor(db).request(
      "/register",
      form({ username: "newbie", password: "secret123" }, "10.0.0.2"),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expectOpaqueCookie(db, res.headers.get("set-cookie"), "newbie", "newpat");
    // Email is synthesized, not collected from the form.
    expect(createBody).toMatchObject({ username: "newbie", email: "newbie@cosheaf.local" });
    // The minted PAT was cached for reuse on later logins.
    const cached = db.prepare("SELECT pat FROM login_tokens WHERE username = ?").get("newbie") as { pat: string };
    expect(cached.pat).toBe("newpat");
  });

  it("redirects with error=taken when the username already exists", async () => {
    const db = freshTestDb("cosheaf-register-");
    let createCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.json({ id: 2, login: "taken" }));
        forge.post("/api/v1/admin/users", (c) => {
          createCalled = true;
          return c.json({ id: 2 }, 201 as 200);
        });
      }),
    );

    const res = await appFor(db).request(
      "/register",
      form({ username: "taken", password: "secret123" }, "10.0.0.3"),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/register?error=taken");
    expect(createCalled).toBe(false);
  });

  it("maps a Forgejo 422 on create to error=taken", async () => {
    const db = freshTestDb("cosheaf-register-");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
        forge.post("/api/v1/admin/users", (c) => c.text("user already exists", 422 as 200));
      }),
    );

    const res = await appFor(db).request(
      "/register",
      form({ username: "racer", password: "secret123" }, "10.0.0.4"),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/register?error=taken");
  });

  it("redirects with error=missing when a field is blank", async () => {
    const db = freshTestDb("cosheaf-register-");
    const res = await appFor(db).request("/register", form({ username: "newbie" }, "10.0.0.5"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/register?error=missing");
  });

  it("preserves an invite token across registration validation errors", async () => {
    const db = freshTestDb("cosheaf-register-");
    const invite = createRegistrationInvite(db, "chao");
    const res = await appFor(db, false).request(
      "/register",
      form({ username: "bad name", password: "secret123", invite }, "10.0.0.11"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/register?error=invalid&invite=${invite}`);
  });

  it("redirects with error=invalid for a username Forgejo names reject", async () => {
    const db = freshTestDb("cosheaf-register-");
    const res = await appFor(db).request(
      "/register",
      form({ username: "bad name", password: "secret123" }, "10.0.0.6"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/register?error=invalid");
  });

  it("rejects a cross-site POST with 403", async () => {
    const db = freshTestDb("cosheaf-register-");
    const res = await appFor(db).request(
      "/register",
      form({ username: "newbie", password: "secret123" }, "10.0.0.7", { origin: "http://evil.test" }),
    );
    expect(res.status).toBe(403);
  });

  it("maps a generic Forgejo create failure to error=upstream", async () => {
    const db = freshTestDb("cosheaf-register-");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
        forge.post("/api/v1/admin/users", (c) => c.text("boom", 500 as 200));
      }),
    );
    const res = await appFor(db).request(
      "/register",
      form({ username: "newbie", password: "secret123" }, "10.0.0.8"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/register?error=upstream");
  });

  it("sends the user to sign in (no cookie) when the account is created but the PAT mint fails", async () => {
    const db = freshTestDb("cosheaf-register-");
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/users/:username", (c) => c.text("not found", 404 as 200));
        forge.post("/api/v1/admin/users", (c) => c.json({ id: 1, login: "newbie" }, 201 as 200));
        forge.post("/api/v1/users/:username/tokens", (c) => c.text("boom", 500 as 200));
      }),
    );
    const res = await appFor(db).request(
      "/register",
      form({ username: "newbie", password: "secret123" }, "10.0.0.9"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?registered=1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renders the registered notice and a register link on GET /login only when open", async () => {
    const db = freshTestDb("cosheaf-register-");
    const open = await (await appFor(db).request("/login")).text();
    expect(open).toContain('href="/register"');
    expect(open).toContain("Create an account");

    const off = await (await appFor(db, false).request("/login")).text();
    expect(off).not.toContain("/register");

    const registered = await (await appFor(db).request("/login?registered=1")).text();
    expect(registered).toContain("Account created");
  });

  it("rate-limits repeated attempts from one IP", async () => {
    const db = freshTestDb("cosheaf-register-");
    const ip = "10.9.9.9";
    const locations: Array<string | null> = [];
    // Blank-field posts trip the limiter (which runs before validation) without
    // any Forgejo calls. The budget is 5/window, so a later attempt is throttled.
    for (let i = 0; i < 8; i++) {
      const res = await appFor(db).request("/register", form({}, ip));
      locations.push(res.headers.get("location"));
    }
    expect(locations[0]).toBe("/register?error=missing");
    expect(locations).toContain("/register?error=rate");
  });
});

describe("web auth form origin checks", () => {
  it("rejects cross-origin login and logout posts", async () => {
    const db = freshTestDb("cosheaf-auth-origin-");
    const app = appFor(db);
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://evil.test",
      host: "cosheaf.test",
    };

    const login = await app.request("/login", {
      method: "POST",
      headers,
      body: new URLSearchParams({ username: "alice", password: "secret" }).toString(),
    });
    const logout = await app.request("/logout", {
      method: "POST",
      headers,
    });

    expect(login.status).toBe(403);
    expect(logout.status).toBe(403);
  });
});
