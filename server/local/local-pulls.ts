// Tier 2: the local Workbench's pull-request endpoint. The page editor island
// calls POST /api/v1/repos/:owner/:repo/pulls (the same typed route it uses
// hosted); locally that means: commit the working tree, push the branch to the
// working tree's `origin` over the user's git transport, then open the PR on the
// remote Cosheaf via its typed API. Mounted only in local mode.

import { Hono } from "hono";
import { validBranchName } from "../branch-path.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { bad, conflict } from "../routes/responses.js";
import type { AppEnv } from "../types.js";
import { friendlyLine } from "./git-errors.js";
import { resolveLocalWorkspace } from "./local-mode.js";

export const localPulls = new Hono<AppEnv>();
localPulls.use("*", requireAuth);
localPulls.use("/:owner/:repo/*", requireMembership());
localPulls.use("/:owner/:repo/*", requireWriteOnMutation);

localPulls.post("/:owner/:repo/pulls", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const entry = resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry;
  if (!entry) return c.json({ error: "workspace not found", code: "not_found" }, 404);
  const remote = entry.remoteClient;
  if (!remote) {
    return c.json(
      ...conflict(
        "No remote configured. Add { url, token } to .cosheaf/remote.json (gitignored) to push and open pull requests.",
      ),
    );
  }
  const backend = entry.backend;
  const body = (await c.req.json().catch(() => null)) as {
    head?: string;
    base?: string;
    title?: string;
    body?: string;
  } | null;
  const head = body?.head?.trim();
  const base = body?.base?.trim() || "main";
  if (!head) return c.json(...bad("head branch required"));
  if (head === base) return c.json(...bad("head and base are the same branch (nothing to review)"));
  // Validate before either reaches `git push` as an argument (also blocks a
  // leading "-" being read as a git option).
  if (!validBranchName(head)) return c.json(...bad("invalid head branch name"));
  if (base !== "main" && !validBranchName(base)) return c.json(...bad("invalid base branch name"));
  // The commit lands on the checked-out branch, so it must match the branch we
  // push — otherwise the edit lands on one branch and an empty `head` is pushed.
  // A null current (detached/unborn HEAD) would commit to an orphan ref while
  // pushing a stale named branch, silently stranding the edit — reject it.
  const current = await backend.currentBranch();
  if (!current) {
    return c.json(...bad("HEAD is detached or on an unborn branch; check out a branch before opening a pull request"));
  }
  if (current !== head) {
    return c.json(...bad(`open the pull request from the checked-out branch ("${current}"), not "${head}"`));
  }
  const title = body?.title?.trim() || `Update ${head}`;
  const prBody = typeof body?.body === "string" ? body.body : title;

  // Commit any pending working-tree edits, then push the branch to the forge
  // over the user's git transport (SSH).
  try {
    await backend.commitAll(title);
    await backend.push(head);
  } catch (err) {
    return c.json(...bad(friendlyLine(err)));
  }

  try {
    const pr = await remote.openPull(owner, repo, { head, base, title, body: prBody });
    return c.json({ number: pr.number });
  } catch (err) {
    return c.json(...bad(`Couldn't open the pull request: ${friendlyLine(err)}`));
  }
});
