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
import { userBranchPrefix } from "../../shared/conventions.js";

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
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const [list, pulls] = await Promise.all([
    fj.listBranches(owner, repo),
    fj.listPulls(owner, repo, "open"),
  ]);
  const openHeads = new Set(pulls.map((p) => p.head.ref));
  // Identify "your branches" by the `user/<sudo>/` prefix we enforce on
  // file PUT auto-create. This is deterministic — unlike scanning the
  // latest commit's author/committer, which falls over after rebase,
  // cherry-pick, or a web-UI edit attributed to a different user.
  const prefix = userBranchPrefix(sudo);
  const mine = list
    .filter((b) => b.name.startsWith(prefix) && !openHeads.has(b.name))
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

branches.delete("/:slug/branches/:name", async (c) => {
  const name = c.req.param("name");
  if (!name || name === "main")
    return c.json({ error: "branch name required (not main)", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  await deleteBranchQuietly(fj, owner, repo, name);
  return c.json({ ok: true });
});
