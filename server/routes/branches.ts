// Branch surface. Branches live entirely on Forgejo; this route translates
// cosheaf paths to Forgejo REST and shapes "branches/mine" so the sidebar
// can list a user's in-progress work without their open PRs duplicating in.
//
// Endpoints under /:owner/:repo/* :
//   GET    /branches              — list branches
//   GET    /branches/mine         — your branches with no open PR
//   POST   /branches              — create a branch from main
//   DELETE /branches/:name        — delete a branch

import { Hono } from "hono";
import { validBranchName } from "../branch-path.js";
import {
  requireAuth,
  requireMembership,
  requireWriteOnMutation,
} from "../middleware.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { WorkspaceBackendError, type WsBranch } from "../workspace-backend.js";

export const branches = new Hono<AppEnv>();
branches.use("*", requireAuth);
branches.use("/:owner/:repo/*", requireMembership());
branches.use("/:owner/:repo/*", requireWriteOnMutation);

import { bad, conflict } from "./responses.js";

function publicBranch(c: import("hono").Context<AppEnv>, branch: WsBranch): Record<string, unknown> {
  const { owner, repo } = c.get("repoCtx");
  const origin = new URL(c.req.url).origin;
  const commitId = branch.commit?.id ?? "";
  // Only a real commit sha gets a commit URL. The local Workbench aliases every
  // branch to the working tree and reports a synthetic "WORKTREE" id, which has
  // no /commit/<sha> page — emitting a link for it would 404. Hosted branches
  // carry full 40-char shas and are unaffected.
  const isCommitSha = /^[0-9a-f]{7,40}$/i.test(commitId);
  return {
    ...branch,
    commit: {
      ...branch.commit,
      url: isCommitSha ? `${origin}/${owner}/${repo}/commit/${commitId}` : "",
    },
  };
}

branches.get("/:owner/:repo/branches", async (c) => {
  const { backend, owner, repo } = c.get("repoCtx");
  const list = await backend.listBranches(owner, repo);
  return c.json(list.map((branch) => publicBranch(c, branch)));
});

branches.get("/:owner/:repo/branch_protections", async (c) => {
  return c.json([]);
});

branches.get("/:owner/:repo/branches/mine", async (c) => {
  const { backend, owner, repo } = c.get("repoCtx");
  const [list, pulls] = await Promise.all([
    backend.listBranches(owner, repo),
    backend.listPulls(owner, repo, "open"),
  ]);
  const openHeads = new Set(pulls.map((p) => p.head.ref));
  // Identify "your branches" by the author of the branch's head commit.
  // This is the natural Forgejo-native answer ("branches I authored, that
  // don't already have an open PR"), replacing the older `user/<username>/`
  // prefix convention.
  const me = c.get("user").username;
  const mine = list
    .filter((b) => b.name !== "main" && b.commit?.author?.username === me && !openHeads.has(b.name))
    .map((b) => ({
      name: b.name,
      commit_sha: b.commit?.id ?? null,
      updated_at: b.commit?.timestamp ? Date.parse(b.commit.timestamp) : 0,
    }))
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ branches: mine });
});

branches.post("/:owner/:repo/branches", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name;
  if (!validBranchName(name) || name === "main") return c.json(...bad("valid branch name required"));
  const { backend, owner, repo } = c.get("repoCtx");
  try {
    await backend.createBranch(owner, repo, { newBranchName: name, oldBranchName: "main" });
  } catch (err) {
    if (err instanceof WorkspaceBackendError && err.status === 409)
      return c.json(...conflict("branch already exists"));
    throw err;
  }
  invalidateRepoTrees(owner, repo);
  return c.json({ name }, 201);
});

// `:name{.+}` captures multi-segment names so `user/chao/foo` works whether
// or not the caller URL-encodes the slashes. Same validation shape as the
// POST handler — never allow `main`, traversal, or punctuation outside the
// allowlist.
branches.delete("/:owner/:repo/branches/:name{.+}", async (c) => {
  const name = c.req.param("name");
  if (!validBranchName(name) || name === "main") return c.json(...bad("valid branch name required (not main)"));
  const { backend, owner, repo } = c.get("repoCtx");
  try {
    await backend.deleteBranch(owner, repo, name);
  } catch (err) {
    if (!(err instanceof WorkspaceBackendError && err.status === 404)) throw err;
  }
  invalidateRepoTrees(owner, repo);
  return c.json({ ok: true });
});
