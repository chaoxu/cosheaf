// Forgejo webhook receiver. Verifies HMAC, dedupes by delivery id, updates the
// sidecar (FTS, backlinks, doc_map), and fans out to SSE.

import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../types.js";
import { deletePage, indexPage } from "../indexer.js";
import { REPO_CONFIG_PATH, bustRepoConfig } from "../repo-config.js";
import { deleteSidecarForWorkspace } from "../workspace-cleanup.js";
import { notificationChannel, parseWorkspaceSlug, workspaceSlug } from "../../shared/conventions.js";
import { documentFormatFromTopics } from "../../shared/document-format.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { ForgejoIssue } from "../forgejo.js";
import { bad, unauthorized } from "./responses.js";

export const webhooks = new Hono<AppEnv>();

// Forgejo event headers that can generate a per-user notification. After
// reconciling one, the handler fans out an inbox-refetch hint to the repo's
// collaborators (see #116). Push/repository events don't notify.
const NOTIFY_EVENTS = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_approved",
  "pull_request_rejected",
  "pull_request_review",
  "pull_request_comment",
]);

const workspaceQueues = new Map<string, Promise<void>>();

async function serializeWorkspace<T>(slug: string, work: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(slug) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const current = run.then(() => undefined, () => undefined);
  workspaceQueues.set(slug, current);
  try {
    return await run;
  } finally {
    if (workspaceQueues.get(slug) === current) workspaceQueues.delete(slug);
  }
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
  // Webhook identity is the Forgejo `owner/repo` full name — the same string
  // the sidecar and SSE channels key off. Any owner is a valid tenant.
  const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "";
  const parsed = parseWorkspaceSlug(repoFullName);
  if (!parsed) {
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
    return c.json({ ok: true, ignored: "unknown_repo" });
  }
  const { owner, repo: repoName } = parsed;

  const fj = c.get("fjAdmin");
  const sse = c.get("sse");

  // The repo must exist on our Forgejo; otherwise it's a webhook from a
  // foreign target. Topics are only needed for push (to drive indexer
  // format selection); fetch them in parallel with the existence check
  // when we'll use them, otherwise skip the round-trip.
  const needsFormat = event === "push";
  const [repo, formatId] = await Promise.all([
    fj.getRepo(owner, repoName),
    needsFormat ? fj.listRepoTopics(owner, repoName).then(documentFormatFromTopics) : Promise.resolve(undefined),
  ]);
  if (!repo) {
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
    return c.json({ ok: true, ignored: "unknown_repo" });
  }
  const ws = { slug: workspaceSlug(owner, repoName), defaultMdFormat: formatId };

  let deduped = false;
  await serializeWorkspace(ws.slug, async () => {
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
      invalidateRepoTrees(owner, repoName);
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
          if (path.endsWith(".md")) deletePage(db, ws.slug, path);
        }
        // #182: a cosheaf.yaml change busts the cached repo config for main; the
        // next render reloads + re-caches it from the authoritative file.
        if (touched.has(REPO_CONFIG_PATH) || removed.has(REPO_CONFIG_PATH)) {
          bustRepoConfig(db, ws.slug, "main");
        }
        const mdPaths = [...touched].filter((p) => p.endsWith(".md"));
        // Parallel fetch — each Forgejo getRawFile is independent and the
        // indexPage write is local; sequential blew up the tail when a
        // push touched many notes.
        const results = await Promise.all(
          mdPaths.map((path) =>
            fj.getRawFile(owner, repoName, "main", path).then(
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
            workspaceSlug: ws.slug,
            filePath: r.path,
            bodyText: r.body,
            formatId: ws.defaultMdFormat,
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
    } else if (
      event === "pull_request_approved" ||
      event === "pull_request_rejected" ||
      event === "pull_request_review"
    ) {
      // Forgejo delivers review state changes under the granular header names
      // `pull_request_approved` / `pull_request_rejected` — the high-level
      // `pull_request_review` header is documented but not actually sent, and
      // the payload carries `review.type`, not `review.state`. Map all of them
      // to the pull_reviewed SSE so open PR views can refetch.
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const review = payload.review as Record<string, unknown> | undefined;
      const number = typeof pr?.number === "number" ? pr.number : Number(pr?.number);
      const state =
        event === "pull_request_approved"
          ? "APPROVED"
          : event === "pull_request_rejected"
            ? "REQUEST_CHANGES"
            : String(review?.state ?? review?.type ?? "");
      if (Number.isFinite(number) && state) {
        sse.publish(ws.slug, { type: "pull_reviewed", number, state });
      }
    } else if (event === "pull_request_comment") {
      // A review/line comment on the PR diff (Forgejo header `pull_request_comment`,
      // payload review.type `pull_request_review_comment`). Ping open PR views to
      // refetch the comments.
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const number = typeof pr?.number === "number" ? pr.number : Number(pr?.number);
      if (Number.isFinite(number)) {
        sse.publish(ws.slug, { type: "pull_commented", number });
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
        deleteSidecarForWorkspace(db, ws.slug);
        sse.publish(ws.slug, { type: "workspace_deleted" });
      }
    }
    // Home inbox liveness (#116): activity Forgejo turns into notifications
    // should nudge watchers' cross-repo home inboxes to refetch. Forgejo owns
    // the exact recipient set; we approximate it by the repo's collaborators
    // and publish a content-free hint to each one's per-user channel — a
    // spurious refetch is cheap, and the inbox itself stays Forgejo-sourced.
    if (NOTIFY_EVENTS.has(event)) {
      const collaborators = await fj.listCollaborators(owner, repoName).catch(() => []);
      for (const collaborator of collaborators) {
        sse.publish(notificationChannel(collaborator.login), { type: "notification" });
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
