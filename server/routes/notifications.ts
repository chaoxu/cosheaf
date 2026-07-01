import { Hono } from "hono";
import { notificationChannel } from "../../shared/conventions.js";
import type { NotificationRow } from "../../shared/issues.js";
import { forgeNotificationThreadToRow, forgeNotificationThreadsToRows } from "../core/forge-dto.js";
import type { ForgejoNotificationThread } from "../forgejo.js";
import { repoCtxCollab, requireAuth, requireMembership } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { parsePositiveIntId } from "./query-params.js";
import { bad, notFound } from "./responses.js";
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

// GET /api/v1/notifications/threads/:id — a single notification thread by its
// global forge id, mapped to a NotificationRow (Issue/Pull only). The Origin
// API reads this so the local Workbench can resolve a thread's repo before
// marking it read; the per-repo ownership check stays on the repo route below.
globalNotifications.get("/notifications/threads/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad id"));
  const row = mapThread(await c.get("fjUser").getNotificationThread(id));
  if (!row) return c.json(...notFound());
  return c.json({ notification: row });
});

// POST /api/v1/notifications/:id/read — mark one thread read by its global
// forge id (forwards to the forge's per-thread mark-read).
globalNotifications.post("/notifications/:id/read", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad id"));
  await c.get("fjUser").markNotificationRead(id);
  return c.json({ ok: true });
});

// Map a batch of Forgejo notification threads to cosheaf NotificationRows,
// dropping non-Issue/Pull subjects and sorting newest first. Shared by the
// typed repo route and the home inbox.
export function mapThreads(threads: readonly ForgejoNotificationThread[]): NotificationRow[] {
  return forgeNotificationThreadsToRows(threads);
}

function mapThread(thread: ForgejoNotificationThread): NotificationRow | null {
  return forgeNotificationThreadToRow(thread);
}

// GET /api/v1/repos/:owner/:repo/notifications — unread notifications for the
// calling user in this workspace's Forgejo repo.
notifications.get("/:owner/:repo/notifications", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const notifications = await collab.listRepoNotifications(owner, repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  });
  return c.json({ notifications });
});

// POST /api/v1/repos/:owner/:repo/notifications/:id/read
notifications.post("/:owner/:repo/notifications/:id/read", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad id"));
  const { collab } = repoCtxCollab(c);
  // A stale/cross-repo/unreadable id should 404, not 500 — normalize the fetch.
  const thread = await collab.getNotificationThread(id).catch(() => null);
  if (!thread || thread.repo !== c.get("workspace").slug) return c.json(...notFound());
  await collab.markNotificationRead(id);
  return c.json({ ok: true });
});

// POST /api/v1/repos/:owner/:repo/notifications/read-all
notifications.post("/:owner/:repo/notifications/read-all", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.markRepoNotificationsRead(owner, repo);
  return c.json({ ok: true });
});
