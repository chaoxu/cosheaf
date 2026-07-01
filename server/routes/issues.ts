import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type {
  ActivityRow,
  IssueComment,
  IssueDetail,
  IssueRow,
} from "../../shared/issues.js";
import { activityCommitRef, collapseNoisyEditBranchCommits, parseActivityContent } from "../activity-feed.js";
import { is404 } from "../forgejo-errors.js";
import { toEpochMs } from "../forgejo-types.js";
import {
  activeClaims,
  activeClaimsByIssue,
  claimIssue,
  claimTtlMs,
  heartbeatClaim,
  releaseClaim,
} from "../issue-claims.js";
import { repoCtxCollab, requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { normalizeLabelColor, parsePositiveLabelIds, validateLabelSelection } from "./label-utils.js";
import { parseBoundedPositiveInt, parseListState, parsePositiveIntId, parseTitleBodyPatch, readJsonBody, readJsonObject, requireCommentBody } from "./query-params.js";
import { bad, conflict, notFound } from "./responses.js";
import { scrubBackendUrls, wantsTeaShape } from "./tea-compat.js";

async function requireTypedIssue(c: Context<AppEnv>, number: number): Promise<IssueDetail | Response> {
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    return await collab.getIssue(owner, repo, number);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("issue not found"));
    throw err;
  }
}

async function requireIssueComment(c: Context<AppEnv>, number: number, id: number): Promise<IssueComment | Response> {
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const comments = await collab.listIssueComments(owner, repo, number);
  const comment = comments.find((item) => item.id === id);
  return comment ?? c.json(...notFound("comment not found"));
}

function trimmedQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function teaIssueRow(row: IssueRow): Record<string, unknown> {
  const teaIso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  return {
    ...row,
    updated_at: teaIso(row.updated_at),
    created_at: teaIso(row.created_at),
  };
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

const issueCommentMutationRe = /\/issues\/(?:\d+\/comments(?:\/\d+)?|comments\/\d+)$/;

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
  const { collab, owner, repo } = repoCtxCollab(c);
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
      collab.listIssues(owner, repo, { state, q, labels, milestones, mentioned_by: mentionedBy, sort, created_by: username }),
      collab.listIssues(owner, repo, { state, q, labels, milestones, mentioned_by: mentionedBy, sort, assigned_by: username }),
    ]);
    if (wantsTeaShape(c)) {
      const byNum = new Map<number, IssueRow>();
      for (const i of [...authored, ...assigned]) byNum.set(i.number, i);
      const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
      return c.json(scrubBackendUrls(c, merged.map(teaIssueRow)));
    }
    const byNum = new Map<number, IssueRow>();
    for (const i of [...authored, ...assigned]) byNum.set(i.number, i);
    const merged = Array.from(byNum.values()).sort((a, b) => b.updated_at - a.updated_at);
    const rows = attachClaims(c, merged);
    return c.json({ issues: rows });
  }
  const list = await collab.listIssues(owner, repo, {
    state,
    q,
    labels,
    milestones,
    mentioned_by: mentionedBy,
    sort,
    ...(filter === "assigned" ? { assigned_by: username } : assignedBy ? { assigned_by: assignedBy } : {}),
    ...(createdBy ? { created_by: createdBy } : {}),
  });
  const issueList = list;
  if (wantsTeaShape(c)) return c.json(scrubBackendUrls(c, issueList.map(teaIssueRow)));
  return c.json({ issues: attachClaims(c, issueList) });
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const list = await collab.listPinnedIssues(owner, repo);
  return c.json({
    issues: list,
  });
});

// Typed because public API clients consume a stable IssueDetail DTO with
// deleted-user fallback and normalized timestamps.
issues.get("/:owner/:repo/issues/:number", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  try {
    const issue = await collab.getIssue(owner, repo, number);
    const detail: IssueDetail = { ...issue };
    const claims = activeClaims(c.get("db"), c.get("workspace").slug, number, Date.now());
    if (claims.length) detail.claims = claims;
    return c.json(detail);
  } catch (err) {
    // Status-bearing so a missing issue 404s identically in hosted (ForgejoError)
    // and local Workbench (RemoteCosheafError) modes, not a 500.
    if (is404(err)) {
      return c.json(...notFound());
    }
    throw err;
  }
});

// Optional advisory live-work lease so runners attached to this server/sidecar
// can avoid duplicate work (#95). This is local coordination state, not durable
// issue ownership or cross-server collaboration authority.
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const created = await collab.createIssue(owner, repo, {
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const issue = await collab.editIssue(owner, repo, number, { state: body.state });
  c.get("sse").publish(ws.slug, { type: "issue", number, action: body.state === "closed" ? "closed" : "reopened" });
  return c.json({ ok: true, state: issue.state });
});

issues.patch("/:owner/:repo/issues/:number", async (c) => {
  const ws = c.get("workspace");
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const parsed = parseTitleBodyPatch(body);
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const assignees =
    body.assignees === undefined
      ? undefined
      : Array.isArray(body.assignees) && body.assignees.every((item) => typeof item === "string")
        ? body.assignees
        : null;
  if (assignees === null) return c.json(...bad("assignees must be an array of usernames"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const issue = await collab.editIssue(owner, repo, number, {
    ...parsed.patch,
    ...(assignees !== undefined ? { assignees } : {}),
  });
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const comments = await collab.listIssueComments(owner, repo, number);
  return c.json({ comments });
});

issues.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const comment = await collab.createIssueComment(owner, repo, number, text);
  c.get("sse").publish(c.get("workspace").slug, { type: "issue", number, action: "commented" });
  return c.json(comment, 201);
});

issues.patch("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  const id = parsePositiveIntId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireIssueComment(c, number, id);
  if (target instanceof Response) return target;
  const comment = await collab.editIssueComment(owner, repo, id, text);
  return c.json(comment);
});

issues.delete("/:owner/:repo/issues/:number/comments/:id", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  const id = parsePositiveIntId(c.req.param("id"));
  if (number === null) return c.json(...bad("bad number"));
  if (id === null) return c.json(...bad("bad comment id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireIssueComment(c, number, id);
  if (target instanceof Response) return target;
  await collab.deleteIssueComment(owner, repo, id);
  return c.json({ ok: true });
});

// Number-less comment edit/delete. The forge addresses a comment by id alone
// (issues/comments/:id), so a client that holds only the comment id (the local
// Workbench's OriginCollaborationClient) can target it without the issue number.
// The number-scoped routes above stay for clients that have the number and want
// the cross-issue safety check; here Forgejo enforces author/admin rights on the
// mutation and that the comment belongs to this repo.
issues.patch("/:owner/:repo/issues/comments/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad comment id"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    const comment = await collab.editIssueComment(owner, repo, id, parsed.text);
    return c.json(comment);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("comment not found"));
    throw err;
  }
});

issues.delete("/:owner/:repo/issues/comments/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad comment id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    await collab.deleteIssueComment(owner, repo, id);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("comment not found"));
    throw err;
  }
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/labels", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const labels = await collab.listLabels(owner, repo);
  return c.json({ labels });
});

issues.post("/:owner/:repo/labels", async (c) => {
  const body = await readJsonObject(c.req);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const color = normalizeLabelColor(typeof body?.color === "string" ? body.color : "");
  if (!name) return c.json(...bad("label name required"));
  if (color === null) return c.json(...bad("label color must be six hex digits"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const label = await collab.createLabel(owner, repo, {
    name,
    color,
    description: typeof body?.description === "string" ? body.description : undefined,
    exclusive: body?.exclusive === true,
  });
  return c.json(label, 201);
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const label = await collab.editLabel(owner, repo, id, patch);
  return c.json(label);
});

issues.delete("/:owner/:repo/labels/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad label id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    await collab.deleteLabel(owner, repo, id);
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const issue = await requireTypedIssue(c, number);
  if (issue instanceof Response) return issue;
  const allLabels = await collab.listLabels(owner, repo);
  const validation = validateLabelSelection(labelIds, allLabels, issue.labels);
  if (!validation.ok) return c.json(...bad(validation.message));
  const labels = await collab.setIssueLabels(owner, repo, number, labelIds);
  return c.json({ labels });
});

issues.post("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await collab.pinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.delete("/:owner/:repo/issues/:number/pin", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await collab.unpinIssue(owner, repo, number);
  return c.json({ ok: true });
});

issues.get("/:owner/:repo/milestones", async (c) => {
  const state = parseListState(c.req.query("state"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const milestones = await collab.listMilestones(owner, repo, state);
  return c.json({ milestones });
});

issues.post("/:owner/:repo/milestones", async (c) => {
  const body = await readJsonObject(c.req);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return c.json(...bad("milestone title required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const milestone = await collab.createMilestone(owner, repo, {
    title,
    description: typeof body?.description === "string" ? body.description : undefined,
  });
  return c.json(milestone, 201);
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const milestone = await collab.editMilestone(owner, repo, id, patch);
  return c.json(milestone);
});

issues.delete("/:owner/:repo/milestones/:id", async (c) => {
  const id = parsePositiveIntId(c.req.param("id"));
  if (id === null) return c.json(...bad("bad milestone id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    await collab.deleteMilestone(owner, repo, id);
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await collab.editIssue(owner, repo, number, { milestone: milestoneId });
  return c.json({ ok: true });
});

issues.post("/:owner/:repo/markdown/render", async (c) => {
  const body = await readJsonObject(c.req);
  const text = typeof body?.text === "string" ? body.text : "";
  const { collab, owner, repo } = repoCtxCollab(c);
  const html = await collab.renderMarkdown(owner, repo, text);
  return c.json({ html });
});

// Typed because Forgejo's dependency mutation body redundantly requires the
// owner/repo, which clients should not know.
issues.get("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const list = await collab.listIssueDependencies(owner, repo, number);
  return c.json({ issues: list });
});

issues.get("/:owner/:repo/issues/:number/blocks", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const list = await collab.listIssueBlocks(owner, repo, number);
  return c.json({ issues: list });
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const updated = await collab.addIssueDependency(owner, repo, number, index);
  return c.json({ issue: updated }, 201);
});

issues.delete("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const index = parsePositiveIntId(body.index);
  if (index === null) {
    return c.json(...bad("dependency issue number required"));
  }
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  const updated = await collab.removeIssueDependency(owner, repo, number, index);
  return c.json({ issue: updated });
});

// Remove a "blocks" edge. Mirrors the dependency DELETE convention (blocking
// issue number in the body); the forge's removeIssueBlock returns void, so the
// response is a bare ok.
issues.delete("/:owner/:repo/issues/:number/blocks", async (c) => {
  const number = parsePositiveIntId(c.req.param("number"));
  if (number === null) return c.json(...bad("bad number"));
  const body = await readJsonObject(c.req);
  const index = parsePositiveIntId(body.index);
  if (index === null) {
    return c.json(...bad("block issue number required"));
  }
  const { collab, owner, repo } = repoCtxCollab(c);
  const target = await requireTypedIssue(c, number);
  if (target instanceof Response) return target;
  await collab.removeIssueBlock(owner, repo, number, index);
  return c.json({ ok: true });
});

// Typed because Forgejo activities encode references in JSON-ish strings;
// clients get parsed issue refs and normalized timestamps.
issues.get("/:owner/:repo/activities", async (c) => {
  const limit = parseBoundedPositiveInt(c.req.query("limit"), 50, 100);
  const { collab, owner, repo } = repoCtxCollab(c);
  const raw = await collab.listRepoActivities(owner, repo, { limit });
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
  const { collab, owner, repo } = repoCtxCollab(c);
  const events = await collab.listIssueTimeline(owner, repo, number);
  // Forgejo returns null instead of [] for some empty issue timelines.
  const safe = events ?? [];
  return c.json({
    events: safe,
  });
});
