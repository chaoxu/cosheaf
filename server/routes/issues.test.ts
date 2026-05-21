import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { SSEHub } from "../sse.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { issues } from "./issues.js";
import { freshTestDb, responseOk as ok, seedTestWorkspace } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-issues-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoAdminToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-issues-");
  seedTestWorkspace(db);
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoAdminToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", issues);
  return app;
}


function forgejoIssue(
  number: number,
  title: string,
  opts: { state?: "open" | "closed"; isPr?: boolean } = {},
): { number: number; title: string; state: "open" | "closed"; pull_request?: object | null } {
  return {
    number,
    title,
    state: opts.state ?? "open",
    pull_request: opts.isPr ? {} : null,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetPermCacheForTests();
  _resetBearerAuthCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issues routes", () => {
  it("filters mine as authored OR assigned by the current Forgejo user", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request("/api/v1/w/w/issues?filter=mine&state=all&q=lemma", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("created_by=alice");
    expect(String(fetchMock.mock.calls[1][0])).toContain("assigned_by=alice");
  });

  it("filters assigned issues by the current Forgejo user", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request("/api/v1/w/w/issues?filter=assigned", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("assigned_by=alice");
  });

  it("does not mask Forgejo upstream failures as missing issues", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(new Response("forgejo down", { status: 503 }));

    const res = await appFor(db).request("/api/v1/w/w/issues/7", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("not_found");
  });

  it("fills Forgejo owner/repo when adding an issue dependency", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(res.status).toBe(201);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/dependencies",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      index: 9,
      owner: "owner",
      repo: "w",
    });
    expect(await res.json()).toEqual({
      issue: { number: 7, title: "Theorem", state: "open", is_pr: false },
    });
  });

  it("fills Forgejo owner/repo when removing an issue dependency", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/dependencies", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/dependencies",
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      index: 9,
      owner: "owner",
      repo: "w",
    });
    expect(await res.json()).toEqual({
      issue: { number: 7, title: "Theorem", state: "open", is_pr: false },
    });
  });

  it("maps dependency and block lists to compact DTOs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([forgejoIssue(9, "Lemma"), forgejoIssue(11, "PR", { isPr: true })]))
      .mockResolvedValueOnce(ok([forgejoIssue(12, "Blocked theorem", { state: "closed" })]));

    const deps = await appFor(db).request("/api/v1/w/w/issues/7/dependencies", {
      headers: { authorization: `Bearer ${token}` },
    });
    const blocks = await appFor(db).request("/api/v1/w/w/issues/7/blocks", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(deps.status).toBe(200);
    expect(await deps.json()).toEqual({
      issues: [
        { number: 9, title: "Lemma", state: "open", is_pr: false },
        { number: 11, title: "PR", state: "open", is_pr: true },
      ],
    });
    expect(blocks.status).toBe(200);
    expect(await blocks.json()).toEqual({
      issues: [{ number: 12, title: "Blocked theorem", state: "closed", is_pr: false }],
    });
  });

  it("rejects malformed and self dependency mutations before calling Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const app = appFor(db);

    const badBody = await app.request("/api/v1/w/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9.5 }),
    });
    const self = await app.request("/api/v1/w/w/issues/7/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 7 }),
    });
    const badParam = await app.request("/api/v1/w/w/issues/7.5/dependencies", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ index: 9 }),
    });

    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({
      error: "dependency issue number required",
      code: "validation",
    });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({
      error: "issue cannot depend on itself",
      code: "validation",
    });
    expect(badParam.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
