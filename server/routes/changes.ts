// Change lifecycle routes: list/create/discard, publish (direct/review),
// approve/request-changes/comment/close. Replaces the old revision/review/document workflow surface.

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError, type Forgejo, type ForgejoReview } from "../forgejo.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { fileLineToWritePosition, positionToFileLine } from "../diff-position.js";
import type { LineComment } from "../../shared/comments.js";
import {
  createChange,
  deleteChange,
  getChange,
  getChangeByPr,
  listInReview,
  listOpenForUser,
  setChangeState,
  type ChangeRow,
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

changes.get("/:slug/changes", (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const rows = listOpenForUser(c.get("db"), ws.id, user.id);
  return c.json({ changes: rows });
});

changes.post("/:slug/change", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const mainBranch = await fj.getBranch(owner, ws.forgejoRepo, "main");
  const change = createChange(c.get("db"), {
    workspaceId: ws.id,
    authorUserId: user.id,
    baseSha: mainBranch?.commit?.id ?? null,
    title: body.title ?? null,
  });
  return c.json(change, 201);
});

changes.delete("/:slug/change/:id", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const id = c.req.param("id");
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.author_user_id !== user.id)
    return c.json({ error: "not your change", code: "forbidden" }, 403);
  if (change.state !== "draft")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name, "deleteBranch on discard");
  setChangeState(c.get("db"), ws.id, change.id, "closed");
  c.get("sse").publish(ws.slug, { type: "change_closed", id: change.id });
  return c.json({ ok: true });
});

// ---------- publish ----------

changes.post("/:slug/publish", async (c) => {
  const ws = c.get("workspace");
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    change_id?: string;
    mode?: "direct" | "review";
    title?: string;
    body?: string;
  };
  if (!body.change_id) return c.json({ error: "change_id required", code: "validation" }, 400);
  const change = getChange(c.get("db"), ws.id, body.change_id);
  if (!change) return c.json({ error: "change not found", code: "not_found" }, 404);
  if (change.author_user_id !== user.id)
    return c.json({ error: "not your change", code: "forbidden" }, 403);
  if (change.state !== "draft" && change.state !== "review" && change.state !== "changes_requested")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);

  // Non-owners are forced to mode=review.
  let mode = body.mode ?? (ws.role === "owner" ? "direct" : "review");
  if (mode === "direct" && ws.role !== "owner") mode = "review";

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");

  // Ensure the branch exists (it might not if the user created a change via
  // POST /change but never saved anything).
  const branchExists = await fj.getBranch(owner, ws.forgejoRepo, change.branch_name);
  if (!branchExists) {
    setChangeState(c.get("db"), ws.id, change.id, "closed");
    return c.json({ ok: true, message: "nothing to publish (no commits)" });
  }

  // Open or reuse a PR.
  let prNumber = change.pr_number;
  if (!prNumber) {
    try {
      const pr = await fj.createPull(owner, ws.forgejoRepo, {
        head: change.branch_name,
        base: "main",
        title: body.title ?? change.title ?? `change ${change.id}`,
        body: body.body ?? `cosheaf-change-id: ${change.id}`,
        sudo,
      });
      prNumber = pr.number;
      setChangeState(c.get("db"), ws.id, change.id, change.state, { pr_number: prNumber });
    } catch (err) {
      if (err instanceof ForgejoError && err.status === 409) {
        // No diff vs main → nothing to publish; clean up the empty branch.
        await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name);
        setChangeState(c.get("db"), ws.id, change.id, "closed");
        return c.json({ ok: true, message: "nothing to publish" });
      }
      throw err;
    }
  }

  if (prNumber && (body.title !== undefined || body.body !== undefined)) {
    await fj.editPull(owner, ws.forgejoRepo, prNumber, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
    }, sudo);
  }

  if (mode === "review") {
    setChangeState(c.get("db"), ws.id, change.id, "review");
    c.get("sse").publish(ws.slug, { type: "change_review", id: change.id, pr: prNumber });
    return c.json({ ok: true, mode, change_id: change.id, pr_number: prNumber });
  }

  // direct: auto-approve as cosheaf-admin to satisfy required_approvals (Forgejo's
  // apply_to_admins flag doesn't bypass merge gates in our deployment), then merge.
  try {
    await fj.createReview(owner, ws.forgejoRepo, prNumber, {
      event: "APPROVED",
      body: `auto-approved on direct publish by ${sudo}`,
      sudo: owner,
    });
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 422)) {
      console.warn(`auto-approve failed: ${(err as Error).message}`);
    }
  }
  const mergeErr = await mergeWithRetry(fj, owner, ws.forgejoRepo, prNumber, owner);
  if (mergeErr) {
    return c.json({ error: `merge failed: ${(mergeErr as Error).message}`, code: "conflict", pr_number: prNumber }, 409);
  }
  await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name, "deleteBranch after merge");
  setChangeState(c.get("db"), ws.id, change.id, "merged");
  c.get("sse").publish(ws.slug, { type: "change_merged", id: change.id });
  return c.json({ ok: true, mode, change_id: change.id, pr_number: prNumber });
});

// ---------- approve / request changes / comment / close ----------

async function approve(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "verifier role required", code: "forbidden" }, 403);
  const id = c.req.param("id") ?? "";
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state !== "review" || !change.pr_number)
    return c.json({ error: "change is not in review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");

  await fj.createReview(owner, ws.forgejoRepo, change.pr_number, {
    event: "APPROVED",
    body: body.comment ?? "",
    sudo,
  });

  const bp = await fj.getBranchProtection(owner, ws.forgejoRepo, "main");
  const threshold = bp?.required_approvals ?? 1;
  const counts = await approvalCounts(fj, owner, ws.forgejoRepo, change.pr_number);
  if (counts.approvals >= threshold && counts.rejections === 0) {
    const mergeErr = await mergeWithRetry(fj, owner, ws.forgejoRepo, change.pr_number, owner);
    if (!mergeErr) {
      await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name);
      setChangeState(c.get("db"), ws.id, change.id, "merged");
      c.get("sse").publish(ws.slug, { type: "change_merged", id: change.id });
    } else {
      console.warn(`merge failed: ${(mergeErr as Error).message}`);
    }
  }
  c.get("sse").publish(ws.slug, { type: "change_approved", id: change.id });

  const after = getChange(c.get("db"), ws.id, change.id) as ChangeRow;
  const afterCounts = await approvalCounts(fj, owner, ws.forgejoRepo, change.pr_number);
  return c.json({
    decision: "approve",
    change_id: change.id,
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
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state !== "review" || !change.pr_number)
    return c.json({ error: "change is not in review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");
  await fj.createReview(owner, ws.forgejoRepo, change.pr_number, {
    event: "REQUEST_CHANGES",
    body: body.comment ?? "",
    sudo,
  });
  setChangeState(c.get("db"), ws.id, change.id, "changes_requested");
  c.get("sse").publish(ws.slug, { type: "change_changes_requested", id: change.id });

  const counts = await approvalCounts(fj, owner, ws.forgejoRepo, change.pr_number);
  return c.json({
    decision: "request_changes",
    change_id: change.id,
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
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if ((change.state !== "review" && change.state !== "changes_requested") || !change.pr_number)
    return c.json({ error: "change is not open for review", code: "conflict" }, 409);
  if (change.author_user_id === c.get("user").id)
    return c.json({ error: "cannot review your own change", code: "forbidden" }, 403);

  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { comment?: string | null };
  const fj = c.get("forgejo");
  await fj.createReview(c.get("config").forgejoOwner, ws.forgejoRepo, change.pr_number, {
    event: "COMMENT",
    body: body.comment ?? "",
    sudo: c.get("forgejoUsername"),
  });
  c.get("sse").publish(ws.slug, { type: "change_commented", id: change.id });
  return c.json({ ok: true, change_id: change.id, state: change.state });
}

async function closeChange(c: import("hono").Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace");
  const user = c.get("user");
  const id = c.req.param("id") ?? "";
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (change.state === "merged" || change.state === "closed")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);
  if (change.author_user_id !== user.id && ws.role !== "owner")
    return c.json({ error: "not allowed to close this change", code: "forbidden" }, 403);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  if (change.pr_number) {
    try {
      await fj.editPull(owner, ws.forgejoRepo, change.pr_number, { state: "closed" }, c.get("forgejoUsername"));
    } catch (err) {
      console.warn(`close PR: ${(err as Error).message}`);
    }
  }
  await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name, "deleteBranch on close");
  setChangeState(c.get("db"), ws.id, change.id, "closed");
  c.get("sse").publish(ws.slug, { type: "change_closed", id: change.id });
  return c.json({ ok: true, change_id: change.id, state: "closed" });
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

changes.post("/:slug/change/:id/approve", (c) => approve(c));
changes.post("/:slug/change/:id/request-changes", (c) => requestChanges(c));
changes.post("/:slug/change/:id/comment", (c) => commentChange(c));
changes.post("/:slug/change/:id/close", (c) => closeChange(c));

// ---------- approvals listing ----------

changes.get("/:slug/change/:id/approvals", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id") ?? "";
  const change = getChange(c.get("db"), ws.id, id);
  if (!change || !change.pr_number) return c.json({ approvals: [] });
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const reviews = await fj.listReviews(owner, ws.forgejoRepo, change.pr_number);
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

changes.get("/:slug/change/:id/pr", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const pull = await fj.getPull(owner, ws.forgejoRepo, change.pr_number);
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

changes.get("/:slug/change/:id/diff", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const [metas, unified] = await Promise.all([
    fj.listPullFiles(owner, ws.forgejoRepo, change.pr_number),
    fj.getPullDiff(owner, ws.forgejoRepo, change.pr_number),
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

changes.get("/:slug/change/:id/file", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const path = c.req.query("path");
  const side = c.req.query("side");
  if (!path) return c.json({ error: "path required", code: "validation" }, 400);
  if (side !== "base" && side !== "head")
    return c.json({ error: "side must be base or head", code: "validation" }, 400);

  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const pull = await fj.getPull(owner, ws.forgejoRepo, change.pr_number);
  if (!pull) return c.json({ error: "pull not found upstream", code: "not_found" }, 404);

  const sha = side === "base" ? pull.base.sha : pull.head.sha;
  try {
    const content = await fj.getRawFile(owner, ws.forgejoRepo, sha, path);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404)
      return c.json({ error: "file not present at this side", code: "not_found" }, 404);
    throw err;
  }
});

changes.get("/:slug/change/:id/comments", async (c) => {
  const ws = c.get("workspace");
  const id = c.req.param("id");
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const [reviews, metas, unified] = await Promise.all([
    fj.listReviews(owner, ws.forgejoRepo, change.pr_number),
    fj.listPullFiles(owner, ws.forgejoRepo, change.pr_number),
    fj.getPullDiff(owner, ws.forgejoRepo, change.pr_number),
  ]);
  const patchesByPath = new Map(
    splitUnifiedDiff(unified).map((p) => [p.path, p.patch]),
  );
  const status = new Map(metas.map((m) => [m.filename, m.status]));

  // Per-review fan-out. PRs usually have <10 reviews, so this is fine.
  const allComments = (
    await Promise.all(
      reviews.map((r) =>
        fj.listReviewComments(owner, ws.forgejoRepo, change.pr_number as number, r.id).catch(() => []),
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

changes.post("/:slug/change/:id/comments", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner" && ws.role !== "verifier")
    return c.json({ error: "only owners and verifiers can comment", code: "forbidden" }, 403);

  const id = c.req.param("id");
  const change = getChange(c.get("db"), ws.id, id);
  if (!change) return c.json({ error: "not found", code: "not_found" }, 404);
  if (!change.pr_number)
    return c.json({ error: "change has no pull request yet", code: "conflict" }, 409);
  if (c.get("user").id === change.author_user_id)
    return c.json({ error: "authors cannot review their own change", code: "forbidden" }, 403);

  const body = (await c.req.json().catch(() => null)) as {
    path?: string;
    line?: number;
    side?: "new" | "old";
    body?: string;
  } | null;
  if (!body?.path || !body.line || !body.body || (body.side !== "new" && body.side !== "old")) {
    return c.json({ error: "path, line, side, body required", code: "validation" }, 400);
  }

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const unified = await fj.getPullDiff(owner, ws.forgejoRepo, change.pr_number);
  const filePatch = splitUnifiedDiff(unified).find((p) => p.path === body.path)?.patch;
  if (!filePatch)
    return c.json({ error: "file not part of this PR", code: "validation" }, 400);
  const pos = fileLineToWritePosition(filePatch, body.line, body.side);
  if (!pos)
    return c.json({ error: "line not present in diff", code: "validation" }, 400);

  await fj.createReview(owner, ws.forgejoRepo, change.pr_number, {
    event: "COMMENT",
    body: "",
    sudo: c.get("forgejoUsername"),
    comments: [{ path: body.path, body: body.body, ...pos }],
  });
  c.get("sse").publish(ws.slug, { type: "comment_added", id: change.id });
  return c.json({ ok: true });
});

changes.patch("/:slug/change/:id/comments/:commentId", async (c) => {
  const ws = c.get("workspace");
  const change = getChange(c.get("db"), ws.id, c.req.param("id"));
  if (!change?.pr_number) return c.json({ error: "not found", code: "not_found" }, 404);
  const commentId = Number(c.req.param("commentId"));
  if (!commentId) return c.json({ error: "bad commentId", code: "validation" }, 400);

  const body = (await c.req.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body) return c.json({ error: "body required", code: "validation" }, 400);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  await fj.editReviewComment(owner, ws.forgejoRepo, commentId, body.body, c.get("forgejoUsername"));
  c.get("sse").publish(ws.slug, { type: "comment_edited", id: change.id });
  return c.json({ ok: true });
});

changes.delete("/:slug/change/:id/comments/:commentId", async (c) => {
  const ws = c.get("workspace");
  const change = getChange(c.get("db"), ws.id, c.req.param("id"));
  if (!change?.pr_number) return c.json({ error: "not found", code: "not_found" }, 404);
  const commentId = Number(c.req.param("commentId"));
  const reviewId = Number(c.req.query("review_id"));
  if (!commentId || !reviewId)
    return c.json({ error: "review_id query param required", code: "validation" }, 400);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  await fj.deleteReviewComment(
    owner, ws.forgejoRepo, change.pr_number, reviewId, commentId, c.get("forgejoUsername"),
  );
  c.get("sse").publish(ws.slug, { type: "comment_deleted", id: change.id });
  return c.json({ ok: true });
});

function normalizeStatus(s: string): "added" | "modified" | "deleted" | "renamed" | "copied" {
  if (s === "added" || s === "modified" || s === "deleted" || s === "renamed" || s === "copied") return s;
  console.warn(`Unknown Forgejo file status: ${JSON.stringify(s)} — treating as modified`);
  return "modified";
}

// ---------- queue (changes in review) ----------

changes.get("/:slug/queue", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const inReview = listInReview(c.get("db"), ws.id);
  const queue = await Promise.all(inReview.map(async (ch) => {
    const counts = ch.pr_number
      ? await approvalCounts(fj, owner, ws.forgejoRepo, ch.pr_number)
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
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const bp = await fj.getBranchProtection(owner, ws.forgejoRepo, "main");
  return c.json({ min_approvals: bp?.required_approvals ?? 1 });
});

changes.put("/:slug/settings", async (c) => {
  const ws = c.get("workspace");
  if (ws.role !== "owner") return c.json({ error: "owner only", code: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => null)) as { min_approvals?: number } | null;
  if (!body || !Number.isInteger(body.min_approvals) || (body.min_approvals as number) < 1)
    return c.json({ error: "min_approvals must be >= 1", code: "validation" }, 400);
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const existing = await fj.getBranchProtection(owner, ws.forgejoRepo, "main");
  if (!existing) {
    await fj.createBranchProtection(owner, ws.forgejoRepo, {
      branch_name: "main",
      required_approvals: body.min_approvals,
    });
  } else {
    await fj.updateBranchProtection(owner, ws.forgejoRepo, "main", {
      required_approvals: body.min_approvals,
    });
  }
  return c.json({ min_approvals: body.min_approvals });
});

// Webhook helper: when a PR push event arrives, transition the corresponding
// change. Used from routes/webhooks.ts.
export function syncChangeFromPr(
  db: import("better-sqlite3").Database,
  workspaceId: number,
  prNumber: number,
  prState: "open" | "closed",
  prMerged: boolean,
): void {
  const change = getChangeByPr(db, workspaceId, prNumber);
  if (!change) return;
  if (prMerged) setChangeState(db, workspaceId, change.id, "merged");
  else if (prState === "closed") {
    if (change.state === "review" || change.state === "changes_requested")
      setChangeState(db, workspaceId, change.id, "closed");
  }
}

export async function syncChangeFromReview(
  db: import("better-sqlite3").Database,
  workspaceId: number,
  fj: Forgejo,
  owner: string,
  repo: string,
  prNumber: number,
  reviewState: string,
): Promise<{ id: string; state: ChangeRow["state"] } | null> {
  const change = getChangeByPr(db, workspaceId, prNumber);
  if (!change) return null;
  if (change.state === "merged" || change.state === "closed") return null;

  if (reviewState === "REQUEST_CHANGES") {
    if (change.state === "review") setChangeState(db, workspaceId, change.id, "changes_requested");
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
      setChangeState(db, workspaceId, change.id, "merged");
      return { id: change.id, state: "merged" };
    }
    console.warn(`merge failed: ${(mergeErr as Error).message}`);
  }
  return { id: change.id, state: "review" };
}

export { deleteChange };
