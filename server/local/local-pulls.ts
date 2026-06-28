// Tier 2: the local Workbench's pull-request endpoint. The page editor island
// calls POST /api/v1/repos/:owner/:repo/pulls (the same typed route it uses
// hosted); locally that means: commit the working tree, push the branch to the
// working tree's `origin` over the user's git transport, then open the PR on the
// remote Cosheaf via its typed API. Mounted only in local mode.

import { Hono } from "hono";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { bad, conflict } from "../routes/responses.js";
import type { AppEnv } from "../types.js";
import type { LocalGitWorkspaceBackend } from "./local-git-backend.js";

export const localPulls = new Hono<AppEnv>();
localPulls.use("*", requireAuth);
localPulls.use("/:owner/:repo/*", requireMembership());
localPulls.use("/:owner/:repo/*", requireWriteOnMutation);

localPulls.post("/:owner/:repo/pulls", async (c) => {
  const remote = c.get("remoteCosheaf");
  if (!remote) {
    return c.json(
      ...conflict(
        "No remote configured. Add a `remote:` block (url + Cosheaf token) to cosheaf.yaml to push and open pull requests.",
      ),
    );
  }
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const backend = c.get("localBackend") as LocalGitWorkspaceBackend;
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
  const title = body?.title?.trim() || `Update ${head}`;
  const prBody = typeof body?.body === "string" ? body.body : title;

  // Commit any pending working-tree edits, then push the branch to the forge
  // over the user's git transport (SSH).
  try {
    await backend.commitAll(title);
    await backend.push(head);
  } catch (err) {
    return c.json(...bad(`push failed: ${(err as Error).message}`));
  }

  try {
    const pr = await remote.openPull(owner, repo, { head, base, title, body: prBody });
    return c.json({ number: pr.number });
  } catch (err) {
    return c.json(...bad(`open pull request failed: ${(err as Error).message}`));
  }
});
