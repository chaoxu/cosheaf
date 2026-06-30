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
import { parseGitRemote } from "./local-workspace.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

export const localPulls = new Hono<AppEnv>();
localPulls.use("*", requireAuth);
localPulls.use("/:owner/:repo/*", requireMembership());
localPulls.use("/:owner/:repo/*", requireWriteOnMutation);

async function validatePublishBinding(entry: WorkspaceEntry, owner: string, repo: string): Promise<string | null> {
  const gitRemote = entry.gitRemote;
  if (entry.path && !gitRemote) {
    return 'No git remote configured. Add a push remote such as "origin" before opening a remote pull request.';
  }
  if (!gitRemote) return null;
  if (gitRemote.owner !== owner || gitRemote.repo !== repo) {
    return `This workspace is bound to ${gitRemote.owner}/${gitRemote.repo}, not ${owner}/${repo}. Reopen the correct folder before opening a remote pull request.`;
  }
  const pushRemote = entry.backend.getPushRemoteName();
  if (gitRemote.name !== pushRemote) {
    return `The Workbench is bound to git remote "${gitRemote.name}", but pushes would use "${pushRemote}". Reopen the folder before opening a remote pull request.`;
  }
  const pushUrl = await entry.backend.pushRemoteUrl();
  if (!pushUrl) return `Git push remote "${pushRemote}" is not configured. Add it before opening a remote pull request.`;
  const parsed = parseGitRemote(pushUrl);
  if (!parsed) return `Git push remote "${pushRemote}" has an unsupported URL. Use an ssh or https remote that ends in owner/repo.git.`;
  if (parsed.owner !== owner || parsed.repo !== repo) {
    return `Git push remote "${pushRemote}" points at ${parsed.owner}/${parsed.repo}, but this workspace is ${owner}/${repo}.`;
  }
  if (pushUrl !== gitRemote.url) {
    return `Git push remote "${pushRemote}" changed since this workspace was opened. Reopen the folder before opening a remote pull request.`;
  }
  return null;
}

localPulls.post("/:owner/:repo/pulls", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const entry = resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry;
  if (!entry) return c.json({ error: "workspace not found", code: "not_found" }, 404);
  const remote = entry.remoteClient;
  if (!remote) {
    return c.json(
      ...conflict(
        "No Cosheaf server connected. Add { url, token } to .cosheaf/remote.json (gitignored) to push local git branches and open remote pull requests.",
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

  const bindingError = await validatePublishBinding(entry, owner, repo);
  if (bindingError) return c.json(...bad(bindingError));
  try {
    const who = await remote.whoami();
    if (!who) return c.json(...bad("Remote Cosheaf server check failed before committing: the configured token was rejected."));
  } catch (err) {
    return c.json(...bad(`Remote Cosheaf server check failed before committing: ${friendlyLine(err)}`));
  }

  // Commit local edits, push the branch over the user's git transport, then ask
  // the remote Cosheaf API to create the durable pull request.
  try {
    await backend.commitAll(title);
  } catch (err) {
    return c.json(...bad(`Commit step failed: ${friendlyLine(err)}`));
  }
  const localHead = await backend.currentHeadSha();
  try {
    await backend.push(head);
  } catch (err) {
    return c.json(...bad(`Committed local changes, but push to "${backend.getPushRemoteName()}" failed: ${friendlyLine(err)}`));
  }
  try {
    const remoteHead = await remote.branchHead(owner, repo, head);
    if (!remoteHead) return c.json(...bad(`Pushed "${head}", but the Cosheaf server does not see that branch yet.`));
    if (localHead && remoteHead !== localHead) {
      return c.json(...bad(`Pushed "${head}", but the Cosheaf server sees ${remoteHead.slice(0, 12)} instead of ${localHead.slice(0, 12)}.`));
    }
  } catch (err) {
    return c.json(...bad(`Pushed "${head}", but couldn't verify the branch on the Cosheaf server: ${friendlyLine(err)}`));
  }

  try {
    const pr = await remote.openPull(owner, repo, { head, base, title, body: prBody });
    return c.json({ number: pr.number });
  } catch (err) {
    return c.json(...bad(`Pushed "${head}", but couldn't open the remote pull request: ${friendlyLine(err)}`));
  }
});
