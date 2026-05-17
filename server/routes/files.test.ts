import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import { indexPage } from "../indexer.js";
import { _resetBearerAuthCacheForTests, _resetPermCacheForTests } from "../middleware.js";
import { SSEHub } from "../sse.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { files } from "./files.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-files-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-files-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  db.prepare(
    "INSERT INTO workspaces (id, slug, name, forgejo_repo, default_md_format, created_at) VALUES (1, 'w', 'W', 'repo', ?, 0)",
  ).run(COFLAT_FORMAT_ID);
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
  app.route("/api/v1/w", files);
  return app;
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

describe("files validation route", () => {
  it("reports broken references with source lines and orphan page ids", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceId: 1,
      filePath: "source.md",
      bodyText: "---\nid: source\n---\n# Source\n\nSee [@target], [@missing], and [Gone](gone.md).\n",
    });
    indexPage(db, {
      workspaceId: 1,
      filePath: "target.md",
      bodyText: "---\nid: target\n---\n# Target\n",
    });
    indexPage(db, {
      workspaceId: 1,
      filePath: "orphan.md",
      bodyText: "---\nid: orphan\n---\n# Orphan\n",
    });

    const res = await appFor(db).request("/api/v1/w/w/validation", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      broken_refs: [
        {
          source_id: "source",
          source_path: "source.md",
          source_title: "Source",
          target_id: "missing",
          target_label: "[@missing]",
          line: 6,
        },
        {
          source_id: "source",
          source_path: "source.md",
          source_title: "Source",
          target_id: null,
          target_label: "[Gone](gone.md)",
          line: 6,
        },
      ],
      orphan_labels: [
        { id: "orphan", path: "orphan.md", title: "Orphan" },
        { id: "source", path: "source.md", title: "Source" },
      ],
    });
  });
});

describe("files mutation gates", () => {
  it("rejects read-only users before forwarding file writes to Forgejo", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "read" });

    const res = await appFor(db).request("/api/v1/w/w/file?path=notes.md&branch=user/alice/wip", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "# Notes\n" }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "write access required", code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
