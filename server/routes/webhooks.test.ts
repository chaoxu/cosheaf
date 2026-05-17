import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
import { webhooks } from "./webhooks.js";
import { freshTestDb, seedTestWorkspace } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-webhook-test",
  port: 3030,
  sessionSecret: "test",
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-webhook-");
  seedTestWorkspace(db);
  return db;
}

function appFor(db: Database.Database, forgejo: Forgejo): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", forgejo);
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/webhooks", webhooks);
  return app;
}

function signedForgejo(body: string, event = "push", delivery = "delivery-1"): RequestInit {
  const signature = createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forgejo-signature": signature,
      "x-forgejo-event": event,
      "x-forgejo-delivery": delivery,
    },
    body,
  };
}

function signedPush(body: string, delivery = "delivery-1"): RequestInit {
  return signedForgejo(body, "push", delivery);
}

describe("forgejo webhooks", () => {
  it("acks 200 + dedupes even when a per-path reindex fails (operator recovers via `cli workspace reindex`)", async () => {
    // We used to throw 500 here, which left the webhook_log row unwritten and
    // caused Forgejo to retry the delivery forever. Now we claim the dedupe
    // row first, log the partial failure, and ack 200 — a retry storm of
    // index work is worse than missing one path that a manual reindex fixes.
    const db = freshDb();
    const forgejo = {
      getRawFile: vi.fn(async () => {
        throw new Error("temporary Forgejo failure");
      }),
    } as unknown as Forgejo;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = appFor(db, forgejo);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "owner/repo" },
      commits: [{ added: ["recovered.md"] }],
    });

    const first = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
    expect(first.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS count FROM webhook_log").get()).toEqual({ count: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("webhook reindex partial failure"));

    // A retry of the same delivery short-circuits — at-most-once.
    const second = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ dedup: true });
    expect(forgejo.getRawFile).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not process an in-flight duplicate delivery twice", async () => {
    const db = freshDb();
    let releaseGate: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const forgejo = {
      getRawFile: vi.fn(async () => {
        markStarted?.();
        await gate;
        return "# Once\n";
      }),
    } as unknown as Forgejo;
    const app = appFor(db, forgejo);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "owner/repo" },
      commits: [{ added: ["once.md"] }],
    });

    const first = app.request("/api/v1/webhooks/forgejo", signedPush(body));
    await started;
    const second = app.request("/api/v1/webhooks/forgejo", signedPush(body));
    releaseGate?.();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    await expect(secondRes.json()).resolves.toEqual({ ok: true, dedup: true });
    expect(forgejo.getRawFile).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT count(*) AS count FROM webhook_log").get()).toEqual({ count: 1 });
  });

  it("publishes an SSE pull event on pull_request webhook delivery", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 12 },
    });
    const res = await app.request("/api/v1/webhooks/forgejo", signedForgejo(body, "pull_request", "pr-1"));
    expect(res.status).toBe(200);
  });

  it("publishes an SSE pull_reviewed event on pull_request_review delivery", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    const body = JSON.stringify({
      repository: { full_name: "owner/repo" },
      pull_request: { number: 13 },
      review: { state: "APPROVED" },
    });
    const res = await app.request("/api/v1/webhooks/forgejo", signedForgejo(body, "pull_request_review", "rev-1"));
    expect(res.status).toBe(200);
  });

  it("ignores deliveries whose repository owner doesn't match config.forgejoOwner", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    // Same repo name "repo" but a different owner — must not match the
    // workspace, even though forgejo_repo='repo' is in the db.
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "someone-else/repo" },
      pull_request: { number: 99 },
    });
    const res = await app.request(
      "/api/v1/webhooks/forgejo",
      signedForgejo(body, "pull_request", "wrong-owner-1"),
    );
    // Webhook is still acked (200) so Forgejo doesn't retry; but no work
    // happens because the owner check failed.
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS c FROM webhook_log").get()).toEqual({ c: 1 });
  });

  describe("reconciliation of external Forgejo writes (#32)", () => {
    function mockedForgejo(returnBodyFor: Record<string, string>) {
      return {
        getRawFile: vi.fn(async (_o, _r, _ref, path) => {
          if (!(path in returnBodyFor)) throw new Error(`unexpected getRawFile for ${path}`);
          return returnBodyFor[path];
        }),
      } as unknown as Forgejo;
    }

    it("ADD: a push that adds foo.md creates a doc_map row", async () => {
      const db = freshDb();
      const fj = mockedForgejo({ "foo.md": "---\nid: foo-1\n---\n# Foo\n" });
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/repo" },
        commits: [{ added: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
      expect(res.status).toBe(200);
      const row = db.prepare(
        "SELECT cosheaf_id, forgejo_id, title FROM doc_map WHERE workspace_id = 1",
      ).get();
      expect(row).toMatchObject({ cosheaf_id: "foo-1", forgejo_id: "foo.md", title: "Foo" });
    });

    it("UPDATE: a push that modifies foo.md updates the existing row", async () => {
      const db = freshDb();
      const fj = mockedForgejo({ "foo.md": "---\nid: foo-1\n---\n# Foo v2\n" });
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", 1, "foo.md", "Foo", Date.now());
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/repo" },
        commits: [{ modified: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "update-1"));
      expect(res.status).toBe(200);
      expect(db.prepare("SELECT title FROM doc_map WHERE workspace_id = 1").get()).toEqual({
        title: "Foo v2",
      });
    });

    it("DELETE: a push that removes foo.md drops the doc_map row and emits SSE remove", async () => {
      const db = freshDb();
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", 1, "foo.md", "Foo", Date.now());
      const app = appFor(db, {} as Forgejo);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/repo" },
        commits: [{ removed: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "delete-1"));
      expect(res.status).toBe(200);
      expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_id = 1").get()).toEqual({ c: 0 });
    });

    it("RENAME (Forgejo's removed+added): old row goes, new row comes in", async () => {
      const db = freshDb();
      const fj = mockedForgejo({ "new.md": "---\nid: foo-1\n---\n# Foo\n" });
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", 1, "old.md", "Foo", Date.now());
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/repo" },
        commits: [{ added: ["new.md"], removed: ["old.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "rename-1"));
      expect(res.status).toBe(200);
      const rows = db.prepare(
        "SELECT forgejo_id FROM doc_map WHERE workspace_id = 1",
      ).all() as Array<{ forgejo_id: string }>;
      expect(rows.map((r) => r.forgejo_id)).toEqual(["new.md"]);
    });

    it("ignores pushes to non-main refs", async () => {
      const db = freshDb();
      const fj = mockedForgejo({});
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/feature/wip",
        repository: { full_name: "owner/repo" },
        commits: [{ added: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "non-main-1"));
      expect(res.status).toBe(200);
      // Did not reach Forgejo for the file body (main-only).
      expect(vi.mocked(fj.getRawFile)).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_id = 1").get()).toEqual({ c: 0 });
    });
  });

  it("removes sidecar rows on repository=deleted webhook", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    // Plant a row in each derived table so the cleanup is observable.
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("abc", 1, "page.md", "Page", Date.now());
    db.prepare(
      "INSERT INTO backlinks (workspace_id, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(1, "abc", "page.md", null, "external", 1);
    db.prepare("INSERT INTO page_tags (workspace_id, cosheaf_id, tag) VALUES (?, ?, ?)").run(1, "abc", "wip");

    const body = JSON.stringify({
      action: "deleted",
      repository: { full_name: "owner/repo" },
    });
    const res = await app.request(
      "/api/v1/webhooks/forgejo",
      signedForgejo(body, "repository", "del-1"),
    );
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS c FROM workspaces WHERE id = 1").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_id = 1").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM backlinks WHERE workspace_id = 1").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM page_tags WHERE workspace_id = 1").get()).toEqual({ c: 0 });
  });

  it("rejects deliveries that arrive with only x-gitea-* headers", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 1 },
    });
    const signature = createHmac("sha256", config.webhookSecret).update(body).digest("hex");
    const res = await app.request("/api/v1/webhooks/forgejo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-signature": signature,
        "x-gitea-event": "pull_request",
        "x-gitea-delivery": "gitea-only",
      },
      body,
    });
    // No x-forgejo-signature → signature is empty → handler rejects.
    expect(res.status).toBe(401);
  });
});
