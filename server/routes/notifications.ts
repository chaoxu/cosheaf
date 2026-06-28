import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { repoCtxForgejo, requireAuth, requireMembership } from "../middleware.js";
import { notificationChannel } from "../../shared/conventions.js";
import type { ForgejoNotificationThread } from "../forgejo.js";
import type { NotificationRow } from "../../shared/issues.js";
import { toEpochMs } from "../forgejo-types.js";
import { bad, notFound } from "./responses.js";
import { parsePositiveIntId } from "./query-params.js";
import { streamHubChannel } from "./sse-helpers.js";

export const notifications = new Hono<AppEnv>();
notifications.use("*", requireAuth);
notifications.use("/:owner/:repo/*", requireMembership());

// Global (cross-repo) notification surface, mounted at /api/v1 (not under
// /repos) so agents get the same per-user queue the web home inbox reads
// directly via fjUser — typed, not a raw Forgejo passthrough. Thin wrapper
// over Forgejo's global notifications; nothing is mirrored into SQLite.
export const globalNotifications = new Hono<AppEnv>();
globalNotifications.use("*", requireAuth);

// GET /api/v1/notifications — the caller's cross-repo unread Issue/Pull queue.
globalNotifications.get("/notifications", async (c) => {
  const threads = await c
    .get("fjUser")
    .listNotifications({ statusTypes: ["unread"], subjectTypes: ["Issue", "Pull"] });
  return c.json({ notifications: mapThreads(threads) });
});

// POST /api/v1/notifications/read-all — mark the caller's whole queue read.
globalNotifications.post("/notifications/read-all", async (c) => {
  await c.get("fjUser").markAllNotificationsRead();
  return c.json({ ok: true });
});

// GET /api/v1/notifications/events — SSE stream on the caller's per-user
// channel. Webhook reconciliation publishes a content-free `notification` hint
// here (fanned out to a repo's collaborators) so an open home inbox can refetch
// live instead of only on full page load.
globalNotifications.get("/notifications/events", (c) =>
  streamHubChannel(c, c.get("sse"), notificationChannel(c.get("user").username)),
);

// Parse "/api/v1/repos/owner/repo/issues/42" or ".../pulls/42" → 42.
function numberFromSubjectUrl(url: string): number | null {
  const m = url.match(/\/(?:issues|pulls)\/(\d+)(?:[?#]|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Map a batch of Forgejo notification threads to cosheaf NotificationRows,
// dropping non-Issue/Pull subjects and sorting newest first. Shared by the
// typed repo route and the home inbox.
export function mapThreads(threads: readonly ForgejoNotificationThread[]): NotificationRow[] {
  return threads
    .map(mapThread)
    .filter((row): row is NotificationRow => row !== null)
    .sort((a, b) => b.updated_at - a.updated_at);
}

function mapThread(t: ForgejoNotificationThread): NotificationRow | null {
  const subjectType = t.subject.type;
  const kind: "issue" | "pr" | null =
    subjectType === "Issue" ? "issue" : subjectType === "Pull" ? "pr" : null;
  if (!kind) return null;
  const number = numberFromSubjectUrl(t.subject.url);
  if (number == null) return null;
  return {
    id: t.id,
    kind,
    number,
    title: t.subject.title,
    repo: t.repository.full_name,
    updated_at: toEpochMs(t.updated_at),
    url: t.subject.html_url ?? t.subject.url,
  };
}

// GET /api/v1/repos/:owner/:repo/notifications — unread notifications for the
// calling user in this workspace's Forgejo repo.
notifications.get("/:owner/:repo/notifications", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const threads = await fj.listRepoNotifications(owner, repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  });
  return c.json({ notifications: mapThreads(threads) });
});

// POST /api/v1/repos/:owner/:repo/notifications/:id/read
notifications.post("/:owner/:repo/notifications/:id/read", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad id"));
  const { fj } = repoCtxForgejo(c);
  // A stale/cross-repo/unreadable id should 404, not 500 — normalize the fetch.
  const thread = await fj.getNotificationThread(id).catch(() => null);
  if (!thread || thread.repository?.full_name !== c.get("workspace").slug) return c.json(...notFound());
  await fj.markNotificationRead(id);
  return c.json({ ok: true });
});

// POST /api/v1/repos/:owner/:repo/notifications/read-all
notifications.post("/:owner/:repo/notifications/read-all", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  await fj.markRepoNotificationsRead(owner, repo);
  return c.json({ ok: true });
});
