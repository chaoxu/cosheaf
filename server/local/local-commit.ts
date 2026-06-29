// Tier 1 commit surface for the local Workbench. Saves write the working tree
// (Tier 0); committing is an explicit action here. A server-rendered page shows
// the current branch + `git status` and commits all changes with a message.
// Mounted only by the local web router.

import type { Hono } from "hono";
import type { AppEnv } from "../types.js";
import {
  badRequestPage,
  htmlResponse,
  redirect,
  repoHref,
  stringField,
  type WebCtx,
  webRoute,
  webRouteForWrite,
} from "../routes/web-context.js";
import { emptyHtml, html } from "../routes/web-html.js";
import { repoPageShell } from "../routes/web-page.js";
import type { LocalGitWorkspaceBackend } from "./local-git-backend.js";

// The web ctx's backend is always the resolved workspace's LocalGitWorkspaceBackend
// in local mode (resolveWebRepo sets it); narrow to reach the Tier-1 git ops.
function localBackend(ctx: WebCtx): LocalGitWorkspaceBackend {
  return ctx.backend as LocalGitWorkspaceBackend;
}

export function registerLocalCommitRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/commit", webRoute(async (c, ctx) => {
    const status = await localBackend(ctx).gitStatus();
    const notice = c.req.query("toast");
    const body = html`
      <div class="page-title compact"><div><h1>Commit</h1></div></div>
      ${notice ? html`<p class="muted" data-testid="commit-notice">${notice}</p>` : emptyHtml}
      ${
        status.branch === null
          ? html`<div class="empty" data-testid="commit-not-git">This folder is not a git repository. Saves are written to disk; run <code>git init</code> to enable commits.</div>`
          : html`
            <p>Branch <strong>${status.branch}</strong></p>
            ${
              status.entries.length === 0
                ? html`<div class="empty" data-testid="commit-clean">Working tree clean — nothing to commit.</div>`
                : html`
                  <ul class="commit-status" data-testid="commit-status">
                    ${status.entries.map((e) => html`<li><code>${e.code}</code> ${e.path}</li>`)}
                  </ul>
                  <form method="post" action="${repoHref(ctx.owner, ctx.repo, "/commit")}" data-testid="commit-form">
                    <label>Message <input name="message" required placeholder="Describe your changes" autofocus></label>
                    <div class="form-actions">
                      <button class="button primary" type="submit">Commit ${status.entries.length} change${status.entries.length === 1 ? "" : "s"}</button>
                    </div>
                  </form>`
            }`
      }
    `;
    return htmlResponse(repoPageShell(ctx, "commit", `Commit - ${ctx.repo}`, body));
  }));

  web.post("/:owner/:repo/commit", webRouteForWrite(async (c, ctx) => {
    const form = await c.req.parseBody();
    const message = stringField(form.message);
    if (!message) return badRequestPage(ctx.user, "A commit message is required.");
    let sha: string | null;
    try {
      sha = await localBackend(ctx).commitAll(message);
    } catch (err) {
      return badRequestPage(ctx.user, err instanceof Error ? err.message : "Commit failed.");
    }
    const toast = sha ? `Committed ${sha.slice(0, 8)}` : "Nothing to commit";
    return redirect(`${repoHref(ctx.owner, ctx.repo, "/commit")}?toast=${encodeURIComponent(toast)}`);
  }));
}
