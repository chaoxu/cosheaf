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
  webRoute,
  webRouteForWrite,
} from "../routes/web-context.js";
import { emptyHtml, html } from "../routes/web-html.js";
import { repoPageShell } from "../routes/web-page.js";
import { friendlyLine } from "./git-errors.js";
import { publishLocalGitEvent } from "./local-events.js";
import { localBackend } from "./local-mode.js";

export function registerLocalCommitRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/commit", webRoute(async (c, ctx) => {
    const backend = localBackend(ctx);
    const status = await backend.gitStatus();
    const hasUpstream = status.branch !== null && (await backend.hasUpstream());
    const counts = hasUpstream ? await backend.aheadBehind() : { ahead: 0, behind: 0 };
    const notice = c.req.query("toast");
    const body = html`
      <div class="page-title compact"><div><h1>Commit</h1></div></div>
      ${notice ? html`<p class="muted" data-testid="commit-notice">${notice}</p>` : emptyHtml}
      ${
        status.branch === null
          ? html`<div class="empty" data-testid="commit-not-git">This folder is not a git repository. Saves are written to disk; run <code>git init</code> to enable commits.</div>`
          : html`
            <div class="commit-branchline" data-testid="commit-branchline">
              <p>Branch <strong>${status.branch}</strong></p>
              ${
                hasUpstream
                  ? html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, "/sync")}" class="commit-sync">
                      ${counts.behind > 0 ? html`<span class="badge" data-testid="commit-behind">${counts.behind} behind</span>` : emptyHtml}
                      ${counts.ahead > 0 ? html`<span class="badge" data-testid="commit-ahead">${counts.ahead} ahead</span>` : emptyHtml}
                      <button class="button subtle" type="submit" data-testid="commit-sync">↓ Sync</button>
                    </form>`
                  : emptyHtml
              }
            </div>
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
      return badRequestPage(ctx.user, friendlyLine(err));
    }
    if (sha) publishLocalGitEvent(c, ctx.ws.slug, { action: "committed", sha });
    const toast = sha ? `Committed ${sha.slice(0, 8)}` : "Nothing to commit";
    return redirect(`${repoHref(ctx.owner, ctx.repo, "/commit")}?toast=${encodeURIComponent(toast)}`);
  }));
}
