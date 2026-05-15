import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { listIssues, upsertIssue } from "../issues-indexer.js";
import type { ForgejoIssueComment } from "../forgejo.js";

export const issues = new Hono<AppEnv>();
issues.use("*", requireAuth);
issues.use("/:slug/*", requireMembership());

// GET /api/v1/w/:slug/issues?state=open|closed|all&filter=mine|assigned|all
issues.get("/:slug/issues", (c) => {
  const ws = c.get("workspace");
  const stateRaw = c.req.query("state");
  const state: "open" | "closed" | "all" =
    stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
  const filter = c.req.query("filter");
  const q = c.req.query("q") ?? undefined;
  const userId = c.get("user").id;
  const db = c.get("db");
  if (filter === "mine") {
    const authored = listIssues(db, ws.id, { state, authorUserId: userId, q });
    const assigned = listIssues(db, ws.id, { state, assigneeUserId: userId, q });
    const byNum = new Map<number, (typeof authored)[number]>();
    for (const x of authored) byNum.set(x.number, x);
    for (const x of assigned) byNum.set(x.number, x);
    const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
    return c.json({ issues: merged });
  }
  if (filter === "assigned") {
    return c.json({ issues: listIssues(db, ws.id, { state, assigneeUserId: userId, q }) });
  }
  return c.json({ issues: listIssues(db, ws.id, { state, q }) });
});

// GET /api/v1/w/:slug/issues/pinned — must come before :number routes.
issues.get("/:slug/issues/pinned", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const config = c.get("config");
  const list = await fj.listPinnedIssues(config.forgejoOwner, ws.forgejoRepo);
  const issuesOnly = list.filter((i) => !i.pull_request);
  return c.json({
    issues: issuesOnly.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      comment_count: i.comments,
      updated_at: new Date(i.updated_at).getTime(),
      author_login: i.user.login,
    })),
  });
});

// POST /api/v1/w/:slug/issues/:number/pin — owner-only (Forgejo enforces too)
issues.post("/:slug/issues/:number/pin", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner") return c.json({ error: "owner required", code: "forbidden" }, 403);
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  // Forgejo restricts pinning to repo owner/admin; cosheaf's workspace owner
  // is the Forgejo repo owner (created the repo). Sudo as the workspace
  // owner rather than the calling user, since the caller may be a workspace
  // owner role but not the Forgejo repo owner identity.
  await c.get("forgejo").pinIssue(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    number,
    c.get("config").forgejoOwner,
  );
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "pinned" });
  return c.json({ ok: true });
});

// DELETE /api/v1/w/:slug/issues/:number/pin — owner-only
issues.delete("/:slug/issues/:number/pin", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner") return c.json({ error: "owner required", code: "forbidden" }, 403);
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  await c.get("forgejo").unpinIssue(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    number,
    c.get("config").forgejoOwner,
  );
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "unpinned" });
  return c.json({ ok: true });
});

// GET /api/v1/w/:slug/issues/:number — full issue from Forgejo (body + meta)
issues.get("/:slug/issues/:number", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const config = c.get("config");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  try {
    const issue = await fj.getIssue(config.forgejoOwner, ws.forgejoRepo, number);
    if (issue.pull_request) return c.json({ error: "not an issue" }, 404);
    // Keep the sidecar in sync opportunistically.
    upsertIssue(c.get("db"), ws.id, issue);
    return c.json({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      author: issue.user.login,
      assignees: (issue.assignees ?? []).map((a) => a.login),
      labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      comment_count: issue.comments,
      created_at: new Date(issue.created_at).getTime(),
      updated_at: new Date(issue.updated_at).getTime(),
      closed_at: issue.closed_at ? new Date(issue.closed_at).getTime() : null,
    });
  } catch (_err) {
    return c.json({ error: "not found", code: "not_found" }, 404);
  }
});

// POST /api/v1/w/:slug/issues — create
issues.post("/:slug/issues", async (c) => {
  const ws = c.get("workspace");
  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    body?: string;
    labels?: number[];
  } | null;
  if (!body?.title || !body.title.trim())
    return c.json({ error: "title required", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const created = await fj.createIssue(c.get("config").forgejoOwner, ws.forgejoRepo, {
    title: body.title.trim(),
    body: body.body ?? "",
    labels: body.labels,
    sudo: c.get("forgejoUsername"),
  });
  upsertIssue(c.get("db"), ws.id, created);
  c.get("sse").publish(ws.slug, { type: "issue", number: created.number, action: "opened" });
  return c.json({ number: created.number, title: created.title, state: created.state }, 201);
});

// GET /api/v1/w/:slug/labels
issues.get("/:slug/labels", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const labels = await fj.listLabels(c.get("config").forgejoOwner, ws.forgejoRepo);
  return c.json({ labels });
});

// POST /api/v1/w/:slug/labels — owners only
issues.post("/:slug/labels", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner") return c.json({ error: "owner required", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    color?: string;
    description?: string;
  } | null;
  if (!body?.name || !body.color)
    return c.json({ error: "name and color required", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const created = await fj.createLabel(c.get("config").forgejoOwner, ws.forgejoRepo, {
    name: body.name.trim(),
    color: body.color.replace(/^#/, ""),
    description: body.description,
    sudo: c.get("forgejoUsername"),
  });
  return c.json(created, 201);
});

// PUT /api/v1/w/:slug/issues/:n/labels — replace label set
issues.put("/:slug/issues/:number/labels", async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  const body = (await c.req.json().catch(() => null)) as { labels?: number[] } | null;
  if (!body || !Array.isArray(body.labels))
    return c.json({ error: "labels (number[]) required", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const labels = await fj.setIssueLabels(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    number,
    body.labels,
    c.get("forgejoUsername"),
  );
  // Reflect into the sidecar.
  const updated = await fj.getIssue(c.get("config").forgejoOwner, ws.forgejoRepo, number);
  upsertIssue(c.get("db"), ws.id, updated);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "labeled" });
  return c.json({ labels });
});

// POST /api/v1/w/:slug/issues/:number/close|reopen
issues.post("/:slug/issues/:number/close", async (c) => transitionIssue(c, "closed"));
issues.post("/:slug/issues/:number/reopen", async (c) => transitionIssue(c, "open"));

async function transitionIssue(
  c: import("hono").Context<import("../types.js").AppEnv>,
  state: "open" | "closed",
): Promise<Response> {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const fj = c.get("forgejo");
  const updated = await fj.editIssue(c.get("config").forgejoOwner, ws.forgejoRepo, number, {
    state,
    sudo: c.get("forgejoUsername"),
  });
  upsertIssue(c.get("db"), ws.id, updated);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: state });
  return c.json({ ok: true, state: updated.state });
}

// POST /api/v1/w/:slug/issues/:number/comments — create comment
issues.post("/:slug/issues/:number/comments", async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body || !body.body.trim())
    return c.json({ error: "body required", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const cm = await fj.createIssueComment(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    number,
    body.body.trim(),
    c.get("forgejoUsername"),
  );
  c.get("sse").publish(ws.slug, { type: "issue_comment", number, action: "created" });
  return c.json({
    id: cm.id,
    body: cm.body,
    author: cm.user.login,
    created_at: new Date(cm.created_at).getTime(),
    updated_at: new Date(cm.updated_at).getTime(),
  }, 201);
});

// PATCH /api/v1/w/:slug/issues/:number/comments/:id — edit own
issues.patch("/:slug/issues/:number/comments/:id", async (c) => {
  const ws = c.get("workspace");
  const commentId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body || !body.body.trim())
    return c.json({ error: "body required", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const cm = await fj.editIssueComment(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    commentId,
    body.body.trim(),
    c.get("forgejoUsername"),
  );
  c.get("sse").publish(ws.slug, {
    type: "issue_comment",
    number: Number(c.req.param("number")),
    action: "edited",
  });
  return c.json({ id: cm.id, body: cm.body, updated_at: new Date(cm.updated_at).getTime() });
});

// DELETE /api/v1/w/:slug/issues/:number/comments/:id
issues.delete("/:slug/issues/:number/comments/:id", async (c) => {
  const ws = c.get("workspace");
  const commentId = Number(c.req.param("id"));
  const fj = c.get("forgejo");
  await fj.deleteIssueComment(
    c.get("config").forgejoOwner,
    ws.forgejoRepo,
    commentId,
    c.get("forgejoUsername"),
  );
  c.get("sse").publish(ws.slug, {
    type: "issue_comment",
    number: Number(c.req.param("number")),
    action: "deleted",
  });
  return c.json({ ok: true });
});

// GET /api/v1/w/:slug/issues/:number/comments
issues.get("/:slug/issues/:number/comments", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const config = c.get("config");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const list: ForgejoIssueComment[] = await fj.listIssueComments(
    config.forgejoOwner,
    ws.forgejoRepo,
    number,
  );
  return c.json({
    comments: list.map((cm) => ({
      id: cm.id,
      body: cm.body,
      author: cm.user.login,
      created_at: new Date(cm.created_at).getTime(),
      updated_at: new Date(cm.updated_at).getTime(),
    })),
  });
});
