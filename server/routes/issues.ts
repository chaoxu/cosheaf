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
  const userId = c.get("user").id;
  const db = c.get("db");
  if (filter === "mine") {
    // Issues you authored OR are assigned to.
    const authored = listIssues(db, ws.id, { state, authorUserId: userId });
    const assigned = listIssues(db, ws.id, { state, assigneeUserId: userId });
    const byNum = new Map<number, (typeof authored)[number]>();
    for (const x of authored) byNum.set(x.number, x);
    for (const x of assigned) byNum.set(x.number, x);
    const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
    return c.json({ issues: merged });
  }
  if (filter === "assigned") {
    return c.json({ issues: listIssues(db, ws.id, { state, assigneeUserId: userId }) });
  }
  return c.json({ issues: listIssues(db, ws.id, { state }) });
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
