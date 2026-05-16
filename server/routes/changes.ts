// Manages branch / pull-request workflow: list/create/discard, publish
// (direct/review), approve/request-changes/comment/close. The filename is
// `changes.ts` for git-blame continuity; the workflow vocabulary is
// branch / pull-request throughout (table is `branches`, types are Branch /
// BranchState).

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError, type Forgejo, type ForgejoReview } from "../forgejo.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { fileLineToWritePosition, positionToFileLine } from "../diff-position.js";
import type { LineComment } from "../../shared/comments.js";
import {
  createBranchRow,
  deleteBranchRow,
  getBranchRow,
  getBranchByPr,
  listInReview,
  listOpenForUser,
  setBranchState,
  type BranchRow,
} from "../changes.js";

// Best-effort branch delete; ignores 404s (branch already gone).
async function deleteBranchQuietly(fj: Forgejo, owner: string, repo: string, branch: string, ctx?: string): Promise<void> {
  try {
    await fj.deleteBranch(owner, repo, branch);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404) && ctx) {
      console.warn(`${ctx}: ${(err as Error).message}`);
    }
  }
}

// Forgejo occasionally returns 405 "Please try again later" right after an
// auto-approve review lands but before the merge gate sees it. Retry with backoff.
async function mergeWithRetry(fj: Forgejo, owner: string, repo: string, prNumber: number, sudo: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fj.mergePull(owner, repo, prNumber, { Do: "squash", sudo });
      return null;
    } catch (err) {
      lastErr = err;
      if (err instanceof ForgejoError && err.status === 405 && /try again/i.test(err.bodyText)) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return err;
    }
  }
  return lastErr;
}

export const changes = new Hono<AppEnv>();
changes.use("*", requireAuth);
changes.use("/:slug/*", requireMembership());

// ---------- list / create / discard ----------

changes.get("/:slug/branches", (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const rows = listOpenForUser(c.get("db"), ws.id, user.id);
  return c.json({ changes: rows });
});

// All open branches with PRs (any author) — feeds the Activity panel.
changes.get("/:slug/branches/open", (c) => {
  const ws = c.get("workspace");
  const rows = c
    .get("db")
    .prepare(
      "SELECT * FROM branches WHERE workspace_id = ? AND state IN ('review', 'changes_requested') ORDER BY updated_at DESC",
    )
    .all(ws.id);
  return c.json({ changes: rows });
});

changes.post("/:slug/branch", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const { fj, owner, repo } = c.get("repoCtx");
  const mainBranch = await fj.getBranch(owner, repo, "main");
  const change = createBranchRow(c.get("db"), {
    workspaceId: ws.id,
    authorUserId: user.id,
    baseSha: mainBranch?.commit?.id ?? null,
    title: body.title ?? null,
  });
  return c.json(change, 201);
});

changes.delete("/:slug/branch/:id", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const id = c.req.param("id");
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.author_user_id !== user.id)
    return c.json({ error: "not your change", code: "forbidden" }, 403);
  if (change.state !== "draft")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);

  const { fj, owner, repo } = c.get("repoCtx");
  await deleteBranchQuietly(fj, owner, repo, change.branch_name, "deleteBranch on discard");
  setBranchState(c.get("db"), ws.id, change.id, "closed");
  c.get("sse").publish(ws.slug, { type: "branch_closed", id: change.id });
  return c.json({ ok: true });
});

// ---------- publish ----------

changes.post("/:slug/publish", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    branchId?: string;
    mode?: "direct" | "review";
    title?: string;
    body?: string;
  };
  if (!body.branchId) return c.json({ error: "branchId required", code: "validation" }, 400);
  const change = getBranchRow(c.get("db"), ws.id, body.branchId);
  if (!change) return c.json({ error: "change not found", code: "not_found" }, 404);
  if (change.author_user_id !== user.id)
    return c.json({ error: "not your change", code: "forbidden" }, 403);
  if (change.state !== "draft" && change.state !== "review" && change.state !== "changes_requested")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);

  // Non-owners are forced to mode=review.
  let mode = body.mode ?? (ws.role === "owner" ? "direct" : "review");
  if (mode === "direct" && ws.role !== "owner") mode = "review";

  const { fj, owner, repo, sudo } = c.get("repoCtx");

  // Ensure the branch exists (it might not if the user created a change via
  // POST /change but never saved anything).
  const branchExists = await fj.getBranch(owner, repo, change.branch_name);
  if (!branchExists) {
    setBranchState(c.get("db"), ws.id, change.id, "closed");
    return c.json({ ok: true, message: "nothing to publish (no commits)" });
  }

  // Open or reuse a PR.
  let prNumber = change.pr_number;
  if (!prNumber) {
    try {
      const pr = await fj.createPull(owner, repo, {
        head: change.branch_name,
        base: "main",
        title: body.title ?? change.title ?? `change ${change.id}`,
        body: body.body ?? `cosheaf-change-id: ${change.id}`,
        sudo,
      });
      prNumber = pr.number;
      setBranchState(c.get("db"), ws.id, change.id, change.state, { pr_number: prNumber });
    } catch (err) {
      if (err instanceof ForgejoError && err.status === 409) {
        // No diff vs main → nothing to publish; clean up the empty branch.
        await deleteBranchQuietly(fj, owner, repo, change.branch_name);
        setBranchState(c.get("db"), ws.id, change.id, "closed");
        return c.json({ ok: true, message: "nothing to publish" });
      }
      throw err;
    }
  }

  if (prNumber && (body.title !== undefined || body.body !== undefined)) {
    await fj.editPull(owner, repo, prNumber, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
    }, sudo);
  }

  if (mode === "review") {
    setBranchState(c.get("db"), ws.id, change.id, "review");
    c.get("sse").publish(ws.slug, { type: "branch_review", id: change.id, pr: prNumber });
    return c.json({ ok: true, mode, branchId: change.id, pr_number: prNumber });
  }

  // direct: auto-approve as cosheaf-admin to satisfy required_approvals (Forgejo's
  // apply_to_admins flag doesn't bypass merge gates in our deployment), then merge.
  try {
    await fj.createReview(owner, repo, prNumber, {
      event: "APPROVED",
      body: `auto-approved on direct publish by ${sudo}`,
      sudo: owner,
    });
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 422)) {
      console.warn(`auto-approve failed: ${(err as Error).message}`);
    }
  }
  const mergeErr = await mergeWithRetry(fj, owner, repo, prNumber, owner);
  if (mergeErr) {
    return c.json({ error: `merge failed: ${(mergeErr as Error).message}`, code: "conflict", pr_number: prNumber }, 409);
  }
  await deleteBranchQuietly(fj, owner, repo, change.branch_name, "deleteBranch after merge");
  setBranchState(c.get("db"), ws.id, change.id, "merged");
  c.get("sse").publish(ws.slug, { type: "branch_merged", id: change.id });
  return c.json({ ok: true, mode, branchId: change.id, pr_number: prNumber });
});

// ---------- approve / request changes / comment / close ----------

async function approve(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "verifier role required", code: "forbidden" }, 403);
  const id = c.req.param("id") ?? "";
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state !== "review" || !change.pr_number)
    return c.json({ error: "change is not in review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const { fj, owner, repo, sudo } = c.get("repoCtx");

  await fj.createReview(owner, repo, change.pr_number, {
    event: "APPROVED",
    body: body.comment ?? "",
    sudo,
  });

  const bp = await fj.getBranchProtection(owner, repo, "main");
  const threshold = bp?.required_approvals ?? 1;
  const counts = await approvalCounts(fj, owner, repo, change.pr_number);
  if (counts.approvals >= threshold && counts.rejections === 0) {
    const mergeErr = await mergeWithRetry(fj, owner, repo, change.pr_number, owner);
    if (!mergeErr) {
      await deleteBranchQuietly(fj, owner, repo, change.branch_name);
      setBranchState(c.get("db"), ws.id, change.id, "merged");
      c.get("sse").publish(ws.slug, { type: "branch_merged", id: change.id });
    } else {
      console.warn(`merge failed: ${(mergeErr as Error).message}`);
    }
  }
  c.get("sse").publish(ws.slug, { type: "branch_approved", id: change.id });

  const after = getBranchRow(c.get("db"), ws.id, change.id) as BranchRow;
  const afterCounts = await approvalCounts(fj, owner, repo, change.pr_number);
  return c.json({
    decision: "approve",
    branchId: change.id,
    state: after.state,
    approvals: afterCounts.approvals,
    rejections: afterCounts.rejections,
  });
}

async function requestChanges(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "verifier role required", code: "forbidden" }, 403);
  const id = c.req.param("id") ?? "";
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state !== "review" || !change.pr_number)
    return c.json({ error: "change is not in review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.createReview(owner, repo, change.pr_number, {
    event: "REQUEST_CHANGES",
    body: body.comment ?? "",
    sudo,
  });
  setBranchState(c.get("db"), ws.id, change.id, "changes_requested");
  c.get("sse").publish(ws.slug, { type: "branch_changes_requested", id: change.id });

  const counts = await approvalCounts(fj, owner, repo, change.pr_number);
  return c.json({
    decision: "request_changes",
    branchId: change.id,
    state: "changes_requested",
    approvals: counts.approvals,
    rejections: counts.rejections,
  });
}

async function commentChange(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "verifier role required", code: "forbidden" }, 403);
  const id = c.req.param("id") ?? "";
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if ((change.state !== "review" && change.state !== "changes_requested") || !change.pr_number)
    return c.json({ error: "change is not open for review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.createReview(owner, repo, change.pr_number, {
    event: "COMMENT",
    body: body.comment ?? "",
    sudo,
  });
  c.get("sse").publish(ws.slug, { type: "branch_commented", id: change.id });
  return c.json({ ok: true, branchId: change.id, state: change.state });
}

async function closeChange(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  const user = c.get("user");
  const id = c.req.param("id") ?? "";
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state === "merged" || change.state === "closed")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);
  if (change.author_user_id !== user.id && ws.role !== "owner")
    return c.json({ error: "not allowed to close this change", code: "forbidden" }, 403);

  const { fj, owner, repo, sudo } = c.get("repoCtx");
  if (change.pr_number) {
    try {
      await fj.editPull(owner, repo, change.pr_number, { state: "closed" }, sudo);
    } catch (err) {
      console.warn(`close PR: ${(err as Error).message}`);
    }
  }
  await deleteBranchQuietly(fj, owner, repo, change.branch_name, "deleteBranch on close");
  setBranchState(c.get("db"), ws.id, change.id, "closed");
  c.get("sse").publish(ws.slug, { type: "branch_closed", id: change.id });
  return c.json({ ok: true, branchId: change.id, state: "closed" });
}

async function approvalCounts(
  fj: import("../forgejo.js").Forgejo,
  owner: string,
  repo: string,
  index: number,
): Promise<{ approvals: number; rejections: number }> {
  const reviews = await fj.listReviews(owner, repo, index);
  const latestByUser = new Map<string, ForgejoReview>();
  const ordered = [...reviews].sort((a, b) => {
    const at = a.submitted_at ? Date.parse(a.submitted_at) : 0;
    const bt = b.submitted_at ? Date.parse(b.submitted_at) : 0;
    return at - bt || (a.id ?? 0) - (b.id ?? 0);
  });
  for (const r of ordered) {
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

changes.post("/:slug/branch/:id/approve", (c) => approve(c));
changes.post("/:slug/branch/:id/request-changes", (c) => requestChanges(c));
changes.post("/:slug/branch/:id/comment", (c) => commentChange(c));
changes.post("/:slug/branch/:id/close", (c) => closeChange(c));

// ---------- approvals listing ----------

changes.get("/:slug/branch/:id/approvals", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id") ?? "";
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change || !change.pr_number) return c.json({ approvals: [] });
  const { fj, owner, repo } = c.get("repoCtx");
  const reviews = await fj.listReviews(owner, repo, change.pr_number);
  const db = c.get("db");
  const approvals = reviews
    .filter((r) => r.state === "APPROVED" || r.state === "REQUEST_CHANGES" || r.state === "COMMENT")
    .map((r) => {
      const cs = db
        .prepare("SELECT id, username FROM users WHERE forgejo_username = ?")
        .get(r.user.login) as { id: number; username: string } | undefined;
      return {
        verifier_user_id: cs?.id ?? -1,
        username: cs?.username ?? r.user.login,
        decision:
          r.state === "APPROVED"
            ? ("approve" as const)
            : r.state === "REQUEST_CHANGES"
              ? ("request_changes" as const)
              : ("comment" as const),
        comment: r.body || null,
        created_at: r.submitted_at ? Date.parse(r.submitted_at) : 0,
      };
    });
  return c.json({ approvals });
});

// ---------- PR view (header, file list, per-file diff, raw content) ----------

changes.get("/:slug/branch/:id/pr", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const { fj, owner, repo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, change.pr_number);
  if (!pull) return c.json({ error: "pull not found upstream", code: "not_found" }, 404);

  const meta = {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: change.state,
    author_user_id: change.author_user_id,
    author_username: pull.user.login,
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
  return c.json({ pr: meta });
});

changes.get("/:slug/branch/:id/diff", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const { fj, owner, repo } = c.get("repoCtx");
  const [metas, unified] = await Promise.all([
    fj.listPullFiles(owner, repo, change.pr_number),
    fj.getPullDiff(owner, repo, change.pr_number),
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

changes.get("/:slug/branch/:id/file", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const path = c.req.query("path");
  const side = c.req.query("side");
  if (!path) return c.json({ error: "path required", code: "validation" }, 400);
  if (side !== "base" && side !== "head")
    return c.json({ error: "side must be base or head", code: "validation" }, 400);

  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const { fj, owner, repo } = c.get("repoCtx");
  const pull = await fj.getPull(owner, repo, change.pr_number);
  if (!pull) return c.json({ error: "pull not found upstream", code: "not_found" }, 404);

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

changes.get("/:slug/branch/:id/comments", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getBranchRow(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const { fj, owner, repo } = c.get("repoCtx");
  const [reviews, metas, unified] = await Promise.all([
    fj.listReviews(owner, repo, change.pr_number),
    fj.listPullFiles(owner, repo, change.pr_number),
    fj.getPullDiff(owner, repo, change.pr_number),
  ]);
  const patchesByPath = new Map(
    splitUnifiedDiff(unified).map((p) => [p.path, p.patch]),
  );
  const status = new Map(metas.map((m) => [m.filename, m.status]));

  // Per-review fan-out. PRs usually have <10 reviews, so this is fine.
  const allComments = (
    await Promise.all(
      reviews.map((r) =>
        fj.listReviewComments(owner, repo, change.pr_number as number, r.id).catch(() => []),
      ),
    )
  ).flat();

  const out: LineComment[] = allComments.map((cm) => {
    const patch = patchesByPath.get(cm.path);
    const pos = cm.position ?? cm.original_position;
    const mapped = patch && pos !== null ? positionToFileLine(patch, pos) : null;
    const outdated = cm.position === null;
    return {
      id: cm.id,
      review_id: cm.pull_request_review_id,
      path: cm.path,
      line: mapped?.line ?? null,
      side: mapped?.side ?? (status.get(cm.path) === "deleted" ? "old" : "new"),
      body: cm.body,
      author_username: cm.user.login,
      created_at: Date.parse(cm.created_at) || 0,
      updated_at: Date.parse(cm.updated_at) || 0,
      outdated,
    };
  });
  return c.json({ comments: out });
});

interface CommentInput {
  path: string;
  line: number;
  side: "new" | "old";
  body: string;
}

function parseCommentInput(raw: unknown): CommentInput | null {
  const v = raw as Partial<CommentInput> | null;
  if (!v?.path || !v.line || !v.body || (v.side !== "new" && v.side !== "old")) return null;
  return { path: v.path, line: v.line, side: v.side, body: v.body };
}

function gateReviewerWrite(
  c: import("hono").Context<AppEnv>,
  change: BranchRow | null | undefined,
): Response | { change: BranchRow & { pr_number: number } } {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "only owners and verifiers can comment", code: "forbidden" }, 403);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);
  if (c.get("user").id === change.author_user_id)
    return c.json({ error: "authors cannot review their own change", code: "forbidden" }, 403);
  return { change: change as BranchRow & { pr_number: number } };
}

async function resolveLinePosition(
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  input: CommentInput,
): Promise<{ new_position?: number; old_position?: number } | { error: string }> {
  const unified = await fj.getPullDiff(owner, repo, prNumber);
  const filePatch = splitUnifiedDiff(unified).find((p) => p.path === input.path)?.patch;
  if (!filePatch) return { error: "file not part of this PR" };
  const pos = fileLineToWritePosition(filePatch, input.line, input.side);
  if (!pos) return { error: "line not present in diff" };
  return pos;
}

changes.post("/:slug/branch/:id/comments", async (c) => {
  const gate = gateReviewerWrite(c, getBranchRow(c.get("db"), c.get("workspace").id, c.req.param("id")));
  if (gate instanceof Response) return gate;
  const { change } = gate;

  const input = parseCommentInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: "path, line, side, body required", code: "validation" }, 400);

  const ws = c.get("workspace");
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pos = await resolveLinePosition(fj, owner, repo, change.pr_number, input);
  if ("error" in pos) return c.json({ error: pos.error, code: "validation" }, 400);

  await fj.createReview(owner, repo, change.pr_number, {
    event: "COMMENT",
    body: "",
    sudo,
    comments: [{ path: input.path, body: input.body, ...pos }],
  });
  c.get("sse").publish(ws.slug, { type: "comment_added", id: change.id });
  return c.json({ ok: true });
});

changes.patch("/:slug/branch/:id/comments/:commentId", async (c) => {
  const ws = c.get("workspace");
  const change = getBranchRow(c.get("db"), ws.id, c.req.param("id"));
  if (!change?.pr_number) return c.json({ error: "not found", code: "not_found" }, 404);
  const commentId = Number(c.req.param("commentId"));
  if (!commentId) return c.json({ error: "bad commentId", code: "validation" }, 400);

  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body) return c.json({ error: "body required", code: "validation" }, 400);

  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.editReviewComment(owner, repo, commentId, body.body, sudo);
  c.get("sse").publish(ws.slug, { type: "comment_edited", id: change.id });
  return c.json({ ok: true });
});

changes.delete("/:slug/branch/:id/comments/:commentId", async (c) => {
  const ws = c.get("workspace");
  const change = getBranchRow(c.get("db"), ws.id, c.req.param("id"));
  if (!change?.pr_number) return c.json({ error: "not found", code: "not_found" }, 404);
  const commentId = Number(c.req.param("commentId"));
  const reviewId = Number(c.req.query("review_id"));
  if (!commentId || !reviewId)
    return c.json({ error: "review_id query param required", code: "validation" }, 400);

  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.deleteReviewComment(owner, repo, change.pr_number, reviewId, commentId, sudo);
  c.get("sse").publish(ws.slug, { type: "comment_deleted", id: change.id });
  return c.json({ ok: true });
});

// Reuse the reviewer's existing PENDING review on this PR, or create a new
// one. Forgejo allows multiple PENDING reviews per user; we deduplicate to
// avoid leaking drafts on accidental double-clicks.
async function findOrCreatePendingReview(
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  forgejoUsername: string,
): Promise<number> {
  const reviews = await fj.listReviews(owner, repo, prNumber);
  const existing = reviews.find(
    (r) => r.state === "PENDING" && r.user?.login === forgejoUsername,
  );
  if (existing) return existing.id;
  // Forgejo rejects an empty body on PENDING; placeholder gets replaced when
  // the review is submitted with the user's actual body.
  const created = await fj.createReview(owner, repo, prNumber, {
    event: "PENDING",
    body: "(draft)",
    sudo: forgejoUsername,
  });
  return created.id;
}

changes.post("/:slug/branch/:id/draft-review", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "only owners and verifiers can review", code: "forbidden" }, 403);
  const change = getBranchRow(c.get("db"), ws.id, c.req.param("id"));
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);
  if (c.get("user").id === change.author_user_id)
    return c.json({ error: "authors cannot review their own change", code: "forbidden" }, 403);

  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const review_id = await findOrCreatePendingReview(fj, owner, repo, change.pr_number, sudo);
  return c.json({ review_id });
});

changes.post("/:slug/branch/:id/draft-review/:reviewId/comments", async (c) => {
  const gate = gateReviewerWrite(c, getBranchRow(c.get("db"), c.get("workspace").id, c.req.param("id")));
  if (gate instanceof Response) return gate;
  const { change } = gate;
  const reviewId = Number(c.req.param("reviewId"));
  if (!reviewId) return c.json({ error: "bad reviewId", code: "validation" }, 400);

  const input = parseCommentInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: "path, line, side, body required", code: "validation" }, 400);

  const ws = c.get("workspace");
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const pos = await resolveLinePosition(fj, owner, repo, change.pr_number, input);
  if ("error" in pos) return c.json({ error: pos.error, code: "validation" }, 400);

  await fj.addCommentToReview(owner, repo, change.pr_number, reviewId, {
    path: input.path,
    body: input.body,
    ...pos,
    sudo,
  });
  c.get("sse").publish(ws.slug, { type: "comment_added", id: change.id });
  return c.json({ ok: true });
});

changes.post("/:slug/branch/:id/draft-review/:reviewId/submit", async (c) => {
  const ws = c.get("workspace");
  const change = getBranchRow(c.get("db"), ws.id, c.req.param("id"));
  if (!change?.pr_number) return c.json({ error: "not found", code: "not_found" }, 404);
  const reviewId = Number(c.req.param("reviewId"));
  const body = (await c.req.json().catch(() => null)) as {
    event?: "approve" | "request_changes" | "comment";
    body?: string;
  } | null;
  if (!reviewId || !body?.event)
    return c.json({ error: "reviewId + event required", code: "validation" }, 400);

  const eventMap = {
    approve: "APPROVED",
    request_changes: "REQUEST_CHANGES",
    comment: "COMMENT",
  } as const;
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  await fj.submitPullReview(owner, repo, change.pr_number, reviewId, {
    event: eventMap[body.event],
    body: body.body ?? "",
    sudo,
  });
  // The submit will fire a pull_request_review webhook; let that path drive
  // the SSE event so client state derives from authoritative server data.
  return c.json({ ok: true });
});

function normalizeStatus(s: string): "added" | "modified" | "deleted" | "renamed" | "copied" {
  if (s === "added" || s === "modified" || s === "deleted" || s === "renamed" || s === "copied") return s;
  console.warn(`Unknown Forgejo file status: ${JSON.stringify(s)} — treating as modified`);
  return "modified";
}

// ---------- review queue (PRs awaiting your review) ----------

changes.get("/:slug/review-queue", async (c) => {
  const ws = c.get("workspace");
  const { fj, owner, repo } = c.get("repoCtx");
  const inReview = listInReview(c.get("db"), ws.id);
  const queue = await Promise.all(inReview.map(async (ch) => {
    const counts = ch.pr_number
      ? await approvalCounts(fj, owner, repo, ch.pr_number)
      : { approvals: 0, rejections: 0 };
    return {
      id: ch.id,
      title: ch.title ?? `change ${ch.id}`,
      pr_number: ch.pr_number,
      author_user_id: ch.author_user_id,
      created_at: ch.created_at,
      approvals: counts.approvals,
      rejections: counts.rejections,
    };
  }));
  return c.json({ queue });
});

// ---------- settings (min_approvals) ----------

changes.get("/:slug/settings", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const bp = await fj.getBranchProtection(owner, repo, "main");
  return c.json({ min_approvals: bp?.required_approvals ?? 1 });
});

changes.put("/:slug/settings", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner") return c.json({ error: "owner only", code: "forbidden" }, 403);
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
    await fj.updateBranchProtection(owner, repo, "main", {
      required_approvals: body.min_approvals,
    });
  }
  return c.json({ min_approvals: body.min_approvals });
});

// Webhook helper: when a PR push event arrives, transition the corresponding
// change. Used from routes/webhooks.ts.
export function syncBranchFromPr(
  db: import("better-sqlite3").Database,
  workspaceId: number,
  prNumber: number,
  prState: "open" | "closed",
  prMerged: boolean,
): void {
  const change = getBranchByPr(db, workspaceId, prNumber);
  if (!change) return;
  if (prMerged) setBranchState(db, workspaceId, change.id, "merged");
  else if (prState === "closed") {
    if (change.state === "review" || change.state === "changes_requested")
      setBranchState(db, workspaceId, change.id, "closed");
  }
}

export async function syncBranchFromReview(
  db: import("better-sqlite3").Database,
  workspaceId: number,
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  reviewState: string,
): Promise<{ id: string; state: BranchRow["state"] } | null> {
  const change = getBranchByPr(db, workspaceId, prNumber);
  if (!change) return null;
  if (change.state === "merged" || change.state === "closed") return null;

  if (reviewState === "REQUEST_CHANGES") {
    if (change.state === "review") setBranchState(db, workspaceId, change.id, "changes_requested");
    return { id: change.id, state: "changes_requested" };
  }
  if (reviewState !== "APPROVED" || change.state !== "review") return { id: change.id, state: change.state };

  const bp = await fj.getBranchProtection(owner, repo, "main");
  const threshold = bp?.required_approvals ?? 1;
  const counts = await approvalCounts(fj, owner, repo, prNumber);
  if (counts.approvals >= threshold && counts.rejections === 0) {
    const mergeErr = await mergeWithRetry(fj, owner, repo, prNumber, owner);
    if (!mergeErr) {
      await deleteBranchQuietly(fj, owner, repo, change.branch_name);
      setBranchState(db, workspaceId, change.id, "merged");
      return { id: change.id, state: "merged" };
    }
    console.warn(`merge failed: ${(mergeErr as Error).message}`);
  }
  return { id: change.id, state: "review" };
}

export { deleteBranchRow };
