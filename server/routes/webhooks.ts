// Forgejo webhook receiver. Verifies HMAC, dedupes by delivery id, updates the
// sidecar (FTS, backlinks, doc_map), and fans out to SSE.

import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../types.js";
import { deletePage, indexPage } from "../indexer.js";
import { deleteSidecarForWorkspace } from "../workspace-cleanup.js";
import { isDocumentFormatId } from "../../shared/document-format.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { ForgejoIssue } from "../forgejo.js";
import { bad, unauthorized } from "./responses.js";

export const webhooks = new Hono<AppEnv>();

interface WorkspaceRow { id: number; slug: string; default_md_format: string }

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

// Match the webhook's repo identity against owner + name, not name alone.
// Cosheaf binds every workspace to a repo under `config.forgejoOwner`; a
// webhook payload whose repo lives under a different owner is unrelated
// (could be a misconfigured webhook target on another instance) and must
// not match an arbitrary same-named workspace.
function workspaceForRepo(
  db: import("better-sqlite3").Database,
  repoFullName: string,
  expectedOwner: string,
): WorkspaceRow | null {
  const slashIdx = repoFullName.indexOf("/");
  if (slashIdx < 0) return null;
  const owner = repoFullName.slice(0, slashIdx);
  const name = repoFullName.slice(slashIdx + 1);
  if (owner !== expectedOwner) return null;
  return (
    (db
      .prepare(
        "SELECT id, slug, default_md_format FROM workspaces WHERE slug = ?",
      )
      .get(name) as WorkspaceRow | undefined) ?? null
  );
}

webhooks.post("/forgejo", async (c) => {
  const config = c.get("config");
  const raw = await c.req.text();
  // Forgejo-only. Gitea is not a supported target, so we no longer accept
  // x-gitea-* header aliases (they were a transitional compatibility).
  const rawSignature = c.req.header("x-forgejo-signature") ?? "";
  // Strip optional "sha256=" prefix used by Forgejo webhook signatures.
  const signature = rawSignature.replace(/^sha256=/, "");
  if (!signature || !/^[0-9a-fA-F]+$/.test(signature)) {
    return c.json(...unauthorized("missing or malformed signature"));
  }
  const expected = createHmac("sha256", config.webhookSecret).update(raw).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json(...unauthorized("bad signature"));
  }
  const event = c.req.header("x-forgejo-event") ?? "unknown";
  const deliveryHeader = c.req.header("x-forgejo-delivery");
  const deliveryId = deliveryHeader ?? `body:${createHash("sha256").update(raw).digest("hex")}`;

  const db = c.get("db");
  const exists = db.prepare("SELECT 1 FROM webhook_log WHERE delivery_id = ?").get(deliveryId) as unknown;
  if (exists) return c.json({ ok: true, dedup: true });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (_err) {
    return c.json(...bad("bad json"));
  }
  const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";
  const ws = workspaceForRepo(db, repoFullName, config.forgejoOwner);
  if (!ws) {
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
    return c.json({ ok: true, ignored: "unknown_repo" });
  }

  const fj = c.get("fjAdmin");
  const owner = config.forgejoOwner;
  const sse = c.get("sse");

  let deduped = false;
  await serializeWorkspace(ws.id, async () => {
    // Claim the delivery id first. Any later failure leaves the dedupe row in
    // place so Forgejo's webhook retry doesn't stampede us — at-most-once
    // beats a retry storm that re-runs the side effects. Per-path failures
    // below are logged but do not propagate.
    const claim = db
      .prepare(
        "INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)",
      )
      .run(deliveryId, Date.now(), event);
    if (claim.changes === 0) {
      deduped = true;
      return;
    }
    // #55: catch unexpected errors so they don't surface as 500 (which would
    // make Forgejo retry; the retry would then hit the dedupe row and silently
    // succeed, permanently losing the event). Treat as handled — operator can
    // rerun `pnpm cli workspace reindex` if reconciliation drifted.
    try {
    if (event === "push") {
      const ref = payload.ref as string | undefined;
      // Any push moves at least one ref — drop the repo's cached trees so the
      // next /tree fetch re-pulls from Forgejo. Cheaper than diffing refs.
      invalidateRepoTrees(owner, ws.slug);
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
        const mdPaths = [...touched].filter((p) => p.endsWith(".md"));
        // Parallel fetch — each Forgejo getRawFile is independent and the
        // indexPage write is local; sequential blew up the tail when a
        // push touched many notes.
        const results = await Promise.all(
          mdPaths.map((path) =>
            fj.getRawFile(owner, ws.slug, "main", path).then(
              (body) => ({ path, body, error: null as string | null }),
              (err: unknown) => ({ path, body: "", error: (err as Error).message }),
            ),
          ),
        );
        const failures: string[] = [];
        for (const r of results) {
          if (r.error) {
            failures.push(`${r.path}: ${r.error}`);
            continue;
          }
          indexPage(db, {
            workspaceId: ws.id,
            filePath: r.path,
            bodyText: r.body,
            formatId: isDocumentFormatId(ws.default_md_format) ? ws.default_md_format : undefined,
          });
        }
        if (failures.length > 0) {
          // Don't throw — that would unwind the dedupe row and provoke a Forgejo
          // retry storm. Log; an operator can rerun `pnpm cli workspace reindex`.
          console.warn(`webhook reindex partial failure (delivery=${deliveryId}): ${failures.join("; ")}`);
        }
        // Per-path events let the frontend reload only the open file when needed.
        for (const path of touched) sse.publish(ws.slug, { type: "change", path });
        for (const path of removed) sse.publish(ws.slug, { type: "remove", path });
      }
    } else if (event === "pull_request") {
      // PR state lives on Forgejo; we only ping clients to refetch.
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (pr) {
        const number = pr.number as number;
        const action = String(payload.action ?? "");
        sse.publish(ws.slug, { type: "pull", number, action });
      }
    } else if (event === "pull_request_review") {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const review = payload.review as Record<string, unknown> | undefined;
      const number = typeof pr?.number === "number" ? pr.number : Number(pr?.number);
      const state = String(review?.state ?? "");
      if (Number.isFinite(number) && state) {
        sse.publish(ws.slug, { type: "pull_reviewed", number, state });
      }
    } else if (event === "issues") {
      const issue = payload.issue as ForgejoIssue | undefined;
      const action = String(payload.action ?? "");
      if (issue && !issue.pull_request) {
        sse.publish(ws.slug, { type: "issue", number: issue.number, action });
      }
    } else if (event === "issue_comment") {
      const issue = payload.issue as ForgejoIssue | undefined;
      if (issue && !issue.pull_request) {
        sse.publish(ws.slug, {
          type: "issue_comment",
          number: issue.number,
          action: String(payload.action ?? ""),
        });
      }
    } else if (event === "repository") {
      // The repo this workspace is bound to was deleted on Forgejo (admin
      // UI / tea / API). Wipe the sidecar rows so cosheaf stops surfacing
      // a ghost workspace. The Forgejo side is already gone; there's
      // nothing to roll back.
      if (String(payload.action ?? "") === "deleted") {
        deleteSidecarForWorkspace(db, ws.id);
        sse.publish(ws.slug, { type: "workspace_deleted" });
      }
    }
    } catch (err) {
      console.warn(
        `webhook handler error (delivery=${deliveryId}, event=${event}): ${(err as Error).message}`,
      );
    }
  });
  if (deduped) return c.json({ ok: true, dedup: true });
  return c.json({ ok: true });
});
