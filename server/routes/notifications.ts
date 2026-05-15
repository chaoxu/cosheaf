import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import type { ForgejoNotificationThread } from "../forgejo.js";

export const notifications = new Hono<AppEnv>();
notifications.use("*", requireAuth);
notifications.use("/:slug/*", requireMembership());

// Parse "/api/v1/repos/owner/repo/issues/42" or ".../pulls/42" → 42.
function numberFromSubjectUrl(url: string): number | null {
  const m = url.match(/\/(?:issues|pulls)\/(\d+)(?:[?#]|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function mapThread(t: ForgejoNotificationThread): {
  id: number;
  kind: "issue" | "pr";
  number: number;
  title: string;
  repo: string;
  updated_at: number;
  url: string;
} | null {
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

// GET /api/v1/w/:slug/notifications — unread notifications for the calling
// user in this workspace's Forgejo repo.
notifications.get("/:slug/notifications", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const sudo = c.get("forgejoUsername");
  const threads = await fj.listRepoNotifications(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    sudo,
  );
  const mapped = threads
    .map(mapThread)
    .filter((x): x is NonNullable<ReturnType<typeof mapThread>> => x !== null)
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ notifications: mapped });
});

// POST /api/v1/w/:slug/notifications/:id/read
notifications.post("/:slug/notifications/:id/read", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id", code: "validation" }, 400);
  await c.get("forgejo").markNotificationRead(id, c.get("forgejoUsername"));
  return c.json({ ok: true });
});

// POST /api/v1/w/:slug/notifications/read-all
notifications.post("/:slug/notifications/read-all", async (c) => {
  const ws = c.get("workspace");
  await c.get("forgejo").markRepoNotificationsRead(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    c.get("forgejoUsername"),
  );
  return c.json({ ok: true });
});
