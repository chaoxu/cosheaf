import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import type { Forgejo } from "../forgejo.js";
import { SSEHub } from "../sse.js";
import type { AppEnv } from "../types.js";
import { webhooks } from "./webhooks.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-webhook-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  db.prepare("INSERT INTO workspaces (id, slug, name, forgejo_repo, created_at) VALUES (1, 'w', 'W', 'repo', 0)").run();
  return db;
}

function appFor(db: Database.Database, forgejo: Forgejo): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("forgejo", forgejo);
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/webhooks", webhooks);
  return app;
}

function signedPush(body: string, delivery = "delivery-1"): RequestInit {
  const signature = createHmac("sha256", config.webhookSecret).update(body).digest("hex");
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forgejo-signature": signature,
      "x-forgejo-event": "push",
      "x-forgejo-delivery": delivery,
    },
    body,
  };
}

describe("forgejo webhooks", () => {
  it("does not dedupe a delivery whose reindex failed", async () => {
    const db = freshDb();
    let attempts = 0;
    const forgejo = {
      getRawFile: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary Forgejo failure");
        return "# Recovered\n";
      }),
    } as unknown as Forgejo;
    const app = appFor(db, forgejo);
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "owner/repo" },
      commits: [{ added: ["recovered.md"] }],
    });

    const first = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
    expect(first.status).toBe(500);
    expect(db.prepare("SELECT count(*) AS count FROM webhook_log").get()).toEqual({ count: 0 });

    const second = await app.request("/api/v1/webhooks/forgejo", signedPush(body));
    expect(second.status).toBe(200);
    expect(db.prepare("SELECT count(*) AS count FROM webhook_log").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT path FROM notes_fts WHERE workspace_id = 1").get()).toEqual({ path: "recovered.md" });
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
});
