// Pull-request and branch surface. All workflow state lives on Forgejo;
// this route only translates Cosheaf-shaped paths to Forgejo REST calls and
// shapes responses for the client.
//
// Endpoints under /:slug/* :
//   GET    /pulls?state=open|closed|all     — list PRs
//   POST   /pulls                           — open a PR
//   GET    /pulls/:n                        — PR metadata
//   POST   /pulls/:n/merge                  — merge a PR (admin only)
//   POST   /pulls/:n/close                  — close a PR (no merge)
//   GET    /pulls/:n/files                  — per-file diff structured
//   GET    /pulls/:n/file?path=&side=       — raw file at base or head SHA
//   GET    /pulls/:n/reviews                — flat list of reviews
//   POST   /pulls/:n/reviews                — submit a review (event + body)
//   GET    /pulls/:n/comments               — line-comments flattened
//   POST   /pulls/:n/comments               — add a single line-comment
//   PATCH  /pulls/:n/comments/:cid          — edit a comment body
//   DELETE /pulls/:n/comments/:cid?review_id=
//   POST   /pulls/:n/draft-review           — find-or-create PENDING review
//   POST   /pulls/:n/draft-review/:rid/comments
//   POST   /pulls/:n/draft-review/:rid/submit
//
//   GET    /branches/mine                   — your branches with no open PR
//   POST   /branches                        — create a branch from main
//   DELETE /branches/:name                  — delete branch
//
//   GET    /settings                        — { min_approvals }
//   PUT    /settings                        — admin only

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAdminFresh, requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError, type Forgejo, type ForgejoPull, type ForgejoReview } from "../forgejo.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { fileLineToWritePosition, positionToFileLine } from "../diff-position.js";
import type { LineComment } from "../../shared/comments.js";
import type { PrMeta, PullFileStatus } from "../../shared/review.js";
import { userBranchPrefix } from "../../shared/conventions.js";

export const changes = new Hono<AppEnv>();
changes.use("*", requireAuth);
changes.use("/:slug/*", requireMembership());

async function deleteBranchQuietly(fj: Forgejo, owner: string, repo: string, branch: string): Promise<void> {
  try {
    await fj.deleteBranch(owner, repo, branch);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) {
      console.warn(`deleteBranch ${branch}: ${(err as Error).message}`);
    }
  }
}

function parsePr(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeStatus(s: string): PullFileStatus {
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
    author_username: pull.user?.login ?? DELETED_USER_LOGIN,
    created_at: Date.parse(pull.created_at) || 0,
    merged_at: pull.merged_at ? Date.parse(pull.merged_at) : null,
    mergeable: pull.mergeable ?? null,
    head_ref: pull.head.ref,
    head_sha: pull.head.sha,
    base_ref: pull.base.ref,
    base_sha: pull.base.sha,
    additions_total: pull.additions ?? 0,
    deletions_total: pull.deletions ?? 0,
    files_changed: pull.changed_files ?? 0,
  };
}

// Latest-per-user approval count, ignoring older reviews from the same user.
async function approvalCounts(
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ approvals: number; rejections: number }> {
  const reviews = await fj.listReviews(owner, repo, prNumber);
  const latestByUser = new Map<string, ForgejoReview>();
  const ordered = [...reviews].sort((a, b) => {
    const at = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const bt = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return at - bt || (a.id ?? 0) - (b.id ?? 0);
  });
  for (const r of ordered) {
    if (!r.user) continue; // deleted account; review still counted by Forgejo
    if (r.state === "APPROVED" || r.state === "REQUEST_CHANGES") {
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
async function mergeWithRetry(
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  sudo: string,
  opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const Do = opts.Do ?? "squash";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fj.mergePull(owner, repo, prNumber, { Do, sudo, force: opts.force });
      return { ok: true };
    } catch (err) {
      lastErr = err;
      if (err instanceof ForgejoError && err.status === 405 && /try again/i.test(err.bodyText)) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return forgejoErrToResult(err);
    }
  }
  return forgejoErrToResult(lastErr);
}

function forgejoErrToResult(err: unknown): { ok: false; status: number; message: string } {
  if (err instanceof ForgejoError) {
    // 4xx → caller violated a precondition (conflicts, missing approvals,
    // branch protection): 409. 5xx → Forgejo upstream is sick: 502.
    if (err.status >= 500) return { ok: false, status: 502, message: err.message };
    return { ok: false, status: 409, message: err.message };
  }
  return { ok: false, status: 500, message: (err as Error)?.message ?? "merge failed" };
}

// ---------- branches ----------

changes.get("/:slug/branches/mine", async (c) => {
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const [branches, pulls] = await Promise.all([
    fj.listBranches(owner, repo),
    fj.listPulls(owner, repo, "open"),
  ]);
  const openHeads = new Set(pulls.map((p) => p.head.ref));
  // Identify "your branches" by the `user/<sudo>/` prefix we enforce on
  // file PUT auto-create. This is deterministic — unlike scanning the
  // latest commit's author/committer, which falls over after rebase,
  // cherry-pick, or a web-UI edit attributed to a different user.
  const prefix = userBranchPrefix(sudo);
  const mine = branches
    .filter((b) => b.name.startsWith(prefix) && !openHeads.has(b.name))
    .map((b) => ({
      name: b.name,
      commit_sha: b.commit?.id ?? null,
      updated_at: b.commit?.timestamp ? Date.parse(b.commit.timestamp) : 0,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ branches: mine });
});

changes.post("/:slug/branches", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  if (
    !body?.name ||
    !/^[A-Za-z0-9._/-]+$/.test(body.name) ||
    body.name === "main" ||
    body.name.includes("..") ||
    body.name.startsWith("/") ||
    body.name.endsWith("/")
  )
    return c.json({ error: "valid branch name required", code: "validation" }, 400);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  try {
    await fj.createBranch(owner, repo, { newBranchName: body.name, oldBranchName: "main", sudo });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409)
      return c.json({ error: "branch already exists", code: "conflict" }, 409);
    throw err;
  }
  return c.json({ name: body.name }, 201);
});

changes.delete("/:slug/branches/:name", async (c) => {
  const name = c.req.param("name");
  if (!name || name === "main")
    return c.json({ error: "branch name required (not main)", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await deleteBranchQuietly(fj, owner, repo, name);
  return c.json({ ok: true });
});

// ---------- pulls ----------

changes.get("/:slug/pulls", async (c) => {
  const state = c.req.query("state") ?? "open";
  if (state !== "open" && state !== "closed" && state !== "all")
    return c.json({ error: "state must be open|closed|all", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const pulls = await fj.listPulls(owner, repo, state);
  return c.json({ pulls: pulls.map(prMeta) });
});

changes.post("/:slug/pulls", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    head?: string;
    base?: string;
    title?: string;
    body?: string;
  };
  if (!body.head) return c.json({ error: "head required", code: "validation" }, 400);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  try {
    const pr = await fj.createPull(owner, repo, {
      head: body.head,
      base: body.base ?? "main",
      title: body.title ?? body.head,
      body: body.body ?? "",
      sudo,
    });
    c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: pr.number, action: "opened" });
    return c.json(prMeta(pr), 201);
  } catch (err) {
    // Forgejo POST /pulls returns 409 for several reasons — empty diff,
    // an already-open PR for this head→base, or a duplicate title — and
    // 422 for validation. Pass the actual message through so the client
    // can show something useful.
    if (err instanceof ForgejoError && (err.status === 409 || err.status === 422)) {
      // Pass the Forgejo message through (empty diff, duplicate-PR, etc.)
      // rather than collapsing every 4xx to "no diff vs base".
      return c.json({ error: err.message, code: "conflict" }, 409);
    }
    throw err;
  }
});

changes.get("/:slug/pulls/:n", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, n);
  if (!pull) return c.json({ error: "not found", code: "not_found" }, 404);
  return c.json(prMeta(pull));
});

changes.post("/:slug/pulls/:n/merge", requireAdminFresh, async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    Do?: "squash" | "merge" | "rebase";
    force?: boolean;
  };
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  // Admins can bypass the required-approvals branch protection rule by
  // passing `force: true`. Callers default to false (normal review flow).
  const result = await mergeWithRetry(fj, owner, repo, n, sudo, { Do: body.Do, force: body.force });
  if (!result.ok) {
    const code = result.status === 502 ? "upstream" : result.status === 500 ? "internal" : "conflict";
    return c.json({ error: `merge failed: ${result.message}`, code }, result.status as 409 | 502 | 500);
  }
  const pull = await fj.getPull(owner, repo, n);
  if (pull) await deleteBranchQuietly(fj, owner, repo, pull.head.ref);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "merged" });
  return c.json({ ok: true });
});

changes.post("/:slug/pulls/:n/close", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const ws = c.get("workspace");
  if (ws.role === "read") return c.json({ error: "write access required", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.editPull(owner, repo, n, { state: "closed" }, sudo);
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "closed" });
  return c.json({ ok: true });
});

// ---------- diff + raw file at a side ----------

changes.get("/:slug/pulls/:n/files", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const [metas, unified] = await Promise.all([
    fj.listPullFiles(owner, repo, n),
    fj.getPullDiff(owner, repo, n),
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

changes.get("/:slug/pulls/:n/file", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const path = c.req.query("path");
  const side = c.req.query("side");
  if (!path) return c.json({ error: "path required", code: "validation" }, 400);
  if (side !== "base" && side !== "head")
    return c.json({ error: "side must be base or head", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, n);
  if (!pull) return c.json({ error: "not found", code: "not_found" }, 404);
  const sha = side === "base" ? pull.base.sha : pull.head.sha;
  try {
    const content = await fj.getRawFile(owner, repo, sha, path);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404)
      return c.json({ error: "file not present at this side", code: "not_found" }, 404);
    throw err;
  }
});

// ---------- reviews (approve / request-changes / comment) ----------

const EVENT_MAP = {
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "REQUEST_CHANGES",
  COMMENT: "COMMENT",
} as const;

changes.get("/:slug/pulls/:n/reviews", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const reviews = await fj.listReviews(owner, repo, n);
  const out = reviews
    .filter((r) => r.state === "APPROVED" || r.state === "REQUEST_CHANGES" || r.state === "COMMENT")
    .map((r) => ({
      username: r.user?.login ?? DELETED_USER_LOGIN,
      decision:
        r.state === "APPROVED"
          ? ("approve" as const)
          : r.state === "REQUEST_CHANGES"
            ? ("request_changes" as const)
            : ("comment" as const),
      comment: r.body || null,
      created_at: r.submitted_at ? Date.parse(r.submitted_at) : 0,
    }));
  const counts = await approvalCounts(fj, owner, repo, n);
  return c.json({ reviews: out, approvals: counts.approvals, rejections: counts.rejections });
});

changes.post("/:slug/pulls/:n/reviews", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const ws = c.get("workspace");
  if (ws.role === "read") return c.json({ error: "write access required", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, n);
  if (!pull) return c.json({ error: "not found", code: "not_found" }, 404);
  if (pull.user?.login === sudo)
    return c.json({ error: "cannot review your own pull request", code: "forbidden" }, 403);

  const payload = (await c.req.json().catch(() => ({}))) as { event?: string; body?: string | null };
  const event = payload.event as keyof typeof EVENT_MAP | undefined;
  if (!event || !(event in EVENT_MAP))
    return c.json({ error: "event must be APPROVE|REQUEST_CHANGES|COMMENT", code: "validation" }, 400);

  await fj.createReview(owner, repo, n, {
    event: EVENT_MAP[event],
    body: payload.body ?? "",
    sudo,
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "reviewed" });

  const counts = await approvalCounts(fj, owner, repo, n);
  return c.json({ ok: true, approvals: counts.approvals, rejections: counts.rejections });
});

// ---------- line comments ----------

interface CommentInput { path: string; line: number; side: "new" | "old"; body: string }

function parseCommentInput(raw: unknown): CommentInput | null {
  const v = raw as Partial<CommentInput> | null;
  if (!v?.path || !v.line || !v.body || (v.side !== "new" && v.side !== "old")) return null;
  return { path: v.path, line: v.line, side: v.side, body: v.body };
}

async function resolveLinePosition(
  fj: Forgejo,
  owner: string,
  repo: string,
  n: number,
  input: CommentInput,
): Promise<{ new_position?: number; old_position?: number } | { error: string }> {
  const unified = await fj.getPullDiff(owner, repo, n);
  const filePatch = splitUnifiedDiff(unified).find((p) => p.path === input.path)?.patch;
  if (!filePatch) return { error: "file not part of this PR" };
  const pos = fileLineToWritePosition(filePatch, input.line, input.side);
  if (!pos) return { error: "line not present in diff" };
  return pos;
}

changes.get("/:slug/pulls/:n/comments", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const [reviews, metas, unified] = await Promise.all([
    fj.listReviews(owner, repo, n),
    fj.listPullFiles(owner, repo, n),
    fj.getPullDiff(owner, repo, n),
  ]);
  const patchesByPath = new Map(splitUnifiedDiff(unified).map((p) => [p.path, p.patch]));
  const status = new Map(metas.map((m) => [m.filename, m.status]));
  const allComments = (
    await Promise.all(reviews.map((r) => fj.listReviewComments(owner, repo, n, r.id).catch(() => [])))
  ).flat();
  const out: LineComment[] = allComments.map((cm) => {
    const patch = patchesByPath.get(cm.path);
    const pos = cm.position ?? cm.original_position;
    const mapped = patch && pos !== null ? positionToFileLine(patch, pos) : null;
    return {
      id: cm.id,
      review_id: cm.pull_request_review_id,
      path: cm.path,
      line: mapped?.line ?? null,
      side: mapped?.side ?? (status.get(cm.path) === "deleted" ? "old" : "new"),
      body: cm.body,
      author_username: cm.user?.login ?? DELETED_USER_LOGIN,
      created_at: Date.parse(cm.created_at) || 0,
      updated_at: Date.parse(cm.updated_at) || 0,
      outdated: cm.position === null,
    };
  });
  return c.json({ comments: out });
});

changes.post("/:slug/pulls/:n/comments", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const ws = c.get("workspace");
  if (ws.role === "read") return c.json({ error: "write access required", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, n);
  if (!pull) return c.json({ error: "not found", code: "not_found" }, 404);
  if (pull.user?.login === sudo)
    return c.json({ error: "cannot comment on your own pull request", code: "forbidden" }, 403);

  const input = parseCommentInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: "path, line, side, body required", code: "validation" }, 400);
  const pos = await resolveLinePosition(fj, owner, repo, n, input);
  if ("error" in pos) return c.json({ error: pos.error, code: "validation" }, 400);

  await fj.createReview(owner, repo, n, {
    event: "COMMENT",
    body: "",
    sudo,
    comments: [{ path: input.path, body: input.body, ...pos }],
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

changes.patch("/:slug/pulls/:n/comments/:cid", async (c) => {
  const n = parsePr(c.req.param("n"));
  const cid = Number(c.req.param("cid"));
  if (n === null || !cid) return c.json({ error: "bad ids", code: "validation" }, 400);
  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body) return c.json({ error: "body required", code: "validation" }, 400);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.editReviewComment(owner, repo, cid, body.body, sudo);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

changes.delete("/:slug/pulls/:n/comments/:cid", async (c) => {
  const n = parsePr(c.req.param("n"));
  const cid = Number(c.req.param("cid"));
  const rid = Number(c.req.query("review_id"));
  if (n === null || !cid || !rid)
    return c.json({ error: "review_id query required", code: "validation" }, 400);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.deleteReviewComment(owner, repo, n, rid, cid, sudo);
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

// ---------- draft (PENDING) reviews ----------

async function findOrCreatePendingReview(
  fj: Forgejo,
  owner: string,
  repo: string,
  n: number,
  forgejoUsername: string,
): Promise<number> {
  const reviews = await fj.listReviews(owner, repo, n);
  const existing = reviews.find((r) => r.state === "PENDING" && r.user?.login === forgejoUsername);
  if (existing) return existing.id;
  const created = await fj.createReview(owner, repo, n, {
    event: "PENDING",
    body: "(draft)",
    sudo: forgejoUsername,
  });
  return created.id;
}

changes.post("/:slug/pulls/:n/draft-review", async (c) => {
  const n = parsePr(c.req.param("n"));
  if (n === null) return c.json({ error: "bad pull number", code: "validation" }, 400);
  const ws = c.get("workspace");
  if (ws.role === "read") return c.json({ error: "write access required", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, n);
  if (!pull) return c.json({ error: "not found", code: "not_found" }, 404);
  if (pull.user?.login === sudo)
    return c.json({ error: "cannot review your own pull request", code: "forbidden" }, 403);
  const review_id = await findOrCreatePendingReview(fj, owner, repo, n, sudo);
  return c.json({ review_id });
});

changes.post("/:slug/pulls/:n/draft-review/:rid/comments", async (c) => {
  const n = parsePr(c.req.param("n"));
  const rid = Number(c.req.param("rid"));
  if (n === null || !rid) return c.json({ error: "bad ids", code: "validation" }, 400);
  const ws = c.get("workspace");
  if (ws.role === "read") return c.json({ error: "write access required", code: "forbidden" }, 403);
  const input = parseCommentInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: "path, line, side, body required", code: "validation" }, 400);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pos = await resolveLinePosition(fj, owner, repo, n, input);
  if ("error" in pos) return c.json({ error: pos.error, code: "validation" }, 400);
  await fj.addCommentToReview(owner, repo, n, rid, {
    path: input.path,
    body: input.body,
    ...pos,
    sudo,
  });
  c.get("sse").publish(ws.slug, { type: "pull", number: n, action: "commented" });
  return c.json({ ok: true });
});

changes.post("/:slug/pulls/:n/draft-review/:rid/submit", async (c) => {
  const n = parsePr(c.req.param("n"));
  const rid = Number(c.req.param("rid"));
  if (n === null || !rid) return c.json({ error: "bad ids", code: "validation" }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    event?: "approve" | "request_changes" | "comment";
    body?: string;
  } | null;
  if (!body?.event) return c.json({ error: "event required", code: "validation" }, 400);
  const eventMap = { approve: "APPROVED", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.submitPullReview(owner, repo, n, rid, {
    event: eventMap[body.event],
    body: body.body ?? "",
    sudo,
  });
  c.get("sse").publish(c.get("workspace").slug, { type: "pull", number: n, action: "reviewed" });
  return c.json({ ok: true });
});

// ---------- settings (min_approvals on main) ----------

changes.get("/:slug/settings", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const bp = await fj.getBranchProtection(owner, repo, "main");
  return c.json({ min_approvals: bp?.required_approvals ?? 1 });
});

changes.put("/:slug/settings", requireAdminFresh, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { min_approvals?: number } | null;
  if (!body || !Number.isInteger(body.min_approvals) || (body.min_approvals as number) < 1)
    return c.json({ error: "min_approvals must be >= 1", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const existing = await fj.getBranchProtection(owner, repo, "main");
  if (!existing) {
    await fj.createBranchProtection(owner, repo, {
      branch_name: "main",
      required_approvals: body.min_approvals,
    });
  } else {
    await fj.updateBranchProtection(owner, repo, "main", { required_approvals: body.min_approvals });
  }
  return c.json({ min_approvals: body.min_approvals });
});
