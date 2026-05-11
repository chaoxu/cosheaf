// Change lifecycle routes: list/create/abandon, publish (direct/review),
// approve/reject. Replaces the old revision/review/document workflow surface.

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError, type Forgejo, type ForgejoReview } from "../forgejo.js";
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fj.mergePull(owner, repo, prNumber, { Do: "squash", sudo });
      return null;
    } catch (err) {
      lastErr = err;
      if (err instanceof ForgejoError && err.status === 405 && /try again/i.test(err.bodyText)) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
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

// ---------- list / create / abandon ----------

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
  if (change.state === "merged" || change.state === "rejected" || change.state === "abandoned")
    return c.json({ error: `change is ${change.state}`, code: "conflict" }, 409);

  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  if (change.state === "review" && change.pr_number) {
    try {
      await fj.editPull(owner, ws.forgejoRepo, change.pr_number, { state: "closed" }, c.get("forgejoUsername"));
    } catch (err) { console.warn(`close PR on abandon: ${(err as Error).message}`); }
  }
  await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name, "deleteBranch on abandon");
  setChangeState(c.get("db"), ws.id, change.id, "abandoned");
  c.get("sse").publish(ws.slug, { type: "change_abandoned", id: change.id });
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
  if (change.state !== "draft" && change.state !== "review")
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
    setChangeState(c.get("db"), ws.id, change.id, "abandoned");
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
        setChangeState(c.get("db"), ws.id, change.id, "abandoned");
        return c.json({ ok: true, message: "nothing to publish" });
      }
      throw err;
    }
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

// ---------- approve / reject ----------

async function decide(
  c: import("hono").Context<AppEnv>,
  decision: "approve" | "reject",
): Promise<Response> {
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

  const event = decision === "approve" ? "APPROVED" : "REQUEST_CHANGES";
  await fj.createReview(owner, ws.forgejoRepo, change.pr_number, { event, body: body.comment ?? "", sudo });

  if (decision === "reject") {
    try { await fj.editPull(owner, ws.forgejoRepo, change.pr_number, { state: "closed" }, sudo); } catch (err) {
      console.warn(`close PR on reject: ${(err as Error).message}`);
    }
    await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name);
    setChangeState(c.get("db"), ws.id, change.id, "rejected");
    c.get("sse").publish(ws.slug, { type: "change_rejected", id: change.id });
  } else {
    // approve: count latest-state-per-user, merge if threshold met
    const bp = await fj.getBranchProtection(owner, ws.forgejoRepo, "main");
    const threshold = bp?.required_approvals ?? 1;
    const counts = await approvalCounts(fj, owner, ws.forgejoRepo, change.pr_number);
    if (counts.approvals >= threshold && counts.rejections === 0) {
      try {
        await fj.mergePull(owner, ws.forgejoRepo, change.pr_number, { Do: "squash", sudo: owner });
        await deleteBranchQuietly(fj, owner, ws.forgejoRepo, change.branch_name);
        setChangeState(c.get("db"), ws.id, change.id, "merged");
        c.get("sse").publish(ws.slug, { type: "change_merged", id: change.id });
      } catch (err) {
        if (!(err instanceof ForgejoError && err.status === 405)) console.warn(`merge failed: ${(err as Error).message}`);
      }
    }
    c.get("sse").publish(ws.slug, { type: "change_approved", id: change.id });
  }

  const after = getChange(c.get("db"), ws.id, change.id) as ChangeRow;
  const counts = await approvalCounts(fj, owner, ws.forgejoRepo, change.pr_number);
  return c.json({
    decision,
    change_id: change.id,
    state: after.state,
    approvals: counts.approvals,
    rejections: counts.rejections,
  });
}

async function approvalCounts(
  fj: import("../forgejo.js").Forgejo,
  owner: string,
  repo: string,
  index: number,
): Promise<{ approvals: number; rejections: number }> {
  const reviews = await fj.listReviews(owner, repo, index);
  const latestByUser = new Map<string, ForgejoReview>();
  for (const r of reviews) {
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

changes.post("/:slug/change/:id/approve", (c) => decide(c, "approve"));
changes.post("/:slug/change/:id/reject", (c) => decide(c, "reject"));

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
    .filter((r) => r.state === "APPROVED" || r.state === "REQUEST_CHANGES")
    .map((r) => {
      const cs = db
        .prepare("SELECT id, username FROM users WHERE forgejo_username = ?")
        .get(r.user.login) as { id: number; username: string } | undefined;
      return {
        verifier_user_id: cs?.id ?? -1,
        username: cs?.username ?? r.user.login,
        decision: r.state === "APPROVED" ? ("approve" as const) : ("reject" as const),
        comment: r.body || null,
        created_at: r.submitted_at ? Date.parse(r.submitted_at) : 0,
      };
    });
  return c.json({ approvals });
});

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
    if (change.state === "review") setChangeState(db, workspaceId, change.id, "rejected");
  }
}

export { deleteChange };
