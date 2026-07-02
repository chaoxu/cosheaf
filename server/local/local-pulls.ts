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
import { OriginCollaborationClient } from "./origin-collaboration-client.js";
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

// The local commit→push→openPull flow, shared by this typed route and the
// server-rendered /pulls/new POST (web-pulls.ts). Returns a discriminated result
// so each caller maps it to its own surface (JSON envelope vs. a re-rendered
// form); the friendly messages stay identical between them.
export type OpenLocalPullResult =
  | { ok: true; number: number }
  | { ok: false; status: 400 | 409; message: string };

export async function openLocalPull(
  entry: WorkspaceEntry,
  owner: string,
  repo: string,
  input: { head?: string; base?: string; title?: string; body?: string },
): Promise<OpenLocalPullResult> {
  if (!entry.remote) {
    return {
      ok: false,
      status: 409,
      message:
        "No Cosheaf server connected. Add { url, token } to .cosheaf/remote.json (gitignored) to push local git branches and open remote pull requests.",
    };
  }
  const collab = new OriginCollaborationClient(entry.remote.url, entry.remote.token);
  const backend = entry.backend;
  const head = input.head?.trim();
  const base = input.base?.trim() || "main";
  if (!head) return { ok: false, status: 400, message: "head branch required" };
  if (head === base) return { ok: false, status: 400, message: "head and base are the same branch (nothing to review)" };
  // Validate before either reaches `git push` as an argument (also blocks a
  // leading "-" being read as a git option).
  if (!validBranchName(head)) return { ok: false, status: 400, message: "invalid head branch name" };
  if (base !== "main" && !validBranchName(base)) return { ok: false, status: 400, message: "invalid base branch name" };
  // The commit lands on the checked-out branch, so it must match the branch we
  // push — otherwise the edit lands on one branch and an empty `head` is pushed.
  // A null current (detached/unborn HEAD) would commit to an orphan ref while
  // pushing a stale named branch, silently stranding the edit — reject it.
  const current = await backend.currentBranch();
  if (!current) {
    return { ok: false, status: 400, message: "HEAD is detached or on an unborn branch; check out a branch before opening a pull request" };
  }
  if (current !== head) {
    return { ok: false, status: 400, message: `open the pull request from the checked-out branch ("${current}"), not "${head}"` };
  }
  const title = input.title?.trim() || `Update ${head}`;
  const prBody = typeof input.body === "string" ? input.body : title;

  const bindingError = await validatePublishBinding(entry, owner, repo);
  if (bindingError) return { ok: false, status: 400, message: bindingError };
  try {
    const who = await collab.whoami();
    if (!who) return { ok: false, status: 400, message: "Remote Cosheaf server check failed before committing: the configured token was rejected." };
  } catch (err) {
    return { ok: false, status: 400, message: `Remote Cosheaf server check failed before committing: ${friendlyLine(err)}` };
  }

  // Commit local edits, push the branch over the user's git transport, then ask
  // the remote Cosheaf API to create the durable pull request.
  try {
    await backend.commitAll(title);
  } catch (err) {
    return { ok: false, status: 400, message: `Commit step failed: ${friendlyLine(err)}` };
  }
  const localHead = await backend.currentHeadSha();
  try {
    await backend.push(head);
  } catch (err) {
    return { ok: false, status: 400, message: `Committed local changes, but push to "${backend.getPushRemoteName()}" failed: ${friendlyLine(err)}` };
  }
  try {
    const remoteHead = (await collab.listBranches(owner, repo)).find((branch) => branch.name === head)?.commit.id ?? null;
    if (!remoteHead) return { ok: false, status: 400, message: `Pushed "${head}", but the Cosheaf server does not see that branch yet.` };
    if (localHead && remoteHead !== localHead) {
      return { ok: false, status: 400, message: `Pushed "${head}", but the Cosheaf server sees ${remoteHead.slice(0, 12)} instead of ${localHead.slice(0, 12)}.` };
    }
  } catch (err) {
    return { ok: false, status: 400, message: `Pushed "${head}", but couldn't verify the branch on the Cosheaf server: ${friendlyLine(err)}` };
  }

  try {
    const pr = await collab.createPull(owner, repo, { head, base, title, body: prBody });
    return { ok: true, number: pr.number };
  } catch (err) {
    return { ok: false, status: 400, message: `Pushed "${head}", but couldn't open the remote pull request: ${friendlyLine(err)}` };
  }
}

localPulls.post("/:owner/:repo/pulls", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const entry = resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry;
  if (!entry) return c.json({ error: "workspace not found", code: "not_found" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    head?: string;
    base?: string;
    title?: string;
    body?: string;
  } | null;
  const result = await openLocalPull(entry, owner, repo, {
    head: body?.head,
    base: body?.base,
    title: body?.title,
    body: body?.body,
  });
  if (result.ok) return c.json({ number: result.number });
  return result.status === 409 ? c.json(...conflict(result.message)) : c.json(...bad(result.message));
});
