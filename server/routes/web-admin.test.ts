import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { bootstrapSiteAdmins, effectiveRegistrationOpen, isSiteAdmin } from "../site-admin.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";
import { web } from "./web.js";
import { fakeForgejo, freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-admin");

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = testApp(db, config, (hono) => hono.route("/", web));
  app.onError(handleAppError);
  return app;
}

function authHeaders(token: string): Record<string, string> {
  return { cookie: `cosheaf_pat=${token}` };
}

function form(token: string, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
      ...authHeaders(token),
    },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("web /admin", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders site controls for a global admin", async () => {
    const db = freshTestDb("cosheaf-admin-");
    db.prepare("INSERT INTO site_admins (username, created_at) VALUES (?, ?)").run("chao", Date.now());
    const token = seedAuthUser(db, config, { username: "chao" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/user", (c) => c.json({ id: 1, login: "chao" }));
    }));

    const res = await appFor(db).request("/admin", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="site-registration"');
    expect(body).toContain('data-testid="site-registration-invites"');
    expect(body).toContain('href="/admin"');
  });

  it("hides admin controls from normal users", async () => {
    const db = freshTestDb("cosheaf-admin-");
    const token = seedAuthUser(db, config, { username: "alice" });
    const res = await appFor(db).request("/admin", { headers: authHeaders(token) });
    expect(res.status).toBe(404);
  });

  it("lets a global admin open and close registration", async () => {
    const db = freshTestDb("cosheaf-admin-");
    db.prepare("INSERT INTO site_admins (username, created_at) VALUES (?, ?)").run("chao", Date.now());
    const token = seedAuthUser(db, config, { username: "chao" });

    const open = await appFor(db).request("/admin/registration", form(token, { registration_open: "open" }));
    expect(open.status).toBe(303);
    expect(open.headers.get("location")).toBe("/admin?saved=1");
    expect(effectiveRegistrationOpen(db, config)).toBe(true);

    const closed = await appFor(db).request("/admin/registration", form(token, { registration_open: "closed" }));
    expect(closed.status).toBe(303);
    expect(effectiveRegistrationOpen(db, config)).toBe(false);
  });

  it("lets a global admin create a registration invite link", async () => {
    const db = freshTestDb("cosheaf-admin-");
    db.prepare("INSERT INTO site_admins (username, created_at) VALUES (?, ?)").run("chao", Date.now());
    const token = seedAuthUser(db, config, { username: "chao" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/user", (c) => c.json({ id: 1, login: "chao" }));
    }));

    const created = await appFor(db).request("/admin/registration-invites", form(token, {}));

    expect(created.status).toBe(303);
    const location = created.headers.get("location");
    expect(location).toMatch(/^\/admin\?invite=[A-Za-z0-9_-]+$/);
    const row = db.prepare("SELECT created_by, used_by, used_at FROM registration_invites").get() as {
      created_by: string;
      used_by: string | null;
      used_at: number | null;
    };
    expect(row).toMatchObject({ created_by: "chao", used_by: null, used_at: null });

    const rendered = await appFor(db).request(location ?? "/admin", { headers: authHeaders(token) });
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain("/register?invite=");
  });

  it("rejects cross-origin registration admin posts", async () => {
    const db = freshTestDb("cosheaf-admin-");
    db.prepare("INSERT INTO site_admins (username, created_at) VALUES (?, ?)").run("chao", Date.now());
    const token = seedAuthUser(db, config, { username: "chao" });

    const res = await appFor(db).request("/admin/registration-invites", {
      ...form(token, {}),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.test",
        ...authHeaders(token),
      },
    });

    expect(res.status).toBe(403);
  });
});

describe("site admin bootstrap", () => {
  it("makes chao the first global admin on startup", () => {
    const db = freshTestDb("cosheaf-admin-");
    bootstrapSiteAdmins(db);
    expect(isSiteAdmin(db, "chao")).toBe(true);
  });
});
