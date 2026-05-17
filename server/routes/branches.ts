// Branch surface. Branches live entirely on Forgejo; this route translates
// cosheaf paths to Forgejo REST and shapes "branches/mine" so the sidebar
// can list a user's in-progress work without their open PRs duplicating in.
//
// Endpoints under /:slug/* :
//   GET    /branches/mine         — your branches with no open PR
//   POST   /branches              — create a branch from main
//   DELETE /branches/:name        — delete a branch

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import {
  requireAuth,
  requireMembership,
  requireWriteOnMutation,
} from "../middleware.js";
import { ForgejoError, type Forgejo } from "../forgejo.js";
import { invalidateRepoTrees } from "../tree-cache.js";

export const branches = new Hono<AppEnv>();
branches.use("*", requireAuth);
branches.use("/:slug/*", requireMembership());
branches.use("/:slug/*", requireWriteOnMutation);

async function deleteBranchQuietly(fj: Forgejo, owner: string, repo: string, branch: string): Promise<void> {
  try {
    await fj.deleteBranch(owner, repo, branch);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) {
      console.warn(`deleteBranch ${branch}: ${(err as Error).message}`);
    }
  }
}

branches.get("/:slug/branches/mine", async (c) => {
  const { fj, owner, repo } = c.get("repoCtx");
  const [list, pulls] = await Promise.all([
    fj.listBranches(owner, repo),
    fj.listPulls(owner, repo, "open"),
  ]);
  const openHeads = new Set(pulls.map((p) => p.head.ref));
  // Identify "your branches" by the author of the branch's head commit.
  // This is the natural Forgejo-native answer ("branches I authored, that
  // don't already have an open PR"), replacing the older `user/<username>/`
  // prefix convention.
  const me = c.get("user").username;
  const mine = list
    .filter((b) => b.commit?.author?.username === me && !openHeads.has(b.name))
    .map((b) => ({
      name: b.name,
      commit_sha: b.commit?.id ?? null,
      updated_at: b.commit?.timestamp ? Date.parse(b.commit.timestamp) : 0,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ branches: mine });
});

branches.post("/:slug/branches", async (c) => {
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
  const { fj, owner, repo } = c.get("repoCtx");
  try {
    await fj.createBranch(owner, repo, { newBranchName: body.name, oldBranchName: "main" });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409)
      return c.json({ error: "branch already exists", code: "conflict" }, 409);
    throw err;
  }
  invalidateRepoTrees(owner, repo);
  return c.json({ name: body.name }, 201);
});

// `:name{.+}` captures multi-segment names so `user/chao/foo` works whether
// or not the caller URL-encodes the slashes. Same validation shape as the
// POST handler — never allow `main`, traversal, or punctuation outside the
// allowlist.
branches.delete("/:slug/branches/:name{.+}", async (c) => {
  const name = c.req.param("name");
  if (
    !name ||
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name === "main" ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/")
  )
    return c.json({ error: "valid branch name required (not main)", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await deleteBranchQuietly(fj, owner, repo, name);
  invalidateRepoTrees(owner, repo);
  return c.json({ ok: true });
});
