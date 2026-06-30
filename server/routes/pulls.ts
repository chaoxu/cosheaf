// Pull-request surface. All workflow state lives on Forgejo; this route
// only translates cosheaf paths to Forgejo REST calls and shapes responses
// for the client.
//
// Endpoints under /:owner/:repo/* :
//   POST   /pulls                           — open a PR
//   GET    /pulls?state=                    — list PR metadata
//   GET    /pulls/:n                        — PR metadata
//   POST   /pulls/:n/merge                  — merge a PR (admin only)
//   POST   /pulls/:n/close                  — close a PR (no merge)
//   POST   /pulls/:n/reopen                 — reopen a closed PR
//   GET    /pulls/:n/files                  — per-file diff structured
//   GET    /pulls/:n/file?path=&side=       — raw file at base or head SHA
//   GET    /pulls/:n/reviews                — flat list of reviews
//   POST   /pulls/:n/reviews                — submit a review (event + body)
//   GET    /pulls/:n/comments               — line-comments flattened
//   POST   /pulls/:n/comments               — add a single line-comment
//   PATCH  /pulls/:n/comments/:cid          — edit a comment body
//   DELETE /pulls/:n/comments/:cid?review_id=
//   POST   /pulls/:n/pending-review           — find-or-create PENDING review
//   POST   /pulls/:n/pending-review/:rid/comments
//   POST   /pulls/:n/pending-review/:rid/submit
//
//   GET    /settings                        — { min_approvals }
//   PUT    /settings                        — admin only
//
// Branches live in routes/branches.ts.

import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { LineComment } from "../../shared/comments.js";
import { isDocumentFormatId, normalizeDocumentFormatId } from "../../shared/document-format.js";
import type { RepoCollaborator } from "../../shared/repo.js";
import type { MergeFailure, MergeFailureReason, PrCommit, PrFileStatus, PrMeta, PrState } from "../../shared/review.js";
import { validBranchName } from "../branch-path.js";
import type { CollaborationClient } from "../collaboration-client.js";
import { fileLineToWritePosition, resolveLineComment } from "../diff-position.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { type Forgejo, ForgejoError, mergePullWithRetry } from "../forgejo.js";
import type { ForgejoPull, ForgejoPullReviewComment, ForgejoReview } from "../forgejo-types.js";
import { toEpochMs, toEpochMsOrNull, userLogin } from "../forgejo-types.js";
import { allDocumentFormats } from "../format-registry.js";
import {
  repoCtxCollab,
  repoCtxForgejo,
  requireAdminFresh,
  requireAuth,
  requireMembership,
  requireWriteOnMutation,
} from "../middleware.js";
import { prSideRefAndPath } from "../pr-side.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { lockedReindexWorkspaceFromForgejo, setWorkspaceFormatTopic } from "../workspace-provisioning.js";
import { safeRel } from "./files.js";
import { parsePositiveLabelIds, toLabel, validateLabelSelection } from "./label-utils.js";
import { parseListState, parsePositiveInt, parsePositiveIntId, parsePositiveIntList, parseTitleBodyPatch, readJsonBody, readJsonObject, requireCommentBody } from "./query-params.js";
import { scrubBackendUrls, wantsTeaShape } from "./tea-compat.js";

export const pulls = new Hono<AppEnv>();
pulls.use("*", requireAuth);
pulls.use("/:owner/:repo/*", requireMembership());

const pullDiscussionMutationRe = /\/pulls\/\d+\/(?:reviews|comments(?:\/\d+)?)$/;

const requirePullWriteOnMutation: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && pullDiscussionMutationRe.test(c.req.path)) {
    await next();
    return;
  }
  return requireWriteOnMutation(c, next);
};

pulls.use("/:owner/:repo/*", requirePullWriteOnMutation);

import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { bad, conflict, forbidden, notFound } from "./responses.js";

function normalizeStatus(s: string): PrFileStatus {
  if (s === "added" || s === "modified" || s === "deleted" || s === "renamed" || s === "copied") return s;
  return "modified";
}

function prMeta(pull: ForgejoPull): PrMeta {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state === "closed" ? "closed" : "open",
    merged: pull.merged ?? false,
    author_username: userLogin(pull.user),
    created_at: toEpochMs(pull.created_at),
    merged_at: toEpochMsOrNull(pull.merged_at),
    mergeable: pull.mergeable ?? null,
    head_ref: pull.head.ref,
    head_sha: pull.head.sha,
    base_ref: pull.base.ref,
    base_sha: pull.base.sha,
    additions_total: pull.additions ?? 0,
    deletions_total: pull.deletions ?? 0,
    files_changed: pull.changed_files ?? 0,
    labels: (pull.labels ?? []).map(toLabel),
    milestone: pull.milestone ? { id: pull.milestone.id, title: pull.milestone.title } : null,
    requested_reviewers: (pull.requested_reviewers ?? []).map((u) => u.login),
    requested_reviewer_teams: (pull.requested_reviewers_teams ?? []).map((t) => t.username ?? t.name),
  };
}

type PullSort = "oldest" | "recentupdate" | "recentclose" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";

function parsePullSort(value: string | undefined): PullSort {
  const allowed = new Set(["oldest", "recentupdate", "recentclose", "leastupdate", "mostcomment", "leastcomment", "priority"]);
  return (value && allowed.has(value) ? value : "recentupdate") as PullSort;
}

// Latest-per-user approval count, ignoring older reviews from the same user.
async function approvalCounts(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ approvals: number; rejections: number }> {
  const reviews = await collab.listReviews(owner, repo, prNumber);
  const latestByUser = new Map<string, ForgejoReview>();
  const ordered = [...reviews].sort((a, b) => {
    const at = toEpochMs(a.submitted_at);
    const bt = toEpochMs(b.submitted_at);
    return at - bt || (a.id ?? 0) - (b.id ?? 0);
  });
  for (const r of ordered) {
    // Forgejo may keep deleted-account reviews with user=null, but without a
    // stable reviewer identity we cannot collapse to "latest verdict per user"
    // without risking overcounts. Leave merge authority to Forgejo itself.
    if (!r.user) continue;
    // #56: DISMISSED must invalidate an earlier APPROVED/REQUEST_CHANGES from
    // the same user, otherwise stale approvals/rejections persist after
    // Forgejo has already dismissed them.
    if (r.state === "APPROVED" || r.state === "REQUEST_CHANGES" || r.state === "DISMISSED") {
      latestByUser.set(r.user.login, r);
    }
  }
  let approvals = 0;
  let rejections = 0;
  for (const r of latestByUser.values()) {
    if (r.state === "APPROVED") approvals++;
    else if (r.state === "REQUEST_CHANGES") rejections++;
  }
  return { approvals, rejections };
}

// Forgejo can return 405 "try again later" right after an approve lands and
// before its merge gate sees the new state. Retry with linear backoff.
type MergeFailureResult = { ok: false; status: number; message: string; transientExhausted: boolean };

async function mergeWithRetry(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  prNumber: number,
  opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
): Promise<{ ok: true } | MergeFailureResult> {
  const Do = opts.Do ?? "squash";
  try {
    await mergePullWithRetry(() => collab.mergePull(owner, repo, prNumber, { Do, force: opts.force }));
    return { ok: true };
  } catch (err) {
    return forgejoErrToResult(err);
  }
}

function forgejoErrToResult(err: unknown): MergeFailureResult {
  if (err instanceof ForgejoError) {
    const message = err.bodyText || "backend rejected request";
    // A 405 "try again later" that survived all of mergePullWithRetry's retries:
    // the merge stayed transient, not a hard conflict. Flagged so the handler
    // can classify the eventual 409 without re-parsing the error.
    const transientExhausted = err.status === 405 && /try again/i.test(err.bodyText);
    // Pass distinguishable 4xx through so the client can show the right
    // affordance — auth/permission, missing target, validation, rate limit —
    // instead of collapsing every Forgejo precondition failure into 409.
    if (err.status === 401 || err.status === 403) return { ok: false, status: err.status, message, transientExhausted };
    if (err.status === 404) return { ok: false, status: 404, message, transientExhausted };
    if (err.status === 422) return { ok: false, status: 422, message, transientExhausted };
    if (err.status === 429) return { ok: false, status: 429, message, transientExhausted };
    // 405 (conflict: e.g. "Please try again later", "PR has conflicts"), 409,
    // and any other 4xx we don't separate map to 409 — the caller violated a
    // merge precondition. 5xx → backend upstream is sick: 502.
    if (err.status >= 500) return { ok: false, status: 502, message, transientExhausted };
    return { ok: false, status: 409, message, transientExhausted };
  }
  return { ok: false, status: 500, message: (err as Error)?.message ?? "merge failed", transientExhausted: false };
}

// The branch-protection review gate state for the PR's base branch, read when a
// merge failed but the PR has no content conflict — to tell "blocked on review
// requirements" from "transient" structurally rather than by parsing Forgejo's
// error text.
export interface ReviewGate {
  requiredApprovals: number;
  approvals: number;
  rejections: number;
}

// Read the base-branch protection + this PR's current approval/rejection counts.
// Best-effort: a missing protection or unreadable reviews collapse to a
// non-blocking gate so we don't mislabel a transient failure as blocked.
async function readReviewGate(
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  baseRef: string,
): Promise<ReviewGate> {
  const [bp, counts] = await Promise.all([
    fj.getBranchProtection(owner, repo, baseRef).catch(() => null),
    approvalCounts(fj, owner, repo, prNumber).catch(() => null),
  ]);
  if (!counts) return { requiredApprovals: 0, approvals: 0, rejections: 0 };
  return { requiredApprovals: bp?.required_approvals ?? 0, approvals: counts.approvals, rejections: counts.rejections };
}

// Classify a merge-precondition failure (the 409 bucket) into an agent-actionable
// reason by re-reading the live PR (#94). `pull` is the re-read PR (null if it's
// gone), `message` is Forgejo's body text (used only for the human error string),
// `reviewGate` is the base-branch protection + approval counts (null when not
// needed — i.e. the PR is gone/merged or has a real content conflict), and
// `transientExhausted` is whether the retried path stayed transient.
export function classifyMergeFailure(
  pull: ForgejoPull | null,
  reviewGate: ReviewGate | null,
  transientExhausted: boolean,
): MergeFailure {
  const head_sha = pull?.head.sha ?? null;
  const base_sha = pull?.base.sha ?? null;
  const state: PrState = pull?.state === "closed" ? "closed" : "open";
  const merged = pull?.merged ?? false;
  const mergeable = pull?.mergeable ?? null;
  const reviewBlocked =
    reviewGate !== null && (reviewGate.approvals < reviewGate.requiredApprovals || reviewGate.rejections > 0);
  let reason: MergeFailureReason;
  if (pull === null || merged) reason = "stale";
  else if (mergeable === false) reason = "conflict";
  else if (reviewBlocked) reason = "blocked";
  else if (mergeable === null || transientExhausted) reason = "transient";
  else reason = "unknown";
  return { error: mergeFailureMessage(reason), code: "conflict", reason, mergeable, head_sha, base_sha, state, merged };
}

// Client-safe merge-failure copy keyed on the structured reason/status. NEVER echo
// Forgejo's raw body text to a caller — it carries internal backend URLs (e.g. the
// forge host:port). The raw text is logged server-side (with the request id) for
// debugging; only these sentences reach the browser/agent.
export function mergeFailureMessage(reason: MergeFailureReason): string {
  switch (reason) {
    case "blocked":
      return "This pull request needs its required approvals before it can merge.";
    case "conflict":
      return "This pull request has conflicts that must be resolved before it can merge.";
    case "stale":
      return "This pull request is already merged or no longer open.";
    case "transient":
      return "The merge service is busy — try again in a moment.";
    case "unknown":
      return "The merge was rejected.";
  }
}

function isSettingsPayload(value: unknown): value is { min_approvals?: number; default_md_format?: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeStatusMessage(status: number): string {
  if (status === 401 || status === 403) return "You don't have permission to merge this pull request.";
  if (status === 404) return "This pull request no longer exists.";
  if (status === 422) return "The merge request was invalid.";
  if (status === 429) return "Too many merge attempts — try again shortly.";
  if (status === 502) return "The merge service is unavailable — try again shortly.";
  return "The merge failed unexpectedly.";
}


pulls.get("/:owner/:repo/pulls", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const rows = await collab.listPulls(owner, repo, {
    state: parseListState(c.req.query("state")),
    labels: parsePositiveIntList(c.req.query("labels")),
    milestone: parsePositiveInt(c.req.query("milestone")),
    poster: c.req.query("author")?.trim() || undefined,
    sort: parsePullSort(c.req.query("sort")),
  });
  if (wantsTeaShape(c)) return c.json(scrubBackendUrls(c, rows));
  const out = rows.map(prMeta);
  return c.json({ pulls: out });
});

pulls.get("/:owner/:repo/pulls/:n", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  return c.json({ pull: prMeta(pull) });
});

pulls.post("/:owner/:repo/pulls", async (c) => {
  const body = await readJsonObject(c.req);
  if (body.head === undefined || body.head === null || body.head === "") return c.json(...bad("head required"));
  const head = typeof body.head === "string" ? body.head : "";
  if (!validBranchName(head)) return c.json(...bad("valid head branch name required"));
  const base = body.base === undefined || body.base === null ? "main" : typeof body.base === "string" ? body.base : "";
  if (!validBranchName(base)) return c.json(...bad("valid base branch name required"));
  if (body.title !== undefined && typeof body.title !== "string") return c.json(...bad("title must be a string"));
  if (body.body !== undefined && typeof body.body !== "string") return c.json(...bad("body must be a string"));
  const { collab, owner, repo } = repoCtxCollab(c);
  try {
    const pr = await collab.createPull(owner, repo, {
      head,
      base,
      title: typeof body.title === "string" ? body.title : head,
      body: typeof body.body === "string" ? body.body : "",
    });
    c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: pr.number, action: "opened" });
    return c.json(prMeta(pr), 201);
  } catch (err) {
    // Forgejo POST /pulls returns 409 for several reasons — empty diff, an
    // existing PR for this head→base, or a duplicate title — and 422 for
    // validation.
    if (err instanceof ForgejoError && (err.status === 409 || err.status === 422)) {
      // The common 409 is an existing PR for this head→base (e.g. the editor
      // re-clicking "Open PR"). Forgejo blocks a duplicate against any UNMERGED
      // PR — open OR closed — so resolve across all states and return it, letting
      // the caller navigate to the existing PR instead of seeing a duplicate-PR
      // error (#181). Other 409/422 (empty diff, validation) have no matching PR
      // and get a clean message — never Forgejo's raw body, which leaks the
      // internal forge URL.
      // Don't silently swallow a dedup-lookup failure into the generic message —
      // log it (with the request id) so a real listPulls error is debuggable.
      const all = await collab.listPulls(owner, repo, "all").catch((e: unknown) => {
        console.error(`[${c.get("requestId") ?? ""}] dedup listPulls failed for ${owner}/${repo}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });
      const existing = all.find((p) => p.head.ref === head && p.base.ref === base && !p.merged);
      if (existing) return c.json(prMeta(existing), 200);
      return c.json(...conflict("Couldn't open a pull request — there may be no changes to propose between these branches, or the request was invalid."));
    }
    throw err;
  }
});

pulls.patch("/:owner/:repo/pulls/:n", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const parsed = parseTitleBodyPatch(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.editPull(owner, repo, n, parsed.patch);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "edited" });
  return c.json({ pull: prMeta(pull) });
});

pulls.put("/:owner/:repo/pulls/:n/labels", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const body = await readJsonObject(c.req);
  const labelIds = parsePositiveLabelIds(body.labels);
  if (labelIds === null) {
    return c.json(...bad("labels must be positive integer ids"));
  }
  const { fj, owner, repo } = repoCtxForgejo(c);
  const { collab } = repoCtxCollab(c);
  const [allLabels, pull] = await Promise.all([
    fj.listLabels(owner, repo),
    collab.getPull(owner, repo, n),
  ]);
  if (!pull) return c.json(...notFound());
  const validation = validateLabelSelection(labelIds, allLabels, pull.labels ?? []);
  if (!validation.ok) return c.json(...bad(validation.message));
  const updated = await collab.editPull(owner, repo, n, { labels: labelIds });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "edited" });
  return c.json({ pull: prMeta(updated) });
});


pulls.post("/:owner/:repo/pulls/:n/merge", requireAdminFresh, async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const body = await readJsonObject(c.req);
  const { fj, owner, repo } = repoCtxForgejo(c);
  const { collab } = repoCtxCollab(c);
  // Admins can bypass the required-approvals branch protection rule by
  // passing `force: true`. Callers default to false (normal review flow).
  if (body.Do !== undefined && body.Do !== "squash" && body.Do !== "merge" && body.Do !== "rebase") {
    return c.json(...bad("Do must be squash, merge, or rebase"));
  }
  const mergeMethod = body.Do;
  const result = await mergeWithRetry(collab, owner, repo, n, { Do: mergeMethod, force: body.force === true });
  if (!result.ok) {
    // Capture Forgejo's raw reason server-side (it carries internal URLs we must
    // not leak to the client) so a failure can be debugged by request id.
    console.error(`[${c.get("requestId") ?? ""}] merge ${owner}/${repo}#${n} failed (${result.status}): ${result.message}`);
    // The 409 bucket (merge-precondition failures) gets re-read + classified so
    // the agent can tell a real conflict from transient / needs-approval / stale
    // and pick the right recovery instead of blindly retrying (#94).
    if (result.status === 409) {
      const pull = await collab.getPull(owner, repo, n);
      // Only the ambiguous case (PR present, no real conflict, not already
      // merged) needs the review-gate read to tell "blocked" from "transient".
      const ambiguous = pull !== null && pull.merged !== true && pull.mergeable !== false;
      const reviewGate = ambiguous ? await readReviewGate(fj, owner, repo, n, pull.base.ref) : null;
      return c.json(classifyMergeFailure(pull, reviewGate, result.transientExhausted), 409);
    }
    const code = result.status === 502 ? "upstream" : result.status === 500 ? "internal" : "conflict";
    return c.json({ error: mergeStatusMessage(result.status), code }, result.status as 502 | 500 | 401 | 403 | 404 | 422 | 429);
  }
  const pull = await collab.getPull(owner, repo, n);
  // Never delete main even if it was somehow the head (mirrors the web route).
  if (pull && pull.head.ref && pull.head.ref !== "main") await deleteBranchQuietly(fj, owner, repo, pull.head.ref);
  // Invalidate eagerly so the post-merge tree fetch sees the new main
  // commit before the push webhook lands (in tests/dev the webhook may
  // never fire, leaving stale entries up to the 5min TTL otherwise).
  invalidateRepoTrees(owner, repo);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "merged" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/close", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.editPull(owner, repo, n, { state: "closed" });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "closed" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/reopen", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.editPull(owner, repo, n, { state: "open" });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "reopened" });
  return c.json({ ok: true });
});

// ---------- diff + raw file at a side ----------

pulls.get("/:owner/:repo/pulls/:n/files", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const [metas, unified] = await Promise.all([
    collab.listPullFiles(owner, repo, n),
    collab.getPullDiff(owner, repo, n),
  ]);
  const patches = splitUnifiedDiff(unified);
  const byPath = new Map(patches.map((p) => [p.path, p]));
  const files = metas.map((m) => {
    const slice = byPath.get(m.filename);
    return {
      path: m.filename,
      previous_path: m.previous_filename ?? slice?.previous_path,
      status: normalizeStatus(m.status),
      additions: m.additions,
      deletions: m.deletions,
      patch: slice?.patch ?? "",
    };
  });
  return c.json({ files });
});

pulls.get("/:owner/:repo/pulls/:n/commits", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const commits = await collab.listPullCommits(owner, repo, n);
  const out: PrCommit[] = commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    author_username: commit.author?.login ?? null,
    author_name: commit.commit.author?.name ?? null,
    date: toEpochMsOrNull(commit.commit.author?.date),
  }));
  return c.json({ commits: out });
});

pulls.get("/:owner/:repo/pulls/:n/file", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  // Apply the same repo-path safety check the file route uses (rejects
  // absolute, traversal, encoded-traversal, backslash, control chars).
  const path = safeRel(c.req.query("path"));
  const side = c.req.query("side");
  if (!path) return c.json(...bad("path required"));
  if (side !== "base" && side !== "head")
    return c.json(...bad("side must be base or head"));
  const { fj, owner, repo } = repoCtxForgejo(c);
  const { collab } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  const file = { path, previous_path: side === "base" ? await previousPathFor(collab, owner, repo, n, path) : undefined };
  const read = prSideRefAndPath(pull, file, side);
  try {
    const content = await fj.getRawFile(owner, repo, read.ref, read.path);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404)
      return c.json(...notFound("file not present at this side"));
    throw err;
  }
});

async function previousPathFor(collab: CollaborationClient, owner: string, repo: string, n: number, path: string): Promise<string | undefined> {
  const files = await collab.listPullFiles(owner, repo, n);
  return files.find((file) => file.filename === path)?.previous_filename;
}

// ---------- reviews (approve / request-changes / comment) ----------

const EVENT_MAP = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "REQUEST_CHANGES",
  COMMENT: "COMMENT",
} as const;

function parseOptionalReviewBody(value: unknown): { ok: true; body: string } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, body: "" };
  return typeof value === "string"
    ? { ok: true, body: value }
    : { ok: false, message: "body must be a string" };
}

pulls.get("/:owner/:repo/pulls/:n/reviews", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const reviews = await collab.listReviews(owner, repo, n);
  const out = reviews
    .filter((r) => r.state === "APPROVED" || r.state === "REQUEST_CHANGES" || r.state === "COMMENT")
    .map((r) => ({
      id: r.id,
      username: userLogin(r.user),
      decision:
        r.state === "APPROVED"
          ? ("approve" as const)
          : r.state === "REQUEST_CHANGES"
            ? ("request_changes" as const)
            : ("comment" as const),
      comment: r.body || null,
      created_at: toEpochMs(r.submitted_at),
    }));
  const counts = await approvalCounts(collab, owner, repo, n);
  return c.json({ reviews: out, approvals: counts.approvals, rejections: counts.rejections });
});

pulls.post("/:owner/:repo/pulls/:n/reviews", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const payload = await readJsonObject(c.req);
  const event = typeof payload.event === "string" ? payload.event : undefined;
  if (!event || !Object.hasOwn(EVENT_MAP, event))
    return c.json(...bad("event must be APPROVE|REQUEST_CHANGES|COMMENT"));
  const reviewEvent = event as keyof typeof EVENT_MAP;
  const reviewBody = parseOptionalReviewBody(payload.body);
  if (!reviewBody.ok) return c.json(...bad(reviewBody.message));

  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  if (EVENT_MAP[reviewEvent] !== "COMMENT" && pull.user?.login === c.get("user").username)
    return c.json(...forbidden("cannot review your own pull request"));
  if (pull.state === "closed") return c.json(...forbidden("cannot review a closed pull request"));

  await collab.createReview(owner, repo, n, {
    event: EVENT_MAP[reviewEvent],
    body: reviewBody.body,
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "reviewed" });

  const counts = await approvalCounts(collab, owner, repo, n);
  return c.json({ ok: true, approvals: counts.approvals, rejections: counts.rejections });
});

function parseReviewers(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((item) => typeof item === "string")) return null;
  const reviewers = raw.map((item) => item.trim()).filter(Boolean);
  return reviewers.length > 0 ? [...new Set(reviewers)] : null;
}

pulls.get("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const [pull, reviewers] = await Promise.all([
    collab.getPull(owner, repo, n),
    collab.listPullReviewers(owner, repo),
  ]);
  if (!pull) return c.json(...notFound());
  return c.json({
    requested_reviewers: prMeta(pull).requested_reviewers,
    requested_reviewer_teams: prMeta(pull).requested_reviewer_teams,
    available_reviewers: reviewers.map((u) => u.login).filter((login) => login !== pull.user?.login),
  });
});

pulls.post("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const body = await readJsonObject(c.req);
  const reviewers = parseReviewers(body.reviewers);
  if (!reviewers) return c.json(...bad("reviewers required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.createPullReviewRequests(owner, repo, n, reviewers);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "review_requested" });
  return c.json({ pull: prMeta(pull) }, 201);
});

pulls.delete("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const body = await readJsonObject(c.req);
  const reviewers = parseReviewers(body.reviewers);
  if (!reviewers) return c.json(...bad("reviewers required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.deletePullReviewRequests(owner, repo, n, reviewers);
  const pull = await collab.getPull(owner, repo, n);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "review_requested" });
  return c.json({ pull: pull ? prMeta(pull) : null });
});

// ---------- line comments ----------

interface CommentInput { path: string; line: number; side: "base" | "head"; body: string }

// Strict shape check: safe relative path, positive integer line, valid side,
// non-empty body. Anything else returns null and the caller responds 400.
function parseCommentInput(raw: unknown): CommentInput | null {
  const v = raw as Partial<CommentInput> | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.path !== "string") return null;
  const path = safeRel(v.path);
  if (!path) return null;
  if (!Number.isInteger(v.line) || (v.line as number) < 1) return null;
  if (v.side !== "base" && v.side !== "head") return null;
  if (typeof v.body !== "string" || v.body.trim() === "") return null;
  return { path, line: v.line as number, side: v.side, body: v.body };
}

async function resolveLinePosition(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  n: number,
  input: CommentInput,
): Promise<{ new_position?: number; old_position?: number } | { error: string }> {
  const unified = await collab.getPullDiff(owner, repo, n);
  const filePatch = splitUnifiedDiff(unified).find((p) => p.path === input.path)?.patch;
  if (!filePatch) return { error: "file not part of this PR" };
  const pos = fileLineToWritePosition(filePatch, input.line, input.side);
  if (!pos) return { error: "line not present in diff" };
  return pos;
}

async function requirePullComment(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
): Promise<ForgejoPullReviewComment | null> {
  const comments = await collab.listPullComments(owner, repo, pullNumber);
  return comments.find((comment) => comment.id === commentId) ?? null;
}

pulls.get("/:owner/:repo/pulls/:n/comments", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  // Comment line/side come straight from Forgejo's position/original_position
  // (absolute file lines), so the read path no longer needs the unified diff.
  const [allComments, metas] = await Promise.all([
    collab.listPullComments(owner, repo, n),
    collab.listPullFiles(owner, repo, n),
  ]);
  const status = new Map(metas.map((m) => [m.filename, m.status]));
  const out: LineComment[] = allComments.map((cm) => {
    const { line, side, outdated } = resolveLineComment(cm, status.get(cm.path) ?? "");
    return {
      id: cm.id,
      review_id: cm.pull_request_review_id,
      path: cm.path,
      line,
      side,
      body: cm.body,
      author_username: userLogin(cm.user),
      created_at: toEpochMs(cm.created_at),
      updated_at: toEpochMs(cm.updated_at),
      outdated,
    };
  });
  return c.json({ comments: out });
});

pulls.post("/:owner/:repo/pulls/:n/comments", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  // Validate the body BEFORE touching Forgejo so malformed requests don't
  // burn a getPull call.
  const input = parseCommentInput(await readJsonBody(c.req));
  if (!input)
    return c.json(
      {
        error: "path, line, side, body required (path must be safe relative, line a positive integer, side 'base'|'head', body non-empty)",
        code: "validation",
      },
      400,
    );
  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  if (pull.state === "closed") return c.json(...forbidden("cannot comment on a closed pull request"));
  const pos = await resolveLinePosition(collab, owner, repo, n, input);
  if ("error" in pos) return c.json(...bad(pos.error));

  await collab.createReview(owner, repo, n, {
    event: "COMMENT",
    body: "",
    comments: [{ path: input.path, body: input.body, ...pos }],
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

pulls.patch("/:owner/:repo/pulls/:n/comments/:cid", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  const cid = parsePositiveIntId(c.req.param("cid"));
  if (n === null) return c.json(...bad("bad pull number"));
  if (cid === null) return c.json(...bad("bad comment id"));
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { fj, owner, repo } = repoCtxForgejo(c);
  const { collab } = repoCtxCollab(c);
  const comment = await requirePullComment(collab, owner, repo, n, cid);
  if (!comment) return c.json(...notFound("comment not found"));
  await fj.editIssueComment(owner, repo, cid, text);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

pulls.delete("/:owner/:repo/pulls/:n/comments/:cid", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  const cid = parsePositiveIntId(c.req.param("cid"));
  const rid = parsePositiveIntId(c.req.query("review_id"));
  if (n === null) return c.json(...bad("bad pull number"));
  if (cid === null) return c.json(...bad("bad comment id"));
  if (rid === null) return c.json(...bad("bad review id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const comment = await requirePullComment(collab, owner, repo, n, cid);
  if (!comment) return c.json(...notFound("comment not found"));
  if (comment.pull_request_review_id !== rid) return c.json(...bad("review id does not match comment"));
  await collab.deleteReviewComment(owner, repo, n, rid, cid);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

// ---------- pending reviews ----------

async function findOrCreatePendingReview(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  n: number,
  forgejoUsername: string,
): Promise<number> {
  const reviews = await collab.listReviews(owner, repo, n);
  const existing = reviews.find((r) => r.state === "PENDING" && r.user?.login === forgejoUsername);
  if (existing) return existing.id;
  const created = await collab.createReview(owner, repo, n, {
    event: "PENDING",
    body: "(pending)",
  });
  return created.id;
}

async function requireOwnPendingReview(
  c: Context<AppEnv>,
  n: number,
  rid: number,
): Promise<ForgejoReview | Response> {
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  if (pull.user?.login === c.get("user").username)
    return c.json(...forbidden("cannot review your own pull request"));
  if (pull.state === "closed") return c.json(...forbidden("cannot review a closed pull request"));

  const reviews = await collab.listReviews(owner, repo, n);
  const review = reviews.find((item) => item.id === rid);
  if (!review || review.state !== "PENDING" || review.user?.login !== c.get("user").username) {
    return c.json(...notFound("pending review not found"));
  }
  return review;
}

pulls.post("/:owner/:repo/pulls/:n/pending-review", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  if (n === null) return c.json(...bad("bad pull number"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  if (pull.user?.login === c.get("user").username)
    return c.json(...forbidden("cannot review your own pull request"));
  const review_id = await findOrCreatePendingReview(collab, owner, repo, n, c.get("user").username);
  return c.json({ review_id });
});

pulls.post("/:owner/:repo/pulls/:n/pending-review/:rid/comments", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  const rid = parsePositiveIntId(c.req.param("rid"));
  if (n === null || rid === null) return c.json(...bad("bad ids"));
  const ws = c.get("workspace");
  const input = parseCommentInput(await readJsonBody(c.req));
  if (!input) return c.json(...bad("path, line, side, body required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const review = await requireOwnPendingReview(c, n, rid);
  if (review instanceof Response) return review;
  const pos = await resolveLinePosition(collab, owner, repo, n, input);
  if ("error" in pos) return c.json(...bad(pos.error));
  await collab.addCommentToReview(owner, repo, n, rid, {
    path: input.path,
    body: input.body,
    ...pos,
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/pending-review/:rid/submit", async (c) => {
  const n = parsePositiveIntId(c.req.param("n"));
  const rid = parsePositiveIntId(c.req.param("rid"));
  if (n === null || rid === null) return c.json(...bad("bad ids"));
  const body = await readJsonObject(c.req);
  const event = typeof body.event === "string" ? body.event : undefined;
  if (!event) return c.json(...bad("event required"));
  const eventMap = { approve: "APPROVED", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
  if (!Object.hasOwn(eventMap, event)) return c.json(...bad("invalid event"));
  const reviewBody = parseOptionalReviewBody(body.body);
  if (!reviewBody.ok) return c.json(...bad(reviewBody.message));
  const { collab, owner, repo } = repoCtxCollab(c);
  const review = await requireOwnPendingReview(c, n, rid);
  if (review instanceof Response) return review;
  await collab.submitPullReview(owner, repo, n, rid, {
    event: eventMap[event as keyof typeof eventMap],
    body: reviewBody.body,
  });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "reviewed" });
  return c.json({ ok: true });
});

// ---------- repo access + topics (settings surface reads) ----------

pulls.get("/:owner/:repo/collaborators", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const members = await fj.listCollaborators(owner, repo);
  // Forgejo's collaborators list returns users without their access role, so
  // resolve each role separately. A read for a single user may 403 (the caller
  // can't see another user's permission) — degrade that entry to null rather
  // than failing the whole list.
  const collaborators: RepoCollaborator[] = await Promise.all(
    members.map(async (member) => ({
      login: member.login,
      permission: await fj.getRepoPermission(owner, repo, member.login).then((p) => (p === "none" ? null : p)).catch(() => null),
    })),
  );
  return c.json({ collaborators });
});

pulls.get("/:owner/:repo/topics", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const topics = await fj.listRepoTopics(owner, repo);
  return c.json({ topics });
});

// ---------- settings (min_approvals on main) ----------

pulls.get("/:owner/:repo/settings", async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const bp = await fj.getBranchProtection(owner, repo, "main");
  return c.json({
    min_approvals: bp?.required_approvals ?? 1,
    default_md_format: normalizeDocumentFormatId(c.get("workspace").defaultMdFormat),
    formats: allDocumentFormats().map((f) => ({ id: f.id, displayName: f.displayName })),
  });
});

// PUT /settings is NOT atomic across Forgejo and the SQLite sidecar — by
// design. Forgejo is authoritative for branch protection and workspace format
// topics; SQLite is local derived index state. Order within the handler:
//
//   1. validate payload (cheap, no side effects)
//   2. update Forgejo branch protection if min_approvals changed
//   3. update the Forgejo repo format topic if default_md_format changed
//   4. reindex from Forgejo if default_md_format changed (this WRITES to
//      doc_map/backlinks/FTS with the new format's rules)
//
// If any step throws, the response is a 5xx with the step that failed in
// the body. The repair path is always: PUT /settings again with the same
// payload (idempotent), then optionally `pnpm cli workspace reindex <slug>`
// if the format topic advanced but the indexer crashed mid-walk.
pulls.put("/:owner/:repo/settings", requireAdminFresh, async (c) => {
  const body = await readJsonBody(c.req);
  if (!isSettingsPayload(body))
    return c.json(...bad("settings payload required"));
  if (body.min_approvals !== undefined && (!Number.isInteger(body.min_approvals) || body.min_approvals < 0)) {
    return c.json(...bad("min_approvals must be >= 0"));
  }
  if (body.default_md_format !== undefined && !isDocumentFormatId(body.default_md_format)) {
    return c.json(...bad("unknown markdown format"));
  }
  const { fj, owner, repo } = repoCtxForgejo(c);

  let minApprovals: number;
  try {
    const existing = await fj.getBranchProtection(owner, repo, "main");
    minApprovals = body.min_approvals ?? existing?.required_approvals ?? 1;
    if (body.min_approvals !== undefined) {
      if (!existing) {
        await fj.createBranchProtection(owner, repo, {
          branch_name: "main",
          required_approvals: body.min_approvals,
        });
      } else {
        await fj.updateBranchProtection(owner, repo, "main", { required_approvals: body.min_approvals });
      }
    }
  } catch (err) {
    return c.json(
      { error: `branch-protection update failed (backend unchanged): ${(err as Error).message}`, code: "backend_failed", step: "branch_protection" },
      502,
    );
  }

  const defaultMdFormat = body.default_md_format !== undefined
    ? normalizeDocumentFormatId(body.default_md_format)
    : normalizeDocumentFormatId(c.get("workspace").defaultMdFormat);
  if (body.default_md_format !== undefined) {
    try {
      // Format storage is a Forgejo repo topic. Update the topic before
      // re-indexing so the reindex picks up the new format.
      await setWorkspaceFormatTopic(fj, owner, repo, defaultMdFormat);
      await lockedReindexWorkspaceFromForgejo(c.get("db"), fj, {
        owner,
        repo,
        slug: c.get("workspace").slug,
        defaultMdFormat,
      });
    } catch (err) {
      return c.json(
        {
          error: `reindex failed; Forgejo branch protection updated but sidecar may be partial. Re-run settings update or \`pnpm cli workspace reindex\`: ${(err as Error).message}`,
          code: "reindex_failed",
          step: "reindex",
        },
        502,
      );
    }
  }
  return c.json({
    min_approvals: minApprovals,
    default_md_format: defaultMdFormat,
    formats: allDocumentFormats().map((f) => ({ id: f.id, displayName: f.displayName })),
  });
});
