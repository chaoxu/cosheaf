// Pull-request surface. Collaboration state lives in the Core collaboration
// client (hosted in-process over Forgejo, local over the Origin API); file
// content and branch cleanup go through WorkspaceBackend.
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

import { type Context, Hono } from "hono";
import { isDocumentFormatId, normalizeDocumentFormatId } from "../../shared/document-format.js";
import type { RepoCollaborator } from "../../shared/repo.js";
import type { PrMeta, ReviewDto } from "../../shared/review.js";
import { reviewRequiresNonAuthor } from "../../shared/review.js";
import { validBranchName } from "../branch-path.js";
import type { CollaborationClient } from "../collaboration-client.js";
import { fileLineToWritePosition } from "../diff-position.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { is4xx, is404 } from "../forgejo-errors.js";
import {
  approvalCounts,
  approvalCountsFromReviews,
  classifyMergeFailure,
  isSettingsPayload,
  mergeStatusMessage,
  mergeWithRetry,
  readReviewGate,
} from "../merge-failure.js";
import {
  isLocalMode,
  repoCtxCollab,
  requireAdminFresh,
  requireAuth,
  requireMembership,
  writeOnMutationExcept,
} from "../middleware.js";
import { prSideRefAndPath } from "../pr-side.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { safeRel } from "./files.js";
import { parsePositiveLabelIds, validateLabelSelection } from "./label-utils.js";
import { intParam, parseListState, parsePositiveInt, parsePositiveIntId, parsePositiveIntList, parseTitleBodyPatch, readJsonBody, readJsonObject, requireCommentBody } from "./query-params.js";
import { scrubBackendUrls, wantsTeaShape } from "./tea-compat.js";

export const pulls = new Hono<AppEnv>();
pulls.use("*", requireAuth);
pulls.use("/:owner/:repo/*", requireMembership());

const pullDiscussionMutationRe = /\/pulls\/\d+\/(?:reviews|comments(?:\/\d+)?)$/;

pulls.use("/:owner/:repo/*", writeOnMutationExcept(pullDiscussionMutationRe));

import { bad, conflict, forbidden, notFound } from "./responses.js";

type PullSort = "oldest" | "recentupdate" | "recentclose" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";

function parsePullSort(value: string | undefined): PullSort {
  const allowed = new Set(["oldest", "recentupdate", "recentclose", "leastupdate", "mostcomment", "leastcomment", "priority"]);
  return (value && allowed.has(value) ? value : "recentupdate") as PullSort;
}

function teaPullShape(pull: PrMeta) {
  return {
    ...pull,
    head: { ref: pull.head_ref, sha: pull.head_sha },
    base: { ref: pull.base_ref, sha: pull.base_sha },
    user: { login: pull.author_username },
  };
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
  if (wantsTeaShape(c)) return c.json(scrubBackendUrls(c, rows.map(teaPullShape)));
  return c.json({ pulls: rows });
});

pulls.get("/:owner/:repo/pulls/:n", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  return c.json({ pull });
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
    return c.json(pr, 201);
  } catch (err) {
    // POST /pulls returns 409 for several reasons — empty diff, an existing PR
    // for this head→base, or a duplicate title — and 422 for validation. Match on
    // status so a local Workbench write (RemoteCosheafError) recovers the same way
    // as a hosted forge write (ForgejoError).
    if (is4xx(err, 409, 422)) {
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
      const existing = all.find((p) => p.head_ref === head && p.base_ref === base && !p.merged);
      if (existing) return c.json(existing, 200);
      return c.json(...conflict("Couldn't open a pull request — there may be no changes to propose between these branches, or the request was invalid."));
    }
    throw err;
  }
});

pulls.patch("/:owner/:repo/pulls/:n", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const body = await readJsonObject(c.req);
  const parsed = parseTitleBodyPatch(body);
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const milestone =
    body.milestone === undefined
      ? undefined
      : body.milestone === null || body.milestone === 0
        ? 0
        : typeof body.milestone === "number"
          ? parsePositiveIntId(body.milestone)
          : null;
  if (milestone === null) return c.json(...bad("milestone must be a positive integer or null"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.editPull(owner, repo, n, {
    ...parsed.patch,
    ...(milestone !== undefined ? { milestone } : {}),
  });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "edited" });
  return c.json({ pull });
});

pulls.put("/:owner/:repo/pulls/:n/labels", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const body = await readJsonObject(c.req);
  const labelIds = parsePositiveLabelIds(body.labels);
  if (labelIds === null) {
    return c.json(...bad("labels must be positive integer ids"));
  }
  const { collab, owner, repo } = repoCtxCollab(c);
  const [allLabels, pull] = await Promise.all([
    collab.listLabels(owner, repo),
    collab.getPull(owner, repo, n),
  ]);
  if (!pull) return c.json(...notFound());
  const validation = validateLabelSelection(labelIds, allLabels, pull.labels ?? []);
  if (!validation.ok) return c.json(...bad(validation.message));
  const updated = await collab.editPull(owner, repo, n, { labels: labelIds });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "edited" });
  return c.json({ pull: updated });
});


pulls.post("/:owner/:repo/pulls/:n/merge", requireAdminFresh, async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const body = await readJsonObject(c.req);
  const { collab, owner, repo } = repoCtxCollab(c);
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
      const reviewGate = ambiguous ? await readReviewGate(collab, owner, repo, n, pull.base_ref) : null;
      return c.json(classifyMergeFailure(pull, reviewGate, result.transientExhausted), 409);
    }
    if (result.status === 404) {
      // Forgejo answers 404 when merging a PR that isn't open — but the PR may
      // still EXIST (closed, not merged). Re-read to tell a genuinely-missing PR
      // (a true 404) from a closed one, which is a precondition conflict (409),
      // not a not-found. Don't echo the misleading "no longer exists" message at
      // 404 for a PR that does exist.
      const pull = await collab.getPull(owner, repo, n);
      if (pull) return c.json(classifyMergeFailure(pull, null, result.transientExhausted), 409);
      return c.json(...notFound("this pull request no longer exists"));
    }
    // A backend 5xx during a squash is usually an empty commit: the PR's content
    // is already in the base branch, so `git commit` has nothing to commit and
    // Forgejo 500s. Detect that (base..head diff has no files) and return an
    // actionable 409 instead of the misleading "merge service unavailable" (#401).
    // Guarded: if listPullFiles also errors (genuine backend outage), fall
    // through to the 502 rather than mislabeling it "empty".
    if (result.status >= 500) {
      const files = await collab.listPullFiles(owner, repo, n).catch(() => null);
      if (files && files.length === 0) {
        return c.json({
          error: "This pull request has no changes to merge — its content is already in the base branch. Close it instead.",
          code: "empty",
        }, 409);
      }
    }
    const code = result.status === 502 ? "upstream" : result.status === 500 ? "internal" : "conflict";
    return c.json({ error: mergeStatusMessage(result.status), code }, result.status as 502 | 500 | 401 | 403 | 422 | 429);
  }
  const pull = await collab.getPull(owner, repo, n);
  // Never delete main even if it was somehow the head (mirrors the web route).
  // In local mode the head branch lives on the connected core; the proxied merge
  // owns its cleanup and there is no local forge client to delete it — so only
  // the hosted app touches the raw forge client here.
  if (!isLocalMode(c) && pull && pull.head_ref && pull.head_ref !== "main") {
    await c.get("repoCtx").backend.deleteBranch(owner, repo, pull.head_ref).catch(() => undefined);
  }
  // Invalidate eagerly so the post-merge tree fetch sees the new main
  // commit before the push webhook lands (in tests/dev the webhook may
  // never fire, leaving stale entries up to the 5min TTL otherwise).
  invalidateRepoTrees(owner, repo);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "merged" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/close", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.setPullState(owner, repo, n, "closed");
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "closed" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/reopen", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const ws = c.get("workspace");
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.setPullState(owner, repo, n, "open");
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "reopened" });
  return c.json({ ok: true });
});

// ---------- diff + raw file at a side ----------

pulls.get("/:owner/:repo/pulls/:n/files", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const files = await collab.listPullFiles(owner, repo, n);
  return c.json({ files });
});

pulls.get("/:owner/:repo/pulls/:n/commits", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const commits = await collab.listPullCommits(owner, repo, n);
  return c.json({ commits });
});

pulls.get("/:owner/:repo/pulls/:n/file", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  // Apply the same repo-path safety check the file route uses (rejects
  // absolute, traversal, encoded-traversal, backslash, control chars).
  const path = safeRel(c.req.query("path"));
  const side = c.req.query("side");
  if (!path) return c.json(...bad("path required"));
  if (side !== "base" && side !== "head")
    return c.json(...bad("side must be base or head"));
  const { backend } = c.get("repoCtx");
  const { collab, owner, repo } = repoCtxCollab(c);
  const [pull, previousPath] = await Promise.all([
    collab.getPull(owner, repo, n),
    side === "base" ? previousPathFor(collab, owner, repo, n, path) : Promise.resolve(undefined),
  ]);
  if (!pull) return c.json(...notFound());
  const file = { path, previous_path: previousPath };
  const read = prSideRefAndPath(pull, file, side);
  try {
    const content = await backend.getRawFile(owner, repo, read.ref, read.path);
    return c.json({ content });
  } catch (err) {
    // Local Workbench: a PR's per-side content lives on the connected core at the
    // PR's immutable base/head SHAs, which the single-working-tree local backend
    // can't resolve. Degrade to empty rather than 500 — the rich split/after diff
    // is unavailable locally anyway and the unified patch renders the diff
    // elsewhere (mirrors the web files page's local fallback).
    if (isLocalMode(c)) return c.json({ content: "" });
    if (is404(err)) return c.json(...notFound("file not present at this side"));
    throw err;
  }
});

async function previousPathFor(collab: CollaborationClient, owner: string, repo: string, n: number, path: string): Promise<string | undefined> {
  const files = await collab.listPullFiles(owner, repo, n);
  return files.find((file) => file.path === path)?.previous_path;
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
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const reviews = await collab.listReviews(owner, repo, n);
  // Include the caller's OWN pending (draft) review. This lets the staged
  // pending-review flow round-trip through this typed route in the local
  // Workbench, where requireOwnPendingReview / findOrCreatePendingReview read
  // reviews via the Origin client (#262) — the core's GET /reviews is the only
  // way they can see the draft. Showing a reviewer their own draft is correct;
  // other users' pending reviews stay hidden. Hosted reads pending straight off
  // the forge client, so the only consumer of the extra entry is the Origin
  // client (the web timeline filters via isVisibleReview independently).
  const me = c.get("user").username;
  const out = reviews
    .filter(
      (r) =>
        r.decision === "approve" ||
        r.decision === "request_changes" ||
        r.decision === "comment" ||
        (r.decision === "pending" && r.username === me),
    )
    .map((r) => r);
  const counts = approvalCountsFromReviews(reviews);
  return c.json({ reviews: out, approvals: counts.approvals, rejections: counts.rejections });
});

pulls.post("/:owner/:repo/pulls/:n/reviews", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
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
  if (EVENT_MAP[reviewEvent] !== "COMMENT" && pull.author_username === c.get("user").username)
    return c.json(...forbidden("cannot review your own pull request"));
  if (pull.state === "closed") return c.json(...forbidden("cannot review a closed pull request"));

  const review = await collab.createReview(owner, repo, n, {
    event: EVENT_MAP[reviewEvent],
    body: reviewBody.body,
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "reviewed" });

  const counts = await approvalCounts(collab, owner, repo, n);
  return c.json({ ok: true, review, approvals: counts.approvals, rejections: counts.rejections });
});

function parseReviewers(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((item) => typeof item === "string")) return null;
  const reviewers = raw.map((item) => item.trim()).filter(Boolean);
  return reviewers.length > 0 ? [...new Set(reviewers)] : null;
}

pulls.get("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const [pull, reviewers] = await Promise.all([
    collab.getPull(owner, repo, n),
    collab.listPullReviewers(owner, repo),
  ]);
  if (!pull) return c.json(...notFound());
  return c.json({
    requested_reviewers: pull.requested_reviewers,
    requested_reviewer_teams: pull.requested_reviewer_teams,
    available_reviewers: reviewers.map((u) => u.login).filter((login) => login !== pull.author_username),
  });
});

pulls.post("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const body = await readJsonObject(c.req);
  const reviewers = parseReviewers(body.reviewers);
  if (!reviewers) return c.json(...bad("reviewers required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.createPullReviewRequests(owner, repo, n, reviewers);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "review_requested" });
  return c.json({ pull }, 201);
});

pulls.delete("/:owner/:repo/pulls/:n/review-requests", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const body = await readJsonObject(c.req);
  const reviewers = parseReviewers(body.reviewers);
  if (!reviewers) return c.json(...bad("reviewers required"));
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.deletePullReviewRequests(owner, repo, n, reviewers);
  const pull = await collab.getPull(owner, repo, n);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "review_requested" });
  return c.json({ pull });
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

pulls.get("/:owner/:repo/pulls/:n/comments", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const comments = await collab.listPullComments(owner, repo, n);
  return c.json({ comments });
});

pulls.post("/:owner/:repo/pulls/:n/comments", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
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
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const cid = intParam(c, "cid", "bad comment id");
  if (cid instanceof Response) return cid;
  const parsed = requireCommentBody(await readJsonBody(c.req));
  if (!parsed.ok) return c.json(...bad(parsed.message));
  const text = parsed.text;
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  try {
    const comment = await collab.getIssueComment(owner, repo, cid);
    if (comment.issue_number !== undefined && comment.issue_number !== n) return c.json(...notFound("comment not found"));
    await collab.editIssueComment(owner, repo, cid, text);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("comment not found"));
    throw err;
  }
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

pulls.delete("/:owner/:repo/pulls/:n/comments/:cid", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const cid = intParam(c, "cid", "bad comment id");
  if (cid instanceof Response) return cid;
  const rid = parsePositiveIntId(c.req.query("review_id"));
  if (rid === null) return c.json(...bad("bad review id"));
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  try {
    const comment = await collab.getIssueComment(owner, repo, cid);
    if (comment.issue_number !== undefined && comment.issue_number !== n) return c.json(...notFound("comment not found"));
    await collab.deleteReviewComment(owner, repo, n, rid, cid);
  } catch (err) {
    if (is404(err)) return c.json(...notFound("comment not found"));
    throw err;
  }
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
): Promise<ReviewDto> {
  const reviews = await collab.listReviews(owner, repo, n);
  const existing = reviews.find((r) => r.decision === "pending" && r.username === forgejoUsername);
  if (existing) return existing;
  const created = await collab.createReview(owner, repo, n, {
    event: "PENDING",
    body: "(pending)",
  });
  return created;
}

async function requireOwnPendingReview(
  c: Context<AppEnv>,
  n: number,
  rid: number,
): Promise<ReviewDto | Response> {
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  // The author may build a pending review of plain COMMENTS on their own PR (the
  // inline line-comment path routes through here); only an approve/request_changes
  // verdict is gated, and that gate lives at submit time.
  if (pull.state === "closed") return c.json(...forbidden("cannot review a closed pull request"));

  const reviews = await collab.listReviews(owner, repo, n);
  const review = reviews.find((item) => item.id === rid);
  if (!review || review.decision !== "pending" || review.username !== c.get("user").username) {
    return c.json(...notFound("pending review not found"));
  }
  return review;
}

pulls.post("/:owner/:repo/pulls/:n/pending-review", async (c) => {
  const n = intParam(c, "n", "bad pull number");
  if (n instanceof Response) return n;
  const { collab, owner, repo } = repoCtxCollab(c);
  const pull = await collab.getPull(owner, repo, n);
  if (!pull) return c.json(...notFound());
  // No author gate here: an author may open a pending review to leave inline
  // COMMENTs on their own PR. The approve/request_changes gate is at submit.
  const review = await findOrCreatePendingReview(collab, owner, repo, n, c.get("user").username);
  return c.json({ review_id: review.id, review });
});

pulls.post("/:owner/:repo/pulls/:n/pending-review/:rid/comments", async (c) => {
  const n = intParam(c, "n", "bad ids");
  if (n instanceof Response) return n;
  const rid = intParam(c, "rid", "bad ids");
  if (rid instanceof Response) return rid;
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

// Origin-proxy variant of the route above: the local Workbench resolves the diff
// anchor to forge positions against the connected core's diff, then forwards the
// already-resolved {path, body, new_position?, old_position?} here. This route
// skips the local line→position resolution and hands the positions straight to
// addCommentToReview. The same own-pending-review gate applies.
pulls.post("/:owner/:repo/pulls/:n/pending-review/:rid/review-comments", async (c) => {
  const n = intParam(c, "n", "bad ids");
  if (n instanceof Response) return n;
  const rid = intParam(c, "rid", "bad ids");
  if (rid instanceof Response) return rid;
  const ws = c.get("workspace");
  const body = await readJsonObject(c.req);
  const path = typeof body.path === "string" ? safeRel(body.path) : null;
  if (!path) return c.json(...bad("path required (safe relative)"));
  if (typeof body.body !== "string" || body.body.trim() === "") return c.json(...bad("body required"));
  const nonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
  const newPos = nonNegInt(body.new_position) ? body.new_position : undefined;
  const oldPos = nonNegInt(body.old_position) ? body.old_position : undefined;
  if (newPos === undefined && oldPos === undefined) {
    return c.json(...bad("new_position or old_position required"));
  }
  const { collab, owner, repo } = repoCtxCollab(c);
  const review = await requireOwnPendingReview(c, n, rid);
  if (review instanceof Response) return review;
  await collab.addCommentToReview(owner, repo, n, rid, {
    path,
    body: body.body,
    ...(newPos !== undefined ? { new_position: newPos } : {}),
    ...(oldPos !== undefined ? { old_position: oldPos } : {}),
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

pulls.post("/:owner/:repo/pulls/:n/pending-review/:rid/submit", async (c) => {
  const n = intParam(c, "n", "bad ids");
  if (n instanceof Response) return n;
  const rid = intParam(c, "rid", "bad ids");
  if (rid instanceof Response) return rid;
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
  // Author self-review gate lives here (not at pending-review creation) so an
  // author can still submit a plain COMMENT review on their own PR; only an
  // approve/request_changes verdict is forbidden.
  if (reviewRequiresNonAuthor(event)) {
    const pull = await collab.getPull(owner, repo, n);
    if (pull?.author_username === c.get("user").username)
      return c.json(...forbidden("cannot approve or request changes on your own pull request"));
  }
  const submitted = await collab.submitPullReview(owner, repo, n, rid, {
    event: eventMap[event as keyof typeof eventMap],
    body: reviewBody.body,
  });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "reviewed" });
  return c.json({ ok: true, review: submitted });
});

// ---------- repo access + topics (settings surface reads) ----------

pulls.get("/:owner/:repo/collaborators", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const members = await collab.listCollaborators(owner, repo);
  // Forgejo's collaborators list returns users without their access role, so
  // resolve each role separately. A read for a single user may 403 (the caller
  // can't see another user's permission) — degrade that entry to null rather
  // than failing the whole list.
  const collaborators: RepoCollaborator[] = await Promise.all(
    members.map(async (member) => ({
      login: member.login,
      permission: await collab.getRepoPermission(owner, repo, member.login).then((p) => (p === "none" ? null : p)).catch(() => null),
    })),
  );
  return c.json({ collaborators });
});

pulls.get("/:owner/:repo/topics", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const topics = await collab.listRepoTopics(owner, repo);
  return c.json({ topics });
});

// Replace the full topic set. Admin-only (topics include the cosheaf-format-*
// marker convention); callers send the complete list — Forgejo replaces, not
// merges.
pulls.put("/:owner/:repo/topics", requireAdminFresh, async (c) => {
  const body = await readJsonObject(c.req);
  const topics = body.topics;
  if (!Array.isArray(topics) || !topics.every((t) => typeof t === "string")) {
    return c.json(...bad("topics must be an array of strings"));
  }
  // Collaboration seam: hosted writes the forge directly, local proxies to the
  // connected core's PUT /topics. requireAdminFresh (above) is already
  // local-aware, so no forge round-trip is needed for the admin gate.
  const { collab, owner, repo } = repoCtxCollab(c);
  await collab.replaceRepoTopics(owner, repo, topics);
  return c.json({ ok: true });
});

// ---------- settings (min_approvals on main) ----------

pulls.get("/:owner/:repo/settings", async (c) => {
  const { collab, owner, repo } = repoCtxCollab(c);
  const bp = await collab.getBranchProtection(owner, repo, "main");
  return c.json({
    min_approvals: bp?.required_approvals ?? 1,
    default_md_format: normalizeDocumentFormatId(c.get("workspace").defaultMdFormat),
  });
});

// PUT /settings is NOT atomic across Forgejo and the SQLite sidecar — by
// design. Forgejo is authoritative for branch protection and marker topics;
// SQLite is local derived index state. Order within the handler:
//
//   1. validate payload (cheap, no side effects)
//   2. update Forgejo branch protection if min_approvals changed
//   3. preserve the historical default_md_format field as coflat-only
//
// If any step throws, the response is a 5xx with the step that failed in
// the body. The repair path is always: PUT /settings again with the same
// payload (idempotent); run `pnpm cli workspace reindex <slug>` only after
// out-of-band repository content changes or sidecar drift.
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
  const { collab, owner, repo } = repoCtxCollab(c);

  let minApprovals: number;
  try {
    const existing = await collab.getBranchProtection(owner, repo, "main");
    minApprovals = body.min_approvals ?? existing?.required_approvals ?? 1;
    if (body.min_approvals !== undefined) {
      if (!existing) {
        await collab.createBranchProtection(owner, repo, {
          branch_name: "main",
          required_approvals: body.min_approvals,
        });
      } else {
        await collab.updateBranchProtection(owner, repo, "main", { required_approvals: body.min_approvals });
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
  return c.json({
    min_approvals: minApprovals,
    default_md_format: defaultMdFormat,
  });
});
