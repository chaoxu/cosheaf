// Tier 2 remote surface for the local Workbench: the Connect-to-a-remote-Cosheaf
// flow and the Sync action.
//
// A workspace with no connected core shows a Connect form (Cosheaf URL + token,
// validated by a whoami probe, written to the gitignored .cosheaf/remote.json).
// The not-connected Connect body (`notConnectedBody`) is rendered by the local
// web router's connect gate for every collaboration surface; once connected, the
// shared issue/pull/notification/activity/settings routes render the real pages
// from the connected core (#268). Sync fetches the upstream and fast-forwards.
// Mounted only by the local web router.

import type { Hono } from "hono";
import {
  badRequestPage,
  redirect,
  repoHref,
  stringField,
  type WebCtx,
  webRouteForWrite,
} from "../routes/web-context.js";
import { emptyHtml, type Html, html } from "../routes/web-html.js";
import type { AppEnv } from "../types.js";
import { friendlyLine } from "./git-errors.js";
import { publishLocalGitEvent } from "./local-events.js";
import type { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import { writeRemote } from "./local-workspace.js";
import { OriginCollaborationClient } from "./origin-collaboration-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

function localBackend(ctx: WebCtx): LocalGitWorkspaceBackend {
  return ctx.backend as LocalGitWorkspaceBackend;
}

// The Connect form — shared by the not-connected state (shown prominently) and
// the connected state (inside a "Reconnect" disclosure). Pre-fills the URL from
// the git upstream's host so the common case is one paste (the token).
function connectForm(ctx: WebCtx, entry: WorkspaceEntry | undefined, submitLabel: string): Html {
  const defaultUrl = entry?.gitRemote ? `https://${entry.gitRemote.host}` : "";
  const noGitRemote = !entry?.gitRemote;
  return html`<form class="connect-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/connect")}" data-testid="connect-form">
    <label>Cosheaf URL
      <input name="url" type="url" required placeholder="https://cosheaf.example" value="${defaultUrl}" autocomplete="off" spellcheck="false" data-testid="connect-url">
    </label>
    <label>API token
      <input name="token" type="password" required placeholder="opaque Cosheaf token" autocomplete="off" spellcheck="false" data-testid="connect-token">
    </label>
    <p class="muted">Stored in <code>.cosheaf/remote.json</code> (gitignored) — never committed. Create a token in your Cosheaf account settings.</p>
    ${noGitRemote ? html`<p class="form-warning" data-testid="connect-no-git-remote">Local git step blocked: this folder has no git remote, so pushes have nowhere to go. Add one with <code>git remote add origin &lt;url&gt;</code> before opening a remote pull request.</p>` : emptyHtml}
    <div class="form-actions"><button class="button primary" type="submit">${submitLabel}</button></div>
  </form>`;
}

// The not-connected Connect body, rendered by the local web router's connect gate
// for any collaboration surface (issues/pulls/notifications/activity/settings)
// when the workspace has no connected core. The shared collaboration routes take
// over once a core is connected (#268).
export function notConnectedBody(ctx: WebCtx, entry: WorkspaceEntry | undefined, notice: string | null): Html {
  return html`
    <div class="page-title compact"><div><h1>Remote pull requests</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="pulls-notice">${notice}</p>` : emptyHtml}
    <div class="empty" data-testid="pulls-disconnected">Local git state only: no connected Cosheaf server. Connect a workspace server to push branches and open remote pull requests from here.</div>
    ${connectForm(ctx, entry, "Connect")}`;
}

export function registerLocalRemoteRoutes(web: Hono<AppEnv>): void {
  // Connect (or reconnect) a workspace to a remote Cosheaf: validate the token
  // with a whoami probe, then write the gitignored remote.json and rebuild the
  // entry so its Core connection / open-PR capability light up.
  web.post(
    "/:owner/:repo/connect",
    webRouteForWrite(async (c, ctx) => {
      const form = await c.req.parseBody();
      const url = stringField(form.url)?.trim();
      const token = stringField(form.token)?.trim();
      if (!url || !token) return badRequestPage(ctx.user, "Both a Cosheaf URL and an API token are required.");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (_err) {
        return badRequestPage(ctx.user, "That doesn't look like a valid URL.");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return badRequestPage(ctx.user, "The Cosheaf URL must start with http:// or https://.");
      }
      let who: { username: string } | null;
      try {
        who = await new OriginCollaborationClient(url, token).whoami();
      } catch (err) {
        return badRequestPage(ctx.user, `Couldn't reach that Cosheaf: ${friendlyLine(err)}`);
      }
      if (!who) return badRequestPage(ctx.user, "The Cosheaf rejected that token. Double-check it and try again.");
      const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
      if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
      writeRemote(entry.path, { url, token });
      c.get("localRegistry").rebuild(entry.slug);
      return redirect(`${repoHref(ctx.owner, ctx.repo, "/pulls")}?toast=${encodeURIComponent(`Connected as ${who.username}.`)}`);
    }),
  );

  // Sync: fetch the upstream and fast-forward the current branch. Reports the
  // outcome (or a friendly failure) back on the commit page, where the button is.
  web.post(
    "/:owner/:repo/sync",
    webRouteForWrite(async (c, ctx) => {
      const dest = `${repoHref(ctx.owner, ctx.repo, "/commit")}?toast=`;
      try {
        const result = await localBackend(ctx).sync();
        if (result.fastForwarded) publishLocalGitEvent(c, ctx.ws.slug, { action: "synced" });
        return redirect(dest + encodeURIComponent(result.message));
      } catch (err) {
        return redirect(dest + encodeURIComponent(friendlyLine(err)));
      }
    }),
  );
}
