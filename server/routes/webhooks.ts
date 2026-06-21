// Forgejo webhook receiver. Verifies HMAC, dedupes by delivery id, updates the
// sidecar (FTS, backlinks, doc_map, citation keys), and fans out to SSE.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { notificationChannel, parseWorkspaceSlug, workspaceSlug } from "../../shared/conventions.js";
import { type DocumentFormatId, documentFormatFromTopics } from "../../shared/document-format.js";
import type { ForgejoIssue } from "../forgejo.js";
import { deleteCitationFile, deletePage, indexCitationFile, indexPage } from "../indexer.js";
import { invalidateWorkspaceCaches } from "../middleware.js";
import { bustRepoConfig, REPO_CONFIG_PATH } from "../repo-config.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteSidecarForWorkspace } from "../workspace-cleanup.js";
import { withWorkspaceSidecarLock } from "../workspace-lock.js";
import { getWorkspaceMarkdownDrift, lockedReindexWorkspaceFromForgejo } from "../workspace-provisioning.js";
import { serializeWorkspace } from "../workspace-queue.js";
import { parsePositiveIntId } from "./query-params.js";
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
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(raw);
  } catch (_err) {
    return c.json(...bad("bad json"));
  }
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
    return c.json(...bad("bad json"));
  }
  const payload = parsedPayload as Record<string, unknown>;
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

  const ws: { slug: string; defaultMdFormat?: DocumentFormatId } = { slug: workspaceSlug(owner, repoName) };

  // Repository deletion events arrive after Forgejo has removed the repo, so
  // they must not go through the existence check below. The event itself is the
  // authoritative signal to wipe Cosheaf's rebuildable sidecar rows.
  if (event === "repository" && String(payload.action ?? "") === "deleted") {
    let deduped = false;
    await serializeWorkspace(ws.slug, () => withWorkspaceSidecarLock(db, ws.slug, async () => {
      const claim = db
        .prepare(
          "INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)",
        )
        .run(deliveryId, Date.now(), event);
      if (claim.changes === 0) {
        deduped = true;
        return;
      }
      deleteSidecarForWorkspace(db, ws.slug);
      invalidateRepoTrees(owner, repoName);
      invalidateWorkspaceCaches(owner, repoName);
      sse.publish(ws.slug, { type: "workspace_deleted" });
    }));
    return c.json({ ok: true, ...(deduped ? { dedup: true } : {}) });
  }

  // The repo must exist on our Forgejo; otherwise it's a webhook from a
  // foreign target. Check existence before topic lookup: for a deleted/unknown
  // repo, topics 404 and would otherwise bypass the intended ack path.
  const repo = await fj.getRepo(owner, repoName);
  if (!repo) {
    db.prepare("INSERT OR IGNORE INTO webhook_log (delivery_id, delivered_at, event_type) VALUES (?, ?, ?)").run(
      deliveryId, Date.now(), event,
    );
    return c.json({ ok: true, ignored: "unknown_repo" });
  }
  const formatId = event === "push" ? await fj.listRepoTopics(owner, repoName).then(documentFormatFromTopics) : undefined;
  ws.defaultMdFormat = formatId;

  let deduped = false;
  await serializeWorkspace(ws.slug, () => withWorkspaceSidecarLock(db, ws.slug, async () => {
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
        const bibPaths = [...touched].filter((p) => p.endsWith(".bib"));
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
        const bibResults = await Promise.all(
          bibPaths.map((path) =>
            fj.getRawFile(owner, repoName, "main", path).then(
              (body) => ({ path, body, error: null as string | null }),
              (err: unknown) => ({ path, body: "", error: (err as Error).message }),
            ),
          ),
        );
        const failures: string[] = [];
        for (const r of bibResults) {
          if (r.error) {
            failures.push(`${r.path}: ${r.error}`);
            continue;
          }
          indexCitationFile(db, {
            workspaceSlug: ws.slug,
            filePath: r.path,
            bodyText: r.body,
          });
        }
        const indexed: Array<{ path: string; body: string }> = [];
        for (const r of results) {
          if (r.error) {
            failures.push(`${r.path}: ${r.error}`);
            continue;
          }
          indexed.push({ path: r.path, body: r.body });
          indexPage(db, {
            workspaceSlug: ws.slug,
            filePath: r.path,
            bodyText: r.body,
            formatId: ws.defaultMdFormat,
          });
        }
        if (indexed.length > 1) {
          // First pass makes all page ids/xref targets visible; the second pass
          // resolves same-push links without depending on Forgejo's path order.
          for (const r of indexed) {
            indexPage(db, {
              workspaceSlug: ws.slug,
              filePath: r.path,
              bodyText: r.body,
              formatId: ws.defaultMdFormat,
            });
          }
        }
        for (const path of removed) {
          if (path.endsWith(".bib")) deleteCitationFile(db, ws.slug, path);
        }
        if (failures.length > 0) {
          // Don't throw — that would unwind the dedupe row and provoke a Forgejo
          // retry storm. The repair path below reconciles from the authoritative
          // Forgejo tree when possible.
          console.warn(`webhook reindex partial failure (delivery=${deliveryId}): ${failures.join("; ")}`);
        }
        const totalCommits = typeof payload.total_commits === "number" ? payload.total_commits : commits.length;
        let needsFullReindex =
          failures.length > 0 ||
          commits.length === 0 ||
          totalCommits > commits.length ||
          (touched.size === 0 && removed.size === 0);
        try {
          if (!needsFullReindex) {
            const drift = await getWorkspaceMarkdownDrift(db, fj, { owner, repo: repoName, slug: ws.slug });
            needsFullReindex = drift.onlySidecar.length > 0 || drift.onlyForgejo.length > 0;
          }
          if (needsFullReindex) {
            await lockedReindexWorkspaceFromForgejo(db, fj, {
              owner,
              repo: repoName,
              slug: ws.slug,
              defaultMdFormat: ws.defaultMdFormat,
            });
          }
        } catch (err) {
          console.warn(
            `webhook reconcile check failed (delivery=${deliveryId}, workspace=${ws.slug}): ${(err as Error).message}`,
          );
        }
        // Per-path events let the frontend reload only the open file when needed.
        for (const path of touched) sse.publish(ws.slug, { type: "change", path });
        for (const path of removed) sse.publish(ws.slug, { type: "remove", path });
      }
    } else if (event === "pull_request") {
      // PR state lives on Forgejo; we only ping clients to refetch.
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (pr) {
        const number = parsePositiveIntId(pr.number);
        const action = String(payload.action ?? "");
        if (number !== null) sse.publish(ws.slug, { type: "pull", number, action });
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
      const number = parsePositiveIntId(pr?.number);
      const state =
        event === "pull_request_approved"
          ? "APPROVED"
          : event === "pull_request_rejected"
            ? "REQUEST_CHANGES"
            : String(review?.state ?? review?.type ?? "");
      if (number !== null && state) {
        sse.publish(ws.slug, { type: "pull_reviewed", number, state });
      }
    } else if (event === "pull_request_comment") {
      // A review/line comment on the PR diff (Forgejo header `pull_request_comment`,
      // payload review.type `pull_request_review_comment`). Ping open PR views to
      // refetch the comments.
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const number = parsePositiveIntId(pr?.number);
      if (number !== null) {
        sse.publish(ws.slug, { type: "pull_commented", number });
      }
    } else if (event === "issues") {
      const issue = payload.issue as ForgejoIssue | undefined;
      const action = String(payload.action ?? "");
      const number = parsePositiveIntId(issue?.number);
      if (issue && !issue.pull_request && number !== null) {
        sse.publish(ws.slug, { type: "issue", number, action });
      }
    } else if (event === "issue_comment") {
      const issue = payload.issue as ForgejoIssue | undefined;
      const number = parsePositiveIntId(issue?.number);
      if (issue && !issue.pull_request && number !== null) {
        sse.publish(ws.slug, {
          type: "issue_comment",
          number,
          action: String(payload.action ?? ""),
        });
      }
    }
    // Home inbox liveness (#116): activity Forgejo turns into notifications
    // should nudge watchers' cross-repo home inboxes to refetch. Forgejo owns
    // the exact recipient set; we approximate it by the repo's collaborators
    // and publish a content-free hint to each one's per-user channel — a
    // spurious refetch is cheap, and the inbox itself stays Forgejo-sourced.
    if (NOTIFY_EVENTS.has(event)) {
      const collaborators = await fj.listCollaborators(owner, repoName).catch(() => []);
      // Forgejo's collaborators list EXCLUDES the repo owner, but on a user-owned
      // workspace (the common cosheaf case) the owner is the primary recipient —
      // include them. A spurious publish to an org-owner channel has no subscribers.
      const recipients = new Set([owner, ...collaborators.map((collaborator) => collaborator.login)]);
      for (const login of recipients) {
        sse.publish(notificationChannel(login), { type: "notification" });
      }
    }
    } catch (err) {
      console.warn(
        `webhook handler error (delivery=${deliveryId}, event=${event}): ${(err as Error).message}`,
      );
    }
  }));
  if (deduped) return c.json({ ok: true, dedup: true });
  return c.json({ ok: true });
});
