import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { is404 } from "../forgejo-errors.js";
import { activityCommitRef, collapseNoisyEditBranchCommits, parseActivityContent } from "../activity-feed.js";
import {
  type ForgejoIssue,
  type ForgejoIssueComment,
  type ForgejoMilestone,
  userLogin,
} from "../forgejo-types.js";
import type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Milestone,
  TimelineEvent,
} from "../../shared/issues.js";
import { toLabel, validateLabelSelection } from "./label-utils.js";
import { bad, notFound } from "./responses.js";
import { parseListState } from "./query-params.js";

function toIssueRow(i: ForgejoIssue): IssueRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author_username: userLogin(i.user),
    labels: i.labels.map(toLabel),
    comment_count: i.comments,
    created_at: new Date(i.created_at).getTime(),
    updated_at: new Date(i.updated_at).getTime(),
  };
}

function toIssueComment(cm: ForgejoIssueComment): IssueComment {
  return {
    id: cm.id,
    body: cm.body,
    author_username: userLogin(cm.user),
    created_at: Date.parse(cm.created_at) || 0,
    updated_at: Date.parse(cm.updated_at) || 0,
  };
}

function toMilestone(milestone: ForgejoMilestone): Milestone {
  return {
    id: milestone.id,
    title: milestone.title,
    description: milestone.description ?? "",
    state: milestone.state,
    open_issues: milestone.open_issues,
    closed_issues: milestone.closed_issues,
    due_on: milestone.due_on ? Date.parse(milestone.due_on) || null : null,
  };
}

function toDependencyRow(i: ForgejoIssue): DependencyRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    is_pr: !!i.pull_request,
  };
}

// Accept unknown: these parse path params (strings) AND JSON body fields, which
// may already be numbers — so they can't reuse parsePositiveInt's string-only
// contract.
function parseIssueNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function trimmedQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type IssueSort = "relevance" | "latest" | "oldest" | "recentupdate" | "leastupdate" | "mostcomment" | "leastcomment" | "nearduedate" | "farduedate";

function parseIssueSort(value: string | undefined): IssueSort | undefined {
  const allowed = new Set([
    "relevance",
    "latest",
    "oldest",
    "recentupdate",
    "leastupdate",
    "mostcomment",
    "leastcomment",
    "nearduedate",
    "farduedate",
  ]);
  return value && allowed.has(value) ? value as IssueSort : undefined;
}

export const issues = new Hono<AppEnv>();
issues.use("*", requireAuth);
issues.use("/:owner/:repo/*", requireMembership());
issues.use("/:owner/:repo/*", requireWriteOnMutation);

// Typed because the public API needs an issue-only row shape and "mine"
// composes two Forgejo filters (created_by OR assigned_by).
issues.get("/:owner/:repo/issues", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const state = parseListState(c.req.query("state"));
  const filter = c.req.query("filter");
  const q = c.req.query("q") ?? undefined;
  const username = c.get("user").username;
  const labels = trimmedQuery(c.req.query("labels"));
  const milestones = trimmedQuery(c.req.query("milestones"));
  const assignedBy = trimmedQuery(c.req.query("assigned_by"));
  const createdBy = trimmedQuery(c.req.query("created_by"));
  const mentionedBy = trimmedQuery(c.req.query("mentioned_by"));
  const sort = parseIssueSort(c.req.query("sort"));
  // The sidecar used to compute these locally; Forgejo's repo-scoped issues
  // endpoint already supports the same filters. The caller's token is what the
  // Forgejo client is bound to, so created_by/assigned_by use their identity.
  if (filter === "mine") {
    // "mine" = authored OR assigned. Forgejo doesn't OR these server-side,
    // so two calls + dedupe. They're cheap and the response is small.
    const [authored, assigned] = await Promise.all([
      fj.listIssues(owner, repo, { state, q, labels, milestones, mentioned_by: mentionedBy, sort, created_by: username }),
      fj.listIssues(owner, repo, { state, q, labels, milestones, mentioned_by: mentionedBy, sort, assigned_by: username }),
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
    labels,
    milestones,
    mentioned_by: mentionedBy,
    sort,
    ...(filter === "assigned" ? { assigned_by: username } : assignedBy ? { assigned_by: assignedBy } : {}),
    ...(createdBy ? { created_by: createdBy } : {}),
  });
  return c.json({ issues: list.filter((i) => !i.pull_request).map(toIssueRow) });
});

// Typed because Forgejo returns raw issues/PRs; the public API wants
// issue-only rows.
// Must come before :number routes.
issues.get("/:owner/:repo/issues/pinned", async (c) => {
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
      author_username: userLogin(i.user),
    })),
  });
});

// Typed because public API clients consume a stable IssueDetail DTO with
// deleted-user fallback and normalized timestamps.
issues.get("/:owner/:repo/issues/:number", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  try {
    const issue = await fj.getIssue(owner, repo, number);
    if (issue.pull_request) return c.json(...notFound("not an issue"));
    const detail: IssueDetail = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      author_username: userLogin(issue.user),
      assignees: (issue.assignees ?? []).map((a) => a.login),
      labels: issue.labels.map(toLabel),
      milestone: issue.milestone ? { id: issue.milestone.id, title: issue.milestone.title } : null,
      comment_count: issue.comments,
      created_at: new Date(issue.created_at).getTime(),
      updated_at: new Date(issue.updated_at).getTime(),
      closed_at: issue.closed_at ? new Date(issue.closed_at).getTime() : null,
    };
    return c.json(detail);
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404) {
      return c.json(...notFound());
    }
    throw err;
  }
});

// Typed because issue creation emits workspace SSE and returns the compact row
// shape used by clients.
issues.post("/:owner/:repo/issues", async (c) => {
  const ws = c.get("workspace");
  const body = (await c.req.json().catch(() => null)) as {
    title?: string;
    body?: string;
    labels?: number[];
  } | null;
  if (!body?.title || !body.title.trim())
    return c.json(...bad("title required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const created = await fj.createIssue(owner, repo, {
    title: body.title.trim(),
    body: body.body ?? "",
    labels: body.labels,
  });
  c.get("sse").publish(ws.slug, { type: "issue", number: created.number, action: "opened" });
  return c.json({ number: created.number, title: created.title, state: created.state }, 201);
});

issues.patch("/:owner/:repo/issues/:number/state", async (c) => {
  const ws = c.get("workspace");
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { state?: unknown } | null;
  if (body?.state !== "open" && body?.state !== "closed") return c.json(...bad("state must be open or closed"));
  const { fj, owner, repo } = c.get("repoCtx");
  const issue = await fj.editIssue(owner, repo, number, { state: body.state });
  c.get("sse").publish(ws.slug, { type: "issue", number, action: body.state === "closed" ? "closed" : "reopened" });
  return c.json({ ok: true, state: issue.state });
});

issues.patch("/:owner/:repo/issues/:number", async (c) => {
  const ws = c.get("workspace");
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
  } | null;
  const patch: { title?: string; body?: string } = {};
  if (body?.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) return c.json(...bad("title required"));
    patch.title = body.title.trim();
  }
  if (body?.body !== undefined) {
    if (typeof body.body !== "string") return c.json(...bad("body must be a string"));
    patch.body = body.body;
  }
  if (patch.title === undefined && patch.body === undefined) return c.json(...bad("title or body required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const issue = await fj.editIssue(owner, repo, number, patch);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "edited" });
  return c.json({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  });
});

issues.get("/:owner/:repo/issues/:number/comments", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  const comments = await fj.listIssueComments(owner, repo, number);
  return c.json({ comments: comments.map(toIssueComment) });
});

issues.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body : "";
  if (!text.trim()) return c.json(...bad("comment body required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const comment = await fj.createIssueComment(owner, repo, number, text);
  c.get("sse").publish(c.get("workspace").slug, { type: "issue", number, action: "commented" });
  return c.json(toIssueComment(comment), 201);
});

issues.patch("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  const id = parseId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body : "";
  if (!text.trim()) return c.json(...bad("comment body required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const comment = await fj.editIssueComment(owner, repo, id, text);
  return c.json(toIssueComment(comment));
});

issues.delete("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  const id = parseId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.deleteIssueComment(owner, repo, id);
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/labels", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const labels = await fj.listLabels(owner, repo);
  return c.json({ labels: labels.map(toLabel) });
});

issues.post("/:owner/:repo/labels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    color?: unknown;
    description?: unknown;
    exclusive?: unknown;
  } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const color = typeof body?.color === "string" ? body.color.trim().replace(/^#/, "") : "";
  if (!name) return c.json(...bad("label name required"));
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return c.json(...bad("label color must be six hex digits"));
  const { fj, owner, repo } = c.get("repoCtx");
  const label = await fj.createLabel(owner, repo, {
    name,
    color,
    description: typeof body?.description === "string" ? body.description : undefined,
    exclusive: body?.exclusive === true,
  });
  return c.json(toLabel(label), 201);
});

issues.patch("/:owner/:repo/labels/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad label id"));
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    color?: unknown;
    description?: unknown;
    exclusive?: unknown;
  } | null;
  const patch: { name?: string; color?: string; description?: string; exclusive?: boolean } = {};
  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name) return c.json(...bad("label name cannot be empty"));
    patch.name = name;
  }
  if (typeof body?.color === "string") {
    const color = body.color.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(color)) return c.json(...bad("label color must be six hex digits"));
    patch.color = color;
  }
  if (typeof body?.description === "string") patch.description = body.description;
  if (typeof body?.exclusive === "boolean") patch.exclusive = body.exclusive;
  const { fj, owner, repo } = c.get("repoCtx");
  const label = await fj.editLabel(owner, repo, id, patch);
  return c.json(toLabel(label));
});

issues.delete("/:owner/:repo/labels/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad label id"));
  const { fj, owner, repo } = c.get("repoCtx");
  try {
    await fj.deleteLabel(owner, repo, id);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("label not found"));
    throw err;
  }
  return c.json({ ok: true });
});

issues.put("/:owner/:repo/issues/:number/labels", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { labels?: unknown } | null;
  if (!Array.isArray(body?.labels) || !body.labels.every((id) => Number.isInteger(id) && id > 0)) {
    return c.json(...bad("labels must be positive integer ids"));
  }
  const labelIds = body.labels as number[];
  const { fj, owner, repo } = c.get("repoCtx");
  const [allLabels, issue] = await Promise.all([
    fj.listLabels(owner, repo),
    fj.getIssue(owner, repo, number),
  ]);
  const validation = validateLabelSelection(labelIds, allLabels, issue.labels);
  if (!validation.ok) return c.json(...bad(validation.message));
  const labels = await fj.setIssueLabels(owner, repo, number, labelIds);
  return c.json({ labels: labels.map(toLabel) });
});

issues.post("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.pinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.delete("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.unpinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/milestones", async (c) => {
  const state = parseListState(c.req.query("state"));
  const { fj, owner, repo } = c.get("repoCtx");
  const milestones = await fj.listMilestones(owner, repo, state);
  return c.json({ milestones: milestones.map(toMilestone) });
});

issues.post("/:owner/:repo/milestones", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    description?: unknown;
  } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return c.json(...bad("milestone title required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const milestone = await fj.createMilestone(owner, repo, {
    title,
    description: typeof body?.description === "string" ? body.description : undefined,
  });
  return c.json(toMilestone(milestone), 201);
});

issues.patch("/:owner/:repo/milestones/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad milestone id"));
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    description?: unknown;
    state?: unknown;
  } | null;
  const patch: { title?: string; description?: string; state?: "open" | "closed" } = {};
  if (typeof body?.title === "string") {
    const title = body.title.trim();
    if (!title) return c.json(...bad("milestone title cannot be empty"));
    patch.title = title;
  }
  if (typeof body?.description === "string") patch.description = body.description;
  if (body?.state === "open" || body?.state === "closed") patch.state = body.state;
  const { fj, owner, repo } = c.get("repoCtx");
  const milestone = await fj.editMilestone(owner, repo, id, patch);
  return c.json(toMilestone(milestone));
});

issues.delete("/:owner/:repo/milestones/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad milestone id"));
  const { fj, owner, repo } = c.get("repoCtx");
  try {
    await fj.deleteMilestone(owner, repo, id);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("milestone not found"));
    throw err;
  }
  return c.json({ ok: true });
});

issues.patch("/:owner/:repo/issues/:number/milestone", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
  const milestoneId = body?.id;
  if (milestoneId !== null && !Number.isInteger(milestoneId)) return c.json(...bad("milestone id must be an integer or null"));
  const { fj, owner, repo } = c.get("repoCtx");
  await fj.editIssue(owner, repo, number, { milestone: milestoneId === null ? 0 : milestoneId as number });
  return c.json({ ok: true });
});

issues.post("/:owner/:repo/markdown/render", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const { fj, owner, repo } = c.get("repoCtx");
  const html = await fj.renderMarkdown(owner, repo, text);
  return c.json({ html });
});

// Typed because Forgejo's dependency mutation body redundantly requires the
// owner/repo, which clients should not know.
issues.get("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listIssueDependencies(owner, repo, number);
  return c.json({ issues: list.map(toDependencyRow) });
});

issues.get("/:owner/:repo/issues/:number/blocks", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  const list = await fj.listIssueBlocks(owner, repo, number);
  return c.json({ issues: list.map(toDependencyRow) });
});

issues.post("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { index?: unknown } | null;
  const index = parseIssueNumber(body?.index);
  if (index === null) {
    return c.json(...bad("dependency issue number required"));
  }
  if (index === number) return c.json(...bad("issue cannot depend on itself"));
  const { fj, owner, repo } = c.get("repoCtx");
  const updated = await fj.addIssueDependency(owner, repo, number, index);
  return c.json({ issue: toDependencyRow(updated) }, 201);
});

issues.delete("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = (await c.req.json().catch(() => null)) as { index?: unknown } | null;
  const index = parseIssueNumber(body?.index);
  if (index === null) {
    return c.json(...bad("dependency issue number required"));
  }
  const { fj, owner, repo } = c.get("repoCtx");
  const updated = await fj.removeIssueDependency(owner, repo, number, index);
  return c.json({ issue: toDependencyRow(updated) });
});

// Typed because Forgejo activities encode references in JSON-ish strings;
// clients get parsed issue refs and normalized timestamps.
issues.get("/:owner/:repo/activities", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
  const { fj, owner, repo } = c.get("repoCtx");
  const raw = await fj.listRepoActivities(owner, repo, { limit });
  const safe = collapseNoisyEditBranchCommits(raw ?? []);
  return c.json({
    activities: safe.map<ActivityRow>((item) => {
      const a = item.activity;
      // Forgejo encodes content as a JSON array string for many op_types.
      // For comment_*: ["<issue_index>","<body>"]
      // For close_issue, reopen_issue, etc: often just "<issue_index>" or
      // similar — keep raw and let the client parse what it can.
      let refIndex: number | null = null;
      let body: string | null = null;
      let commit = item.commit;
      if (a.content) {
        try {
          const parsed = parseActivityContent(a.content);
          commit ??= activityCommitRef(parsed);
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
        author_username: a.act_user?.login ?? null,
        ref_index: refIndex,
        ref_name: a.ref_name ?? null,
        comment_body: body,
        commit_sha: commit?.sha ?? null,
        commit_message: commit?.message ?? null,
        repeat_count: item.repeatCount,
        created_at: new Date(a.created).getTime(),
      };
    }),
  });
});

// Typed because public API clients use a narrowed event DTO with normalized
// label/milestone/dependency references.
issues.get("/:owner/:repo/issues/:number/timeline", async (c) => {
  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = c.get("repoCtx");
  const events = await fj.listIssueTimeline(owner, repo, number);
  // Forgejo returns null instead of [] for some empty issue timelines.
  const safe = events ?? [];
  return c.json({
    events: safe.map<TimelineEvent>((e) => ({
      id: e.id,
      type: e.type,
      author_username: e.user?.login ?? null,
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
