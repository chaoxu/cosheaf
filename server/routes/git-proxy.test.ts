import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPermCacheForTests } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { basicPat, gitProxy, parseGitRepo } from "./git-proxy.js";
import { fakeForgejo, freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("git-proxy");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/", gitProxy));
}

// PAT as the HTTP Basic password — git sends `username:pat`.
function basic(pat: string, user = "git"): string {
  return `Basic ${Buffer.from(`${user}:${pat}`).toString("base64")}`;
}

describe("parseGitRepo", () => {
  it("strips the .git suffix and validates names", () => {
    expect(parseGitRepo("chao", "flushing-coin.git")).toEqual({ owner: "chao", repo: "flushing-coin" });
  });
  it("rejects a repo without the .git suffix (falls through to other routes)", () => {
    expect(parseGitRepo("chao", "flushing-coin")).toBeNull();
  });
  it("rejects names that fail the Forgejo name pattern", () => {
    expect(parseGitRepo("../etc", "x.git")).toBeNull();
    expect(parseGitRepo("chao", "..git")).toBeNull();
  });
  it("rejects missing segments", () => {
    expect(parseGitRepo(undefined, "x.git")).toBeNull();
    expect(parseGitRepo("chao", undefined)).toBeNull();
  });
});

describe("basicPat", () => {
  it("extracts the password from a Basic header", () => {
    expect(basicPat(basic("tok123"))).toBe("tok123");
  });
  it("returns null without a Basic header", () => {
    expect(basicPat(undefined)).toBeNull();
    expect(basicPat("Bearer tok")).toBeNull();
  });
  it("returns null when the credential carries no password", () => {
    expect(basicPat(`Basic ${Buffer.from("justuser").toString("base64")}`)).toBeNull();
  });
});

describe("git proxy route", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetPermCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  // A fake Forgejo that knows the current user, answers the collaborator
  // permission probe (so resolveRepoRole runs for real), and echoes git
  // transport. The info/refs handler reports the Authorization header it
  // received so we can assert the proxy rewrote it to `username:pat`.
  function fakeBackend(permission: "admin" | "write" | "read" | "none", login = "alice") {
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", (c) => c.json({ id: 1, login }));
        forge.get("/api/v1/repos/:owner/:repo/collaborators/:user/permission", (c) =>
          c.json({ permission }),
        );
        forge.get("/:owner/:repo/info/refs", (c) =>
          c.text(`auth=${c.req.header("authorization") ?? ""}`, 200, {
            "content-type": "application/x-git-upload-pack-advertisement",
          }),
        );
      }),
    );
  }

  it("challenges an unauthenticated clone with 401 Basic and never hits Forgejo", async () => {
    const db = freshTestDb("cosheaf-gitproxy-");
    const res = await appFor(db).request("/owner/w.git/info/refs?service=git-upload-pack");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the caller has no role on the repo (anti-enumeration)", async () => {
    const db = freshTestDb("cosheaf-gitproxy-");
    fakeBackend("none");
    const res = await appFor(db).request("/owner/w.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basic("tok") },
    });
    expect(res.status).toBe(404);
  });

  it("403s a push (git-receive-pack) for a read-only collaborator", async () => {
    const db = freshTestDb("cosheaf-gitproxy-");
    fakeBackend("read");
    const res = await appFor(db).request("/owner/w.git/info/refs?service=git-receive-pack", {
      headers: { authorization: basic("tok") },
    });
    expect(res.status).toBe(403);
  });

  it("proxies a read advertise and rewrites auth to the caller's credential", async () => {
    const db = freshTestDb("cosheaf-gitproxy-");
    fakeBackend("read");
    const res = await appFor(db).request("/owner/w.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basic("tok123", "whatever") },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    // The proxy authenticates upstream as the resolved Forgejo username + PAT,
    // not the arbitrary username the git client typed.
    expect(await res.text()).toBe(`auth=${basic("tok123", "alice")}`);
  });

  it("rejects an unknown git service", async () => {
    const db = freshTestDb("cosheaf-gitproxy-");
    const res = await appFor(db).request("/owner/w.git/info/refs?service=bogus", {
      headers: { authorization: basic("tok") },
    });
    expect(res.status).toBe(404);
  });
});
