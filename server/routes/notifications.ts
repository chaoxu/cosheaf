import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import type { ForgejoNotificationThread } from "../forgejo.js";
import type { NotificationRow } from "../../shared/issues.js";
import { bad, notFound } from "./responses.js";

export const notifications = new Hono<AppEnv>();
notifications.use("*", requireAuth);
notifications.use("/:owner/:repo/*", requireMembership());

// Parse "/api/v1/repos/owner/repo/issues/42" or ".../pulls/42" → 42.
function numberFromSubjectUrl(url: string): number | null {
  const m = url.match(/\/(?:issues|pulls)\/(\d+)(?:[?#]|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function mapThread(t: ForgejoNotificationThread): NotificationRow | null {
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
    updated_at: new Date(t.updated_at).getTime(),
    url: t.subject.html_url ?? t.subject.url,
  };
}

// GET /api/v1/repos/:owner/:repo/notifications — unread notifications for the
// calling user in this workspace's Forgejo repo.
notifications.get("/:owner/:repo/notifications", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const threads = await fj.listRepoNotifications(owner, repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  });
  const mapped = threads
    .map(mapThread)
    .filter((x): x is NonNullable<ReturnType<typeof mapThread>> => x !== null)
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ notifications: mapped });
});

// POST /api/v1/repos/:owner/:repo/notifications/:id/read
notifications.post("/:owner/:repo/notifications/:id/read", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json(...bad("bad id"));
  const { fj } = c.get("repoCtx");
  const thread = await fj.getNotificationThread(id);
  if (thread.repository.full_name !== c.get("workspace").slug) return c.json(...notFound());
  await fj.markNotificationRead(id);
  return c.json({ ok: true });
});

// POST /api/v1/repos/:owner/:repo/notifications/read-all
notifications.post("/:owner/:repo/notifications/read-all", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.markRepoNotificationsRead(owner, repo);
  return c.json({ ok: true });
});
