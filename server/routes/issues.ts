import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { DELETED_USER_LOGIN, type ForgejoIssue } from "../forgejo-types.js";
import type {
  ActivityRow,
  IssueDetail,
  IssueRow,
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

// Typed because the SPA needs an issue-only row shape and "mine" composes two
// Forgejo filters (created_by OR assigned_by).
issues.get("/:slug/issues", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const stateRaw = c.req.query("state");
  const state: "open" | "closed" | "all" =
    stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
  const filter = c.req.query("filter");
  const q = c.req.query("q") ?? undefined;
  const username = c.get("user").username;
  // The sidecar used to compute these locally; Forgejo's repo-scoped /issues
  // already supports the same filters. The caller's PAT is what the Forgejo
  // client is bound to, so created_by/assigned_by use their identity.
  if (filter === "mine") {
    // "mine" = authored OR assigned. Forgejo doesn't OR these server-side,
    // so two calls + dedupe. They're cheap and the response is small.
    const [authored, assigned] = await Promise.all([
      fj.listIssues(owner, repo, { state, q, created_by: username }),
      fj.listIssues(owner, repo, { state, q, assigned_by: username }),
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
    ...(filter === "assigned" ? { assigned_by: username } : {}),
  });
  return c.json({ issues: list.filter((i) => !i.pull_request).map(toIssueRow) });
});

// Typed because Forgejo returns raw issues/PRs; the SPA wants issue-only rows.
// Must come before :number routes.
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

// Typed because the SPA consumes a stable IssueDetail DTO with deleted-user
// fallback and normalized timestamps.
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
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404) {
      return c.json({ error: "not found", code: "not_found" }, 404);
    }
    throw err;
  }
});

// Typed because issue creation emits workspace SSE and returns the compact row
// shape used by the human UI. Plain Forgejo callers can use passthrough.
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

// Issue comment list/create/edit/delete are pure Forgejo passthrough.
// The SPA hits /forgejo/issues/:n/comments and /forgejo/issues/comments/:id
// and normalizes the response shape client-side.

// Dependencies/blocks are Forgejo-native; the SPA calls them through the
// passthrough at /forgejo/issues/:n/dependencies and derives is_pr client-side.

// Typed because Forgejo activities encode references in JSON-ish strings; the
// SPA gets parsed issue refs and normalized timestamps.
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

// Typed because the SPA timeline uses a narrowed event DTO with normalized
// label/milestone/dependency references.
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

