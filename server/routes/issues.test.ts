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
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
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
): {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Array<{ id: number; name: string; color: string; exclusive?: boolean; is_archived?: boolean }>;
  comments: number;
  created_at: string;
  updated_at: string;
  user: { login: string };
  assignees: [];
  closed_at: null;
  pull_request?: object | null;
} {
  return {
    number,
    title,
    body: "",
    state: opts.state ?? "open",
    labels: [],
    comments: 0,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:01:00Z",
    user: { login: "alice" },
    assignees: [],
    closed_at: null,
    pull_request: opts.isPr ? {} : null,
  };
}

function forgejoActivity(id: number, username: string, refName: string, message: string, sha: string): object {
  return {
    id,
    op_type: "commit_repo",
    act_user: { login: username },
    ref_name: refName,
    content: JSON.stringify({ Commits: [{ Sha1: sha, Message: message }] }),
    created: `2026-05-24T00:00:0${id}Z`,
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
  it("serves issue comments through Cosheaf DTOs", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([
      {
        id: 101,
        body: "looks **good**",
        user: { login: "alice" },
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:01:00Z",
      },
    ]));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/comments", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/comments",
    );
    await expect(res.json()).resolves.toMatchObject({
      comments: [
        {
          id: 101,
          body: "looks **good**",
          author_username: "alice",
        },
      ],
    });
  });

  it("updates issue state through a typed route", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Theorem", { state: "closed" }), labels: [], comments: 0 }));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/state", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ state: "closed" });
    await expect(res.json()).resolves.toEqual({ ok: true, state: "closed" });
  });

  it("PATCH /issues/:number edits the Forgejo issue title and body", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Retitled"), body: "Updated" }));

    const res = await appFor(db).request("/api/v1/w/w/issues/7", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: " Retitled ", body: "Updated" }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/issues/7");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      title: "Retitled",
      body: "Updated",
    });
    await expect(res.json()).resolves.toMatchObject({ title: "Retitled", body: "Updated" });
  });

  it("serves labels, milestones, and markdown rendering without backend-shaped paths", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 1, name: "bug", color: "ff0000", description: "broken", exclusive: false, is_archived: false }]))
      .mockResolvedValueOnce(ok([{ id: 2, title: "v1", description: "ship", state: "open", open_issues: 1, closed_issues: 0, due_on: null }]))
      .mockResolvedValueOnce(new Response("<p>Hello</p>", { status: 200, headers: { "content-type": "text/html" } }));

    const app = appFor(db);
    const labels = await app.request("/api/v1/w/w/labels", {
      headers: { authorization: `Bearer ${token}` },
    });
    const milestones = await app.request("/api/v1/w/w/milestones?state=all", {
      headers: { authorization: `Bearer ${token}` },
    });
    const markdown = await app.request("/api/v1/w/w/markdown/render", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(labels.status).toBe(200);
    expect(milestones.status).toBe(200);
    expect(markdown.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/labels");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/milestones?state=all");
    expect(String(fetchMock.mock.calls[2][0])).toBe("http://forgejo.test/api/v1/repos/owner/w/markdown");
    await expect(markdown.json()).resolves.toEqual({ html: "<p>Hello</p>" });
  });

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

  it("maps Forgejo-native issue filters", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockImplementation(async () => ok([]));

    const res = await appFor(db).request(
      "/api/v1/w/w/issues?state=all&labels=bug&milestones=2&created_by=meri&assigned_by=vera&q=refactor&sort=oldest",
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("labels")).toBe("bug");
    expect(url.searchParams.get("milestones")).toBe("2");
    expect(url.searchParams.get("created_by")).toBe("meri");
    expect(url.searchParams.get("assigned_by")).toBe("vera");
    expect(url.searchParams.get("q")).toBe("refactor");
    expect(url.searchParams.get("sort")).toBe("oldest");
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

  it("rejects newly assigning archived labels", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([{ id: 3, name: "old", color: "888888", is_archived: true }]))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [3] }),
    });

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects multiple exclusive labels from the same scope", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock
      .mockResolvedValueOnce(ok([
        { id: 1, name: "kind/bug", color: "ff0000", exclusive: true },
        { id: 2, name: "kind/task", color: "00ff00", exclusive: true },
      ]))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("only one label in scope kind");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat slashless exclusive labels as scoped labels", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const labels = [
      { id: 1, name: "bug", color: "ff0000", exclusive: true },
      { id: 2, name: "task", color: "00ff00", exclusive: true },
    ];
    fetchMock
      .mockResolvedValueOnce(ok(labels))
      .mockResolvedValueOnce(ok(forgejoIssue(7, "Theorem")))
      .mockResolvedValueOnce(ok(labels));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [1, 2] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      labels: [
        { name: "bug", scope: null },
        { name: "task", scope: null },
      ],
    });
  });

  it("allows keeping archived labels that are already attached", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    const archived = { id: 3, name: "old", color: "888888", is_archived: true };
    fetchMock
      .mockResolvedValueOnce(ok([archived]))
      .mockResolvedValueOnce(ok({ ...forgejoIssue(7, "Theorem"), labels: [archived] }))
      .mockResolvedValueOnce(ok([archived]));

    const res = await appFor(db).request("/api/v1/w/w/issues/7/labels", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ labels: [3] }),
    });

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      "http://forgejo.test/api/v1/repos/owner/w/issues/7/labels",
    );
    await expect(res.json()).resolves.toMatchObject({
      labels: [{ id: 3, name: "old", is_archived: true }],
    });
  });

  it("normalizes activity limits before forwarding to Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValue(ok([]));
    const app = appFor(db);

    await app.request("/api/v1/w/w/activities?limit=-5", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/w/w/activities?limit=abc", {
      headers: { authorization: `Bearer ${token}` },
    });
    await app.request("/api/v1/w/w/activities?limit=999", {
      headers: { authorization: `Bearer ${token}` },
    });

    const limits = fetchMock.mock.calls.map((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get("limit");
    });
    expect(limits).toEqual(["1", "50", "100"]);
  });

  it("collapses adjacent edit-branch commit activity", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([
      forgejoActivity(3, "alice", "refs/heads/user/alice/wip", "update three.md", "cccc"),
      forgejoActivity(2, "alice", "refs/heads/user/alice/wip", "update two.md", "bbbb"),
      forgejoActivity(1, "alice", "refs/heads/user/alice/wip", "update one.md", "aaaa"),
      forgejoActivity(4, "alice", "refs/heads/main", "merge pull request", "dddd"),
    ]));

    const res = await appFor(db).request("/api/v1/w/w/activities", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      activities: [
        {
          id: 3,
          op_type: "commit_repo",
          ref_name: "refs/heads/user/alice/wip",
          commit_sha: "cccc",
          commit_message: "update three.md",
          repeat_count: 3,
        },
        {
          id: 4,
          op_type: "commit_repo",
          ref_name: "refs/heads/main",
          repeat_count: 1,
        },
      ],
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
