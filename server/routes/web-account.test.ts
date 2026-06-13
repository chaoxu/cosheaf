import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { web } from "./web.js";
import { fakeForgejo, freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-account");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/", web));
}

// Hono's `app.request(path, init, env)` third arg is the Env, not extra
// headers — the cookie must ride in the init's own headers.
function form(fields: Record<string, string>, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(token ? { cookie: `cosheaf_pat=${token}` } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("POST /account/settings (profile)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetPermCacheForTests();
    _resetBearerAuthCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("trims the form fields, PATCHes Forgejo, and redirects with saved=1", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    let patched: unknown;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.patch("/api/v1/user/settings", async (c) => {
          patched = await c.req.json();
          return c.json({ id: 1, login: "alice" });
        });
      }),
    );

    const res = await appFor(db).request(
      "/account/settings",
      form({ full_name: "  Alice A  ", description: " bio ", website: "", location: "Mars" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/settings?saved=1");
    expect(patched).toEqual({ full_name: "Alice A", description: "bio", website: "", location: "Mars" });
  });

  it("redirects with an error when Forgejo rejects the edit", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.patch("/api/v1/user/settings", (c) => c.text("nope", 422 as 200));
      }),
    );

    const res = await appFor(db).request(
      "/account/settings",
      form({ full_name: "x", description: "", website: "", location: "" }, token),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/account\/settings\?error=/);
  });

  it("redirects to login when unauthenticated", async () => {
    const db = freshTestDb("cosheaf-account-");
    const res = await appFor(db).request("/account/settings", form({ full_name: "x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders the profile form prefilled from Forgejo on GET", async () => {
    const db = freshTestDb("cosheaf-account-");
    const token = seedAuthUser(db, config, { username: "alice" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", (c) =>
          c.json({ id: 1, login: "alice", email: "a@x.test", full_name: "Alice A", location: "Mars" }),
        );
      }),
    );

    const res = await appFor(db).request("/account/settings", {
      headers: { cookie: `cosheaf_pat=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="profile-form"');
    expect(body).toContain('value="Alice A"');
    expect(body).toContain('value="Mars"');
    // email is shown read-only
    expect(body).toContain('value="a@x.test"');
  });
});
