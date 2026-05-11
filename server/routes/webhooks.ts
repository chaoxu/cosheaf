// Forgejo webhook receiver. Verifies HMAC, dedupes by delivery id, updates the
// sidecar (FTS, backlinks, doc_map), and fans out to SSE.

import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../types.js";
import { deletePage, indexPage } from "../indexer.js";
import { syncChangeFromPr, syncChangeFromReview } from "./changes.js";

export const webhooks = new Hono<AppEnv>();

interface WorkspaceRow { id: number; slug: string; forgejo_repo: string }

const workspaceQueues = new Map<number, Promise<void>>();

async function serializeWorkspace<T>(workspaceId: number, work: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(workspaceId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const current = run.then(() => undefined, () => undefined);
  workspaceQueues.set(workspaceId, current);
  try {
    return await run;
  } finally {
    if (workspaceQueues.get(workspaceId) === current) workspaceQueues.delete(workspaceId);
  }
}

function workspaceForRepo(db: import("better-sqlite3").Database, repoFullName: string): WorkspaceRow | null {
  const slashIdx = repoFullName.indexOf("/");
  const name = slashIdx >= 0 ? repoFullName.slice(slashIdx + 1) : repoFullName;
  return (
    (db
      .prepare(
        "SELECT id, slug, forgejo_repo FROM workspaces WHERE forgejo_repo = ?",
      )
      .get(name) as WorkspaceRow | undefined) ?? null
  );
}

webhooks.post("/forgejo", async (c) => {
  const config = c.get("config");
  const raw = await c.req.text();
  const rawSignature = c.req.header("x-forgejo-signature") ?? c.req.header("x-gitea-signature") ?? "";
  // Strip optional "sha256=" prefix some Gitea versions include.
  const signature = rawSignature.replace(/^sha256=/, "");
  if (!signature || !/^[0-9a-fA-F]+$/.test(signature)) {
    return c.json({ error: "missing or malformed signature", code: "unauthorized" }, 401);
  }
  const expected = createHmac("sha256", config.webhookSecret).update(raw).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "bad signature", code: "unauthorized" }, 401);
  }
  const event = c.req.header("x-forgejo-event") ?? c.req.header("x-gitea-event") ?? "unknown";
  const deliveryHeader = c.req.header("x-forgejo-delivery") ?? c.req.header("x-gitea-delivery");
  const deliveryId = deliveryHeader ?? `body:${createHash("sha256").update(raw).digest("hex")}`;

  const db = c.get("db");
  const exists = db.prepare("SELECT 1 FROM webhook_log WHERE delivery_id = ?").get(deliveryId) as unknown;
  if (exists) return c.json({ ok: true, dedup: true });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (_err) {
    return c.json({ error: "bad json", code: "validation" }, 400);
  }
  const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";
  const ws = workspaceForRepo(db, repoFullName);
  if (!ws) {
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
    return c.json({ ok: true, ignored: "unknown_repo" });
  }

  const fj = c.get("forgejo");
  const owner = config.forgejoOwner;
  const sse = c.get("sse");

  let deduped = false;
  await serializeWorkspace(ws.id, async () => {
    const alreadyLogged = db.prepare("SELECT 1 FROM webhook_log WHERE delivery_id = ?").get(deliveryId) as unknown;
    if (alreadyLogged) {
      deduped = true;
      return;
    }
    if (event === "push") {
      const ref = payload.ref as string | undefined;
      if (ref === "refs/heads/main") {
        const commits = (payload.commits ?? []) as Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
        const touched = new Set<string>();
        const removed = new Set<string>();
        for (const cm of commits) {
          for (const f of cm.added ?? []) touched.add(f);
          for (const f of cm.modified ?? []) touched.add(f);
          for (const f of cm.removed ?? []) removed.add(f);
        }
        for (const path of removed) {
          if (path.endsWith(".md")) deletePage(db, ws.id, path);
        }
        const failures: string[] = [];
        for (const path of touched) {
          if (!path.endsWith(".md")) continue;
          try {
            const body = await fj.getRawFile(owner, ws.forgejo_repo, "main", path);
            indexPage(db, { workspaceId: ws.id, filePath: path, bodyText: body });
          } catch (err) {
            failures.push(`${path}: ${(err as Error).message}`);
          }
        }
        if (failures.length > 0) {
          throw new Error(`reindex failed: ${failures.join("; ")}`);
        }
        // Per-path events let the frontend reload only the open file when needed.
        for (const path of touched) sse.publish(ws.slug, { type: "change", path });
        for (const path of removed) sse.publish(ws.slug, { type: "remove", path });
      }
    } else if (event === "pull_request") {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (pr) {
        const number = pr.number as number;
        const merged = !!pr.merged;
        const state = pr.state as "open" | "closed";
        syncChangeFromPr(db, ws.id, number, state, merged);
        sse.publish(ws.slug, { type: "queue" });
      }
    } else if (event === "pull_request_review") {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const review = payload.review as Record<string, unknown> | undefined;
      const number = typeof pr?.number === "number" ? pr.number : Number(pr?.number);
      const state = String(review?.state ?? "");
      if (Number.isFinite(number) && state) {
        const synced = await syncChangeFromReview(db, ws.id, fj, owner, ws.forgejo_repo, number, state);
        if (synced?.state === "changes_requested") {
          sse.publish(ws.slug, { type: "change_changes_requested", id: synced.id });
        } else if (synced?.state === "merged") {
          sse.publish(ws.slug, { type: "change_merged", id: synced.id });
        } else if (state === "APPROVED" && synced) {
          sse.publish(ws.slug, { type: "change_approved", id: synced.id });
        } else if (state === "COMMENT" && synced) {
          sse.publish(ws.slug, { type: "change_commented", id: synced.id });
        }
      }
      sse.publish(ws.slug, { type: "queue" });
    }
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
  });
  if (deduped) return c.json({ ok: true, dedup: true });
  // issues/comments are not surfaced to the UI yet — drop them.

  return c.json({ ok: true });
});
