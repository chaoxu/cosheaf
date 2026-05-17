import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { SSEHub } from "../sse.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { notifications } from "./notifications.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-notifications-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-notifs-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)",
  ).run();
  return db;
}

function appFor(db: Database.Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/w", notifications);
  return app;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
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

describe("notifications route", () => {
  it("pushes unread issue/pull filtering into Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    fetchMock.mockResolvedValueOnce(ok([]));

    const res = await appFor(db).request("/api/v1/w/w/notifications", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repos/owner/repo/notifications");
    expect(url.searchParams.get("status-types")).toBe("unread");
    expect(url.searchParams.get("subject-type")).toBe("Issue,Pull");
  });
});
