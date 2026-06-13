import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Forgejo } from "../forgejo.js";
import { SSEHub, type SSEEvent } from "../sse.js";
import type { AppEnv } from "../types.js";
import { webhooks } from "./webhooks.js";
import { freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("webhook", { forgejoToken: "token" });

function freshDb(): Database.Database {
  const db = freshTestDb("cosheaf-webhook-");
  seedTestWorkspace(db);
  return db;
}

// Add the two repo-existence checks the webhook handler now makes (#62):
// fj.getRepo to confirm the repo exists, fj.listRepoTopics to read the
// format. Tests that only mock getRawFile etc. get these for free. The
// default getRepo echoes the requested (owner, repo) — any owner "exists";
// the unknown-repo test overrides it to return null.
function withRepoDefaults(forgejo: Forgejo): Forgejo {
  const f = forgejo as unknown as Record<string, unknown>;
  if (typeof f.getRepo !== "function") {
    f.getRepo = vi.fn(async (owner: string, repo: string) => ({ id: 1, full_name: `${owner}/${repo}` }));
  }
  if (typeof f.listRepoTopics !== "function") {
    f.listRepoTopics = vi.fn(async () => [] as string[]);
  }
  return forgejo;
}

function appFor(db: Database.Database, forgejo: Forgejo): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/api/v1/webhooks", webhooks), withRepoDefaults(forgejo));
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
      repository: { full_name: "owner/w" },
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
      repository: { full_name: "owner/w" },
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
      repository: { full_name: "owner/w" },
      pull_request: { number: 12 },
    });
    const res = await app.request("/api/v1/webhooks/forgejo", signedForgejo(body, "pull_request", "pr-1"));
    expect(res.status).toBe(200);
  });

  it("publishes pull_reviewed / pull_commented on the granular review events Forgejo actually delivers", async () => {
    // Forgejo's review webhook headers are pull_request_approved /
    // pull_request_rejected / pull_request_comment (not pull_request_review),
    // with the review under `review.type`. Capture the SSE to assert it.
    const db = freshDb();
    const hub = new SSEHub();
    const events: SSEEvent[] = [];
    hub.subscribe("owner/w", (e) => events.push(e));
    const app = testApp(
      db,
      config,
      (a) => {
        a.use("*", (c, next) => {
          c.set("sse", hub);
          return next();
        });
        a.route("/api/v1/webhooks", webhooks);
      },
      withRepoDefaults({} as Forgejo),
    );
    const fire = (event: string, payload: object, delivery: string) =>
      app.request("/api/v1/webhooks/forgejo", signedForgejo(JSON.stringify({ repository: { full_name: "owner/w" }, ...payload }), event, delivery));

    expect((await fire("pull_request_approved", { pull_request: { number: 13 }, review: { type: "pull_request_review_approved" } }, "rev-1")).status).toBe(200);
    expect((await fire("pull_request_rejected", { pull_request: { number: 13 }, review: { type: "pull_request_review_rejected" } }, "rev-2")).status).toBe(200);
    expect((await fire("pull_request_comment", { pull_request: { number: 13 }, review: { type: "pull_request_review_comment" } }, "rev-3")).status).toBe(200);

    expect(events).toEqual([
      { type: "pull_reviewed", number: 13, state: "APPROVED" },
      { type: "pull_reviewed", number: 13, state: "REQUEST_CHANGES" },
      { type: "pull_commented", number: 13 },
    ]);
  });

  it("reconciles the same repo name under a different owner into that owner's workspace", async () => {
    const db = freshDb();
    const forgejo = {
      getRawFile: vi.fn(async () => "---\nid: foo-1\n---\n# Foo\n"),
    } as unknown as Forgejo;
    const app = appFor(db, forgejo);
    // Repo name "w" exists under both owners; "someone-else/w" is its own
    // workspace, keyed by the full owner/repo slug.
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "someone-else/w" },
      commits: [{ added: ["foo.md"] }],
    });
    const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "other-owner-1"));
    expect(res.status).toBe(200);
    const slugs = (db.prepare("SELECT workspace_slug FROM doc_map").all() as Array<{ workspace_slug: string }>)
      .map((r) => r.workspace_slug);
    expect(slugs).toEqual(["someone-else/w"]);
  });

  it("acks and ignores deliveries for repos that don't exist on Forgejo", async () => {
    const db = freshDb();
    const forgejo = {
      getRepo: vi.fn(async () => null),
      getRawFile: vi.fn(async () => "# Never\n"),
    } as unknown as Forgejo;
    const app = appFor(db, forgejo);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "ghost/nowhere" },
      commits: [{ added: ["foo.md"] }],
    });
    const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "unknown-repo-1"));
    // Acked (200) so Forgejo doesn't retry, dedupe row written, no work done.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: "unknown_repo" });
    expect(db.prepare("SELECT count(*) AS c FROM webhook_log").get()).toEqual({ c: 1 });
    expect(vi.mocked(forgejo.getRawFile)).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS c FROM doc_map").get()).toEqual({ c: 0 });
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
        repository: { full_name: "owner/w" },
        commits: [{ added: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
      expect(res.status).toBe(200);
      const row = db.prepare(
        "SELECT cosheaf_id, forgejo_id, title FROM doc_map WHERE workspace_slug = 'owner/w'",
      ).get();
      expect(row).toMatchObject({ cosheaf_id: "foo-1", forgejo_id: "foo.md", title: "Foo" });
    });

    it("UPDATE: a push that modifies foo.md updates the existing row", async () => {
      const db = freshDb();
      const fj = mockedForgejo({ "foo.md": "---\nid: foo-1\n---\n# Foo v2\n" });
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", "owner/w", "foo.md", "Foo", Date.now());
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/w" },
        commits: [{ modified: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "update-1"));
      expect(res.status).toBe(200);
      expect(db.prepare("SELECT title FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({
        title: "Foo v2",
      });
    });

    it("DELETE: a push that removes foo.md drops the doc_map row and emits SSE remove", async () => {
      const db = freshDb();
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", "owner/w", "foo.md", "Foo", Date.now());
      const app = appFor(db, {} as Forgejo);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/w" },
        commits: [{ removed: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "delete-1"));
      expect(res.status).toBe(200);
      expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    });

    it("RENAME (Forgejo's removed+added): old row goes, new row comes in", async () => {
      const db = freshDb();
      const fj = mockedForgejo({ "new.md": "---\nid: foo-1\n---\n# Foo\n" });
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("foo-1", "owner/w", "old.md", "Foo", Date.now());
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        repository: { full_name: "owner/w" },
        commits: [{ added: ["new.md"], removed: ["old.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "rename-1"));
      expect(res.status).toBe(200);
      const rows = db.prepare(
        "SELECT forgejo_id FROM doc_map WHERE workspace_slug = 'owner/w'",
      ).all() as Array<{ forgejo_id: string }>;
      expect(rows.map((r) => r.forgejo_id)).toEqual(["new.md"]);
    });

    it("ignores pushes to non-main refs", async () => {
      const db = freshDb();
      const fj = mockedForgejo({});
      const app = appFor(db, fj);
      const body = JSON.stringify({
        ref: "refs/heads/feature/wip",
        repository: { full_name: "owner/w" },
        commits: [{ added: ["foo.md"] }],
      });
      const res = await app.request("/api/v1/webhooks/forgejo", signedPush(body, "non-main-1"));
      expect(res.status).toBe(200);
      // Did not reach Forgejo for the file body (main-only).
      expect(vi.mocked(fj.getRawFile)).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    });
  });

  it("removes sidecar rows on repository=deleted webhook", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    // Plant a row in each derived table so the cleanup is observable.
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("abc", "owner/w", "page.md", "Page", Date.now());
    db.prepare(
      "INSERT INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("owner/w", "abc", "page.md", null, "external", 1);
    db.prepare("INSERT INTO page_tags (workspace_slug, cosheaf_id, tag) VALUES (?, ?, ?)").run("owner/w", "abc", "wip");

    const body = JSON.stringify({
      action: "deleted",
      repository: { full_name: "owner/w" },
    });
    const res = await app.request(
      "/api/v1/webhooks/forgejo",
      signedForgejo(body, "repository", "del-1"),
    );
    expect(res.status).toBe(200);
    // No workspaces table anymore (#62) — the sidecar tables are the
    // only thing the repository=deleted handler touches.
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM backlinks WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM page_tags WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
  });

  it("rejects deliveries that arrive with only x-gitea-* headers", async () => {
    const db = freshDb();
    const app = appFor(db, {} as Forgejo);
    const body = JSON.stringify({
      action: "opened",
      repository: { full_name: "owner/w" },
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
