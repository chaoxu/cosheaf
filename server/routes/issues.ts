import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types.js";
import { repoCtxForgejo, requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { is404 } from "../forgejo-errors.js";
import {
  activeClaims,
  activeClaimsByIssue,
  claimIssue,
  claimTtlMs,
  heartbeatClaim,
  releaseClaim,
} from "../issue-claims.js";
import { activityCommitRef, collapseNoisyEditBranchCommits, parseActivityContent } from "../activity-feed.js";
import {
  type ForgejoIssue,
  type ForgejoIssueComment,
  type ForgejoMilestone,
  type ForgejoTimelineEvent,
  toEpochMs,
  toEpochMsOrNull,
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
import { normalizeLabelColor, parsePositiveLabelIds, toLabel, validateLabelSelection } from "./label-utils.js";
import { bad, conflict, notFound } from "./responses.js";
import { parseBoundedPositiveInt, parseListState, parsePositiveIntId, parseTitleBodyPatch, readJsonBody, readJsonObject, requireCommentBody } from "./query-params.js";
import { scrubBackendUrls, wantsTeaShape } from "./tea-compat.js";

function toIssueRow(i: ForgejoIssue): IssueRow {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    author_username: userLogin(i.user),
    labels: i.labels.map(toLabel),
    comment_count: i.comments,
    created_at: toEpochMs(i.created_at),
    updated_at: toEpochMs(i.updated_at),
  };
}

function toIssueComment(cm: ForgejoIssueComment): IssueComment {
  return {
    id: cm.id,
    body: cm.body,
    author_username: userLogin(cm.user),
    created_at: toEpochMs(cm.created_at),
    updated_at: toEpochMs(cm.updated_at),
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
    due_on: toEpochMsOrNull(milestone.due_on),
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

async function requireTypedIssue(c: Context<AppEnv>, number: number): Promise<ForgejoIssue | Response> {
  const { fj, owner, repo } = repoCtxForgejo(c);
  try {
    const issue = await fj.getIssue(owner, repo, number);
    return issue.pull_request ? c.json(...notFound("issue not found")) : issue;
  } catch (err) {
    if (is404(err)) return c.json(...notFound("issue not found"));
    throw err;
  }
}

async function requireIssueComment(c: Context<AppEnv>, number: number, id: number): Promise<ForgejoIssueComment | Response> {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const comments = await fj.listIssueComments(owner, repo, number);
  const comment = comments.find((item) => item.id === id);
  return comment ?? c.json(...notFound("comment not found"));
}

// Normalize a timeline event's `ref_issue` into the public causality sub-shape.
// Forgejo serializes it as a full Issue object on ref events (with a
// `pull_request` field when the ref is a PR) and as a bare number / 0 / absent
// elsewhere — be defensive about both, mirroring web-timeline's number-or-object
// read. `is_pull`/`pull_merged` let an agent tell a closing PR from a plain
// issue reference (#93).
function toRefIssue(
  ref: ForgejoTimelineEvent["ref_issue"],
): TimelineEvent["ref_issue"] {
  if (!ref || typeof ref !== "object") return null;
  return {
    number: ref.number,
    title: ref.title ?? null,
    state: ref.state ?? null,
    is_pull: ref.pull_request != null,
    pull_merged: ref.pull_request ? ref.pull_request.merged ?? false : null,
  };
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

const issueCommentMutationRe = /\/issues\/\d+\/comments(?:\/\d+)?$/;

const requireIssueWriteOnMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && issueCommentMutationRe.test(c.req.path)) {
    await next();
    return;
  }
  return requireWriteOnMutation(c, next);
};

export const issues = new Hono<AppEnv>();
issues.use("*", requireAuth);
issues.use("/:owner/:repo/*", requireMembership());
issues.use("/:owner/:repo/*", requireIssueWriteOnMutation);

// Typed because the public API needs an issue-only row shape and "mine"
// composes two Forgejo filters (created_by OR assigned_by).
issues.get("/:owner/:repo/issues", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
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
    if (wantsTeaShape(c)) {
      const byNum = new Map<number, ForgejoIssue>();
      for (const i of [...authored, ...assigned]) {
        if (!i.pull_request) byNum.set(i.number, i);
      }
      const merged = Array.from(byNum.values()).sort((a, b) => toEpochMs(b.updated_at) - toEpochMs(a.updated_at));
      return c.json(scrubBackendUrls(c, merged));
    }
    const byNum = new Map<number, IssueRow>();
    for (const i of [...authored, ...assigned]) {
      if (!i.pull_request) byNum.set(i.number, toIssueRow(i));
    }
    const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
    const rows = attachClaims(c, merged);
    return c.json({ issues: rows });
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
  const issueList = list.filter((i) => !i.pull_request);
  if (wantsTeaShape(c)) return c.json(scrubBackendUrls(c, issueList));
  return c.json({ issues: attachClaims(c, issueList.map(toIssueRow)) });
});

// Decorate issue rows with their active live-work leases (#95) in one batched
// query; rows with no claim are left untouched (the field is optional).
function attachClaims(c: Context<AppEnv>, rows: IssueRow[]): IssueRow[] {
  const claimsByNum = activeClaimsByIssue(c.get("db"), c.get("workspace").slug, rows.map((r) => r.number), Date.now());
  for (const row of rows) {
    const claims = claimsByNum.get(row.number);
    if (claims?.length) row.claims = claims;
  }
  return rows;
}

// Typed because Forgejo returns raw issues/PRs; the public API wants
// issue-only rows.
// Must come before :number routes.
issues.get("/:owner/:repo/issues/pinned", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const list = await fj.listPinnedIssues(owner, repo);
  const issuesOnly = list.filter((i) => !i.pull_request);
  return c.json({
    issues: issuesOnly.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      comment_count: i.comments,
      updated_at: toEpochMs(i.updated_at),
      author_username: userLogin(i.user),
    })),
  });
});

// Typed because public API clients consume a stable IssueDetail DTO with
// deleted-user fallback and normalized timestamps.
issues.get("/:owner/:repo/issues/:number", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const number = parsePositiveIntId(c.req.param("number"));
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
      created_at: toEpochMs(issue.created_at),
      updated_at: toEpochMs(issue.updated_at),
      closed_at: toEpochMsOrNull(issue.closed_at),
    };
    const claims = activeClaims(c.get("db"), c.get("workspace").slug, number, Date.now());
    if (claims.length) detail.claims = claims;
    return c.json(detail);
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404) {
      return c.json(...notFound());
    }
    throw err;
  }
});

// Optional advisory live-work lease so concurrent runners don't duplicate work
// (#95). Exclusive per (workspace, issue): a second runner gets 409 with the
// active claim. Ephemeral local coordination state — not durable knowledge,
// issue assignment, or server authority.
issues.post("/:owner/:repo/issues/:number/claim", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const runnerName = typeof body.runner_name === "string" ? body.runner_name.trim() : "";
  if (!runnerName) return c.json(...bad("runner_name required"));
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const purpose = typeof body.purpose === "string" ? body.purpose.slice(0, 500) : "";
  const now = Date.now();
  const result = claimIssue(c.get("db"), {
    slug: c.get("workspace").slug,
    issueNumber: number,
    runnerName,
    purpose,
    holder: c.get("user").username,
    ttlMs: claimTtlMs(body, now),
    now,
  });
  if (!result.ok) return c.json(...conflict("issue already claimed", { claim: result.conflict }));
  return c.json({ claim: result.claim }, 201);
});

issues.patch("/:owner/:repo/issues/:number/claim/:id/heartbeat", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const now = Date.now();
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const claim = heartbeatClaim(c.get("db"), {
    slug: c.get("workspace").slug,
    issueNumber: number,
    id: c.req.param("id"),
    ttlMs: claimTtlMs(body, now),
    now,
  });
  if (!claim) return c.json(...notFound("claim not found or expired"));
  return c.json({ claim });
});

issues.delete("/:owner/:repo/issues/:number/claim/:id", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const released = releaseClaim(c.get("db"), {
    slug: c.get("workspace").slug,
    issueNumber: number,
    id: c.req.param("id"),
  });
  return c.json({ ok: released });
});

// Typed because issue creation emits workspace SSE and returns the compact row
// shape used by clients.
issues.post("/:owner/:repo/issues", async (c) => {
  const ws = c.get("workspace");
  const body = await readJsonObject(c.req);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title)
    return c.json(...bad("title required"));
  if (body?.body !== undefined && typeof body.body !== "string") {
    return c.json(...bad("body must be a string"));
  }
  const labels = body?.labels === undefined ? undefined : parsePositiveLabelIds(body.labels);
  if (body?.labels !== undefined && labels === null) {
    return c.json(...bad("labels must be positive integer ids"));
  }
  const { fj, owner, repo } = repoCtxForgejo(c);
  const created = await fj.createIssue(owner, repo, {
    title,
    body: typeof body?.body === "string" ? body.body : "",
    labels: labels ?? undefined,
  });
  c.get("sse").publish(ws.slug, { type: "issue", number: created.number, action: "opened" });
  return c.json({ number: created.number, title: created.title, state: created.state }, 201);
});

issues.patch("/:owner/:repo/issues/:number/state", async (c) => {
  const ws = c.get("workspace");
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  if (body?.state !== "open" && body?.state !== "closed") return c.json(...bad("state must be open or closed"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const issue = await fj.editIssue(owner, repo, number, { state: body.state });
  c.get("sse").publish(ws.slug, { type: "issue", number, action: body.state === "closed" ? "closed" : "reopened" });
  return c.json({ ok: true, state: issue.state });
});

issues.patch("/:owner/:repo/issues/:number", async (c) => {
  const ws = c.get("workspace");
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const parsed = parseTitleBodyPatch(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const issue = await fj.editIssue(owner, repo, number, parsed.patch);
  c.get("sse").publish(ws.slug, { type: "issue", number, action: "edited" });
  return c.json({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  });
});

issues.get("/:owner/:repo/issues/:number/comments", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const comments = await fj.listIssueComments(owner, repo, number);
  return c.json({ comments: comments.map(toIssueComment) });
});

issues.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const comment = await fj.createIssueComment(owner, repo, number, text);
  c.get("sse").publish(c.get("workspace").slug, { type: "issue", number, action: "commented" });
  return c.json(toIssueComment(comment), 201);
});

issues.patch("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  const id = parsePositiveIntId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireIssueComment(c, number, id);
  if (target instanceof Response) return target;
  const comment = await fj.editIssueComment(owner, repo, id, text);
  return c.json(toIssueComment(comment));
});

issues.delete("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  const id = parsePositiveIntId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireIssueComment(c, number, id);
  if (target instanceof Response) return target;
  await fj.deleteIssueComment(owner, repo, id);
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/labels", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const labels = await fj.listLabels(owner, repo);
  return c.json({ labels: labels.map(toLabel) });
});

issues.post("/:owner/:repo/labels", async (c) => {
  const body = await readJsonObject(c.req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const color = normalizeLabelColor(typeof body?.color === "string" ? body.color : "");
  if (!name) return c.json(...bad("label name required"));
  if (color === null) return c.json(...bad("label color must be six hex digits"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const label = await fj.createLabel(owner, repo, {
    name,
    color,
    description: typeof body?.description === "string" ? body.description : undefined,
    exclusive: body?.exclusive === true,
  });
  return c.json(toLabel(label), 201);
});

issues.patch("/:owner/:repo/labels/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad label id"));
  const body = await readJsonObject(c.req);
  const patch: { name?: string; color?: string; description?: string; exclusive?: boolean } = {};
  if (typeof body?.name === "string") {
    const name = body.name.trim();
    if (!name) return c.json(...bad("label name cannot be empty"));
    patch.name = name;
  }
  if (typeof body?.color === "string") {
    const color = normalizeLabelColor(body.color);
    if (color === null) return c.json(...bad("label color must be six hex digits"));
    patch.color = color;
  }
  if (typeof body?.description === "string") patch.description = body.description;
  if (typeof body?.exclusive === "boolean") patch.exclusive = body.exclusive;
  if (Object.keys(patch).length === 0) return c.json(...bad("label field required"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const label = await fj.editLabel(owner, repo, id, patch);
  return c.json(toLabel(label));
});

issues.delete("/:owner/:repo/labels/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad label id"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  try {
    await fj.deleteLabel(owner, repo, id);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("label not found"));
    throw err;
  }
  return c.json({ ok: true });
});

issues.put("/:owner/:repo/issues/:number/labels", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const labelIds = parsePositiveLabelIds(body.labels);
  if (labelIds === null) {
    return c.json(...bad("labels must be positive integer ids"));
  }
  const { fj, owner, repo } = repoCtxForgejo(c);
  const issue = await requireTypedIssue(c, number);
  if (issue instanceof Response) return issue;
  const allLabels = await fj.listLabels(owner, repo);
  const validation = validateLabelSelection(labelIds, allLabels, issue.labels);
  if (!validation.ok) return c.json(...bad(validation.message));
  const labels = await fj.setIssueLabels(owner, repo, number, labelIds);
  return c.json({ labels: labels.map(toLabel) });
});

issues.post("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await fj.pinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.delete("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await fj.unpinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/milestones", async (c) => {
  const state = parseListState(c.req.query("state"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const milestones = await fj.listMilestones(owner, repo, state);
  return c.json({ milestones: milestones.map(toMilestone) });
});

issues.post("/:owner/:repo/milestones", async (c) => {
  const body = await readJsonObject(c.req);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return c.json(...bad("milestone title required"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const milestone = await fj.createMilestone(owner, repo, {
    title,
    description: typeof body?.description === "string" ? body.description : undefined,
  });
  return c.json(toMilestone(milestone), 201);
});

issues.patch("/:owner/:repo/milestones/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad milestone id"));
  const body = await readJsonObject(c.req);
  const patch: { title?: string; description?: string; state?: "open" | "closed" } = {};
  if (typeof body?.title === "string") {
    const title = body.title.trim();
    if (!title) return c.json(...bad("milestone title cannot be empty"));
    patch.title = title;
  }
  if (typeof body?.description === "string") patch.description = body.description;
  if (body?.state === "open" || body?.state === "closed") patch.state = body.state;
  if (Object.keys(patch).length === 0) return c.json(...bad("milestone field required"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const milestone = await fj.editMilestone(owner, repo, id, patch);
  return c.json(toMilestone(milestone));
});

issues.delete("/:owner/:repo/milestones/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad milestone id"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  try {
    await fj.deleteMilestone(owner, repo, id);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("milestone not found"));
    throw err;
  }
  return c.json({ ok: true });
});

issues.patch("/:owner/:repo/issues/:number/milestone", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const milestoneId = body.id === null ? 0 : typeof body.id === "number" ? parsePositiveIntId(body.id) : null;
  if (milestoneId === null) return c.json(...bad("milestone id must be a positive integer or null"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await fj.editIssue(owner, repo, number, { milestone: milestoneId });
  return c.json({ ok: true });
});

issues.post("/:owner/:repo/markdown/render", async (c) => {
  const body = await readJsonObject(c.req);
  const text = typeof body?.text === "string" ? body.text : "";
  const { fj, owner, repo } = repoCtxForgejo(c);
  const html = await fj.renderMarkdown(owner, repo, text);
  return c.json({ html });
});

// Typed because Forgejo's dependency mutation body redundantly requires the
// owner/repo, which clients should not know.
issues.get("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const list = await fj.listIssueDependencies(owner, repo, number);
  return c.json({ issues: list.map(toDependencyRow) });
});

issues.get("/:owner/:repo/issues/:number/blocks", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const list = await fj.listIssueBlocks(owner, repo, number);
  return c.json({ issues: list.map(toDependencyRow) });
});

issues.post("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const index = parsePositiveIntId(body.index);
  if (index === null) {
    return c.json(...bad("dependency issue number required"));
  }
  if (index === number) return c.json(...bad("issue cannot depend on itself"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const updated = await fj.addIssueDependency(owner, repo, number, index);
  return c.json({ issue: toDependencyRow(updated) }, 201);
});

issues.delete("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const index = parsePositiveIntId(body.index);
  if (index === null) {
    return c.json(...bad("dependency issue number required"));
  }
  const { fj, owner, repo } = repoCtxForgejo(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const updated = await fj.removeIssueDependency(owner, repo, number, index);
  return c.json({ issue: toDependencyRow(updated) });
});

// Typed because Forgejo activities encode references in JSON-ish strings;
// clients get parsed issue refs and normalized timestamps.
issues.get("/:owner/:repo/activities", async (c) => {
  const limit = parseBoundedPositiveInt(c.req.query("limit"), 50, 100);
  const { fj, owner, repo } = repoCtxForgejo(c);
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
        created_at: toEpochMs(a.created),
      };
    }),
  });
});

// Typed because public API clients use a narrowed event DTO with normalized
// label/milestone/dependency references.
issues.get("/:owner/:repo/issues/:number/timeline", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const events = await fj.listIssueTimeline(owner, repo, number);
  // Forgejo returns null instead of [] for some empty issue timelines.
  const safe = events ?? [];
  return c.json({
    events: safe.map<TimelineEvent>((e) => ({
      id: e.id,
      type: e.type,
      author_username: e.user?.login ?? null,
      body: e.body ?? null,
      created_at: toEpochMs(e.created_at),
      updated_at: toEpochMsOrNull(e.updated_at),
      label: e.label ? { name: e.label.name, color: e.label.color } : null,
      old_title: e.old_title ?? null,
      new_title: e.new_title ?? null,
      assignee: e.assignee?.login ?? null,
      removed_assignee: e.removed_assignee ?? false,
      ref_issue: toRefIssue(e.ref_issue),
      ref_action: e.ref_action ?? null,
      ref_commit_sha: e.ref_commit_sha ?? null,
      milestone: e.milestone?.title ?? null,
      dependent_issue: e.dependent_issue
        ? { number: e.dependent_issue.number, title: e.dependent_issue.title, state: e.dependent_issue.state }
        : null,
    })),
  });
});
