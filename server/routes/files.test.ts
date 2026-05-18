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
import { files, safeRel } from "./files.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { freshTestDb, seedTestWorkspace } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-files-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-files-");
  seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
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

describe("safeRel repo-path validator", () => {
  // Imported via the route module's export so all consumers share one
  // implementation (#22). Each accept/reject case exercises a documented
  // rule from the helper's comment.
  it("accepts safe nested paths", () => {
    for (const p of ["a.md", "docs/intro.md", "deep/nested/x.md", "assets/img.png"]) {
      expect(safeRel(p)).toBe(p);
    }
  });
  it("rejects empty / undefined", () => {
    expect(safeRel(undefined)).toBeNull();
    expect(safeRel("")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(safeRel("/etc/passwd")).toBeNull();
    expect(safeRel("\\windows\\path")).toBeNull();
  });
  it("rejects traversal segments", () => {
    expect(safeRel("..")).toBeNull();
    expect(safeRel("../etc/passwd")).toBeNull();
    expect(safeRel("docs/../escape")).toBeNull();
    expect(safeRel("docs/./loop")).toBe("docs/./loop"); // "." segment is allowed; ".." is the only blocked literal
  });
  it("rejects encoded traversal forms", () => {
    expect(safeRel("docs/%2e%2e/escape")).toBeNull();
    expect(safeRel("docs/%2E%2E/escape")).toBeNull();
    expect(safeRel("docs%2fescape")).toBeNull();
  });
  it("rejects backslashes (Forgejo treats / as the only separator)", () => {
    expect(safeRel("docs\\intro.md")).toBeNull();
  });
  it("rejects control characters", () => {
    expect(safeRel("docs/intro\x00.md")).toBeNull();
    expect(safeRel("docs/\nintro.md")).toBeNull();
  });
  it("rejects empty segments", () => {
    expect(safeRel("docs//intro.md")).toBeNull();
    expect(safeRel("docs/")).toBeNull();
  });
});

describe("files validation route", () => {
  it("reports broken references with source lines and orphan page ids", async () => {
    const db = freshDb();
    const token = seedAuthUser(db, config, { id: 1, username: "alice", role: "write" });
    indexPage(db, {
      workspaceSlug: "w",
      filePath: "source.md",
      bodyText: "---\nid: source\n---\n# Source\n\nSee [@target], [@missing], and [Gone](gone.md).\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "w",
      filePath: "target.md",
      bodyText: "---\nid: target\n---\n# Target\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "w",
      filePath: "orphan.md",
      bodyText: "---\nid: orphan\n---\n# Orphan\n",
      formatId: COFLAT_FORMAT_ID,
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
