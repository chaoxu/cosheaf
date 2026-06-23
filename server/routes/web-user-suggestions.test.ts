import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { authHeaders, seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { web } from "./web.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-user-suggestions");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/", web));
}

describe("web user suggestions", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns Forgejo user suggestions for repo username fields", async () => {
    const db = freshTestDb("cosheaf-user-suggestions-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/users/search", () => Response.json({
        ok: true,
        data: [
          { id: 1, login: "bob" },
          { id: 2, login: "carol" },
        ],
      }));
    }));

    const res = await appFor(db).request("/owner/w/user-suggestions?q=bo", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: ["bob", "carol"] });
  });

  it("does not fetch collaborators while suggesting access-grant users", async () => {
    const db = freshTestDb("cosheaf-user-suggestions-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "admin" });
    let listedCollaborators = false;
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/users/search", () => Response.json({
        ok: true,
        data: [
          { id: 1, login: "bob" },
          { id: 2, login: "existing" },
        ],
      }));
      forge.get("/api/v1/repos/owner/w/collaborators", () => {
        listedCollaborators = true;
        return Response.json([{ id: 2, login: "existing" }]);
      });
    }));

    const res = await appFor(db).request("/owner/w/user-suggestions?q=b&exclude=collaborators", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: ["bob", "existing"] });
    expect(listedCollaborators).toBe(false);
  });
});
