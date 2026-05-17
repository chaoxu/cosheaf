import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAdmin, requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { DELETED_USER_LOGIN, type ForgejoIssue } from "../forgejo-types.js";
import type { ForgejoIssueComment } from "../forgejo.js";
import type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Milestone,
  TimelineEvent,
} from "../../shared/issues.js";

function toIssueRow(i: ForgejoIssue): IssueRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author_login: i.user?.login ?? DELETED_USER_LOGIN,
    labels: i.labels.map((l) => l.name),
    comment_count: i.comments,
    created_at: new Date(i.created_at).getTime(),
    updated_at: new Date(i.updated_at).getTime(),
  };
}

export const issues = new Hono<AppEnv>();
issues.use("*", requireAuth);
issues.use("/:slug/*", requireMembership());
issues.use("/:slug/*", requireWriteOnMutation);

// GET /api/v1/w/:slug/issues?state=open|closed|all&filter=mine|assigned|all
issues.get("/:slug/issues", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const stateRaw = c.req.query("state");
  const state: "open" | "closed" | "all" =
    stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
  const filter = c.req.query("filter");
  const q = c.req.query("q") ?? undefined;
  // The sidecar used to compute these locally; Forgejo's repo-scoped /issues
  // already supports the same filters, so proxy through with `Sudo` so it
  // resolves against the caller's identity.
  if (filter === "mine") {
    // "mine" = authored OR assigned. Forgejo doesn't OR these server-side,
    // so two calls + dedupe. They're cheap and the response is small.
    const [authored, assigned] = await Promise.all([
      fj.listIssues(owner, repo, { state, q }),
      fj.listIssues(owner, repo, { state, q }),
    ]);
    const byNum = new Map<number, IssueRow>();
    for (const i of [...authored, ...assigned]) {
      if (!i.pull_request) byNum.set(i.number, toIssueRow(i));
    }
    const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
    return c.json({ issues: merged });
  }
  const list = await fj.listIssues(owner, repo, {
    state,
    q,
    ...(filter === "assigned" ? {  } : {}),
  });
  return c.json({ issues: list.filter((i) => !i.pull_request).map(toIssueRow) });
});

// GET /api/v1/w/:slug/issues/pinned — must come before :number routes.
issues.get("/:slug/issues/pinned", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listPinnedIssues(owner, repo);
  const issuesOnly = list.filter((i) => !i.pull_request);
  return c.json({
    issues: issuesOnly.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      comment_count: i.comments,
      updated_at: new Date(i.updated_at).getTime(),
      author_login: i.user?.login ?? DELETED_USER_LOGIN,
    })),
  });
});

// POST /api/v1/w/:slug/issues/:number/pin — owner-only (Forgejo enforces too)
issues.post("/:slug/issues/:number/pin", requireAdmin, async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  // Forgejo restricts pinning to repo owner/admin; the calling user is gated
  // by requireAdmin above, so their PAT has the required permission.
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.pinIssue(owner, repo, number);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "pinned" });
  return c.json({ ok: true });
});

// DELETE /api/v1/w/:slug/issues/:number/pin — owner-only
issues.delete("/:slug/issues/:number/pin", requireAdmin, async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.unpinIssue(owner, repo, number);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "unpinned" });
  return c.json({ ok: true });
});

// GET /api/v1/w/:slug/issues/:number — full issue from Forgejo (body + meta)
issues.get("/:slug/issues/:number", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  try {
    const issue = await fj.getIssue(owner, repo, number);
    if (issue.pull_request) return c.json({ error: "not an issue" }, 404);
    const detail: IssueDetail = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      author: issue.user?.login ?? DELETED_USER_LOGIN,
      assignees: (issue.assignees ?? []).map((a) => a.login),
      labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      milestone: issue.milestone ? { id: issue.milestone.id, title: issue.milestone.title } : null,
      comment_count: issue.comments,
      created_at: new Date(issue.created_at).getTime(),
      updated_at: new Date(issue.updated_at).getTime(),
      closed_at: issue.closed_at ? new Date(issue.closed_at).getTime() : null,
    };
    return c.json(detail);
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
  const { fj, owner, repo } = c.get("repoCtx");
  const created = await fj.createIssue(owner, repo, {
    title: body.title.trim(),
    body: body.body ?? "",
    labels: body.labels,
  });
  c.get("sse").publish(ws.slug, { type: "issue", number: created.number, action: "opened" });
  return c.json({ number: created.number, title: created.title, state: created.state }, 201);
});

// GET /api/v1/w/:slug/labels
issues.get("/:slug/labels", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const labels = await fj.listLabels(owner, repo);
  return c.json({ labels });
});

// POST /api/v1/w/:slug/labels — owners only
issues.post("/:slug/labels", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: string;
    color?: string;
    description?: string;
  } | null;
  if (!body?.name || !body.color)
    return c.json({ error: "name and color required", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const created = await fj.createLabel(owner, repo, {
    name: body.name.trim(),
    color: body.color.replace(/^#/, ""),
    description: body.description,
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
  const { fj, owner, repo } = c.get("repoCtx");
  const labels = await fj.setIssueLabels(owner, repo, number, body.labels);
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
  const { fj, owner, repo } = c.get("repoCtx");
  const updated = await fj.editIssue(owner, repo, number, {
    state,
  });
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
  const { fj, owner, repo } = c.get("repoCtx");
  const cm = await fj.createIssueComment(owner, repo, number, body.body.trim());
  c.get("sse").publish(ws.slug, { type: "issue_comment", number, action: "created" });
  const created: IssueComment = {
    id: cm.id,
    body: cm.body,
    author: cm.user?.login ?? DELETED_USER_LOGIN,
    created_at: new Date(cm.created_at).getTime(),
    updated_at: new Date(cm.updated_at).getTime(),
  };
  return c.json(created, 201);
});

// PATCH /api/v1/w/:slug/issues/:number/comments/:id — edit own
issues.patch("/:slug/issues/:number/comments/:id", async (c) => {
  const ws = c.get("workspace");
  const commentId = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body || !body.body.trim())
    return c.json({ error: "body required", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const cm = await fj.editIssueComment(owner, repo, commentId, body.body.trim());
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
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.deleteIssueComment(owner, repo, commentId);
  c.get("sse").publish(ws.slug, {
    type: "issue_comment",
    number: Number(c.req.param("number")),
    action: "deleted",
  });
  return c.json({ ok: true });
});

// ---------- milestones ----------

issues.get("/:slug/milestones", async (c) => {
  const stateRaw = c.req.query("state");
  const state: "open" | "closed" | "all" =
    stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listMilestones(owner, repo, state);
  return c.json({
    milestones: (list ?? []).map<Milestone>((m) => ({
      id: m.id,
      title: m.title,
      description: m.description ?? "",
      state: m.state,
      open_issues: m.open_issues,
      closed_issues: m.closed_issues,
      due_on: m.due_on ? new Date(m.due_on).getTime() : null,
    })),
  });
});

issues.post("/:slug/milestones", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    description?: string;
  } | null;
  if (!body?.title || !body.title.trim())
    return c.json({ error: "title required", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const m = await fj.createMilestone(owner, repo, {
    title: body.title.trim(),
    description: body.description,
  });
  return c.json({ id: m.id, title: m.title, state: m.state }, 201);
});

// PUT /api/v1/w/:slug/issues/:n/milestone (body: { id: number | null })
issues.put("/:slug/issues/:number/milestone", async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const body = (await c.req.json().catch(() => null)) as { id?: number | null } | null;
  if (body === null) return c.json({ error: "body required", code: "validation" }, 400);
  const milestoneId = body.id ?? null;
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.editIssue(owner, repo, number, {
    milestone: milestoneId,
  });
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "milestone" });
  return c.json({ ok: true });
});

// ---------- dependencies ----------

function depRow(i: { number: number; title: string; state: "open" | "closed"; pull_request?: unknown }): DependencyRow {
  return { number: i.number, title: i.title, state: i.state, is_pr: !!i.pull_request };
}

issues.get("/:slug/issues/:number/dependencies", async (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listIssueDependencies(owner, repo, number);
  return c.json({ issues: (list ?? []).map(depRow) });
});

issues.get("/:slug/issues/:number/blocks", async (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listIssueBlocks(owner, repo, number);
  return c.json({ issues: (list ?? []).map(depRow) });
});

issues.post("/:slug/issues/:number/dependencies", async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  const body = (await c.req.json().catch(() => null)) as { index?: number } | null;
  if (!Number.isFinite(number) || !body?.index)
    return c.json({ error: "bad number / index", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.addIssueDependency(owner, repo, number, body.index);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "dependency_added" });
  return c.json({ ok: true });
});

issues.delete("/:slug/issues/:number/dependencies/:dep", async (c) => {
  const ws = c.get("workspace");
  const number = Number(c.req.param("number"));
  const dep = Number(c.req.param("dep"));
  if (!Number.isFinite(number) || !Number.isFinite(dep))
    return c.json({ error: "bad number" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.removeIssueDependency(owner, repo, number, dep);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "dependency_removed" });
  return c.json({ ok: true });
});

// GET /api/v1/w/:slug/activities — workspace event feed
issues.get("/:slug/activities", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const { fj, owner, repo } = c.get("repoCtx");
  const raw = await fj.listRepoActivities(owner, repo, { limit });
  const safe = raw ?? [];
  return c.json({
    activities: safe.map<ActivityRow>((a) => {
      // Forgejo encodes content as a JSON array string for many op_types.
      // For comment_*: ["<issue_index>","<body>"]
      // For close_issue, reopen_issue, etc: often just "<issue_index>" or
      // similar — keep raw and let the client parse what it can.
      let refIndex: number | null = null;
      let body: string | null = null;
      if (a.content) {
        try {
          const parsed: unknown = JSON.parse(a.content);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const first = parsed[0];
            const n = Number(first);
            if (Number.isFinite(n)) refIndex = n;
            if (parsed.length > 1 && typeof parsed[1] === "string") body = parsed[1];
          } else if (typeof parsed === "string") {
            const n = Number(parsed);
            if (Number.isFinite(n)) refIndex = n;
          }
        } catch (_err) {
          // content wasn't JSON; ignore.
        }
      }
      return {
        id: a.id,
        op_type: a.op_type,
        actor: a.act_user?.login ?? null,
        ref_index: refIndex,
        ref_name: a.ref_name ?? null,
        comment_body: body,
        created_at: new Date(a.created).getTime(),
      };
    }),
  });
});

// GET /api/v1/w/:slug/issues/:number/timeline — full event log
issues.get("/:slug/issues/:number/timeline", async (c) => {
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const events = await fj.listIssueTimeline(owner, repo, number);
  // Forgejo returns null instead of [] for some empty issue timelines.
  const safe = events ?? [];
  return c.json({
    events: safe.map<TimelineEvent>((e) => ({
      id: e.id,
      type: e.type,
      author: e.user?.login ?? null,
      body: e.body ?? null,
      created_at: new Date(e.created_at).getTime(),
      updated_at: e.updated_at ? new Date(e.updated_at).getTime() : null,
      label: e.label ? { name: e.label.name, color: e.label.color } : null,
      old_title: e.old_title ?? null,
      new_title: e.new_title ?? null,
      assignee: e.assignee?.login ?? null,
      removed_assignee: e.removed_assignee ?? false,
      ref_issue: e.ref_issue ?? null,
      ref_action: e.ref_action ?? null,
      ref_commit_sha: e.ref_commit_sha ?? null,
      milestone: e.milestone?.title ?? null,
      dependent_issue: e.dependent_issue
        ? { number: e.dependent_issue.number, title: e.dependent_issue.title, state: e.dependent_issue.state }
        : null,
    })),
  });
});

// GET /api/v1/w/:slug/issues/:number/comments
issues.get("/:slug/issues/:number/comments", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const number = Number(c.req.param("number"));
  if (!Number.isFinite(number)) return c.json({ error: "bad number" }, 400);
  const list: ForgejoIssueComment[] = await fj.listIssueComments(owner, repo, number);
  return c.json({
    comments: list.map<IssueComment>((cm) => ({
      id: cm.id,
      body: cm.body,
      author: cm.user?.login ?? DELETED_USER_LOGIN,
      created_at: new Date(cm.created_at).getTime(),
      updated_at: new Date(cm.updated_at).getTime(),
    })),
  });
});
