// Tier 2 remote surface for the local Workbench: the "Pull requests" page, which
// doubles as the Connect-to-a-remote-Cosheaf flow, plus the Sync action.
//
// A workspace with no remote shows a Connect form (Cosheaf URL + token, validated
// by a whoami probe, written to the gitignored .cosheaf/remote.json). A connected
// workspace shows who the token authenticates as and the remote's open pull
// requests, read through the typed Cosheaf API (never a forge call). Sync fetches
// the upstream and fast-forwards. Mounted only by the local web router.

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
import { emptyHtml, html, type Html } from "../routes/web-html.js";
import { repoPageShell } from "../routes/web-page.js";
import { friendlyLine } from "./git-errors.js";
import type { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import { writeRemote } from "./local-workspace.js";
import { RemoteCosheafClient, type RemotePullSummary } from "./remote-cosheaf-client.js";
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
    ${noGitRemote ? html`<p class="form-warning" data-testid="connect-no-git-remote">This folder has no git remote, so pushes have nowhere to go. Add one with <code>git remote add origin &lt;url&gt;</code> before opening a pull request.</p>` : emptyHtml}
    <div class="form-actions"><button class="button primary" type="submit">${submitLabel}</button></div>
  </form>`;
}

function notConnectedBody(ctx: WebCtx, entry: WorkspaceEntry | undefined, notice: string | null): Html {
  return html`
    <div class="page-title compact"><div><h1>Pull requests</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="pulls-notice">${notice}</p>` : emptyHtml}
    <div class="empty" data-testid="pulls-disconnected">Not connected to a remote Cosheaf. Connect one to push branches and open pull requests from here.</div>
    ${connectForm(ctx, entry, "Connect")}`;
}

function prList(ctx: WebCtx, pulls: RemotePullSummary[]): Html {
  if (pulls.length === 0) {
    return html`<div class="empty" data-testid="pulls-empty">No open pull requests. Commit on a branch, then use “Open PR” in the editor.</div>`;
  }
  return html`<ul class="pr-list" data-testid="pr-list">${pulls.map(
    (p) => html`<li class="pr-item">
      <a class="pr-item__title" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${p.number}`)}">#${p.number} ${p.title}</a>
      <span class="pr-item__meta muted"><code>${p.head_ref}</code> → <code>${p.base_ref}</code> · ${p.author_username}</span>
    </li>`,
  )}</ul>`;
}

function connectedBody(
  ctx: WebCtx,
  entry: WorkspaceEntry,
  who: { username: string } | null,
  pulls: RemotePullSummary[],
  error: string | null,
  notice: string | null,
): Html {
  const host = entry.gitRemote?.host ?? "remote";
  return html`
    <div class="page-title compact"><div><h1>Pull requests</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="pulls-notice">${notice}</p>` : emptyHtml}
    ${error ? html`<p class="form-error" data-testid="pulls-error">${error}</p>` : emptyHtml}
    <div class="connect-status" data-testid="connect-status">
      <span class="badge badge--ok">connected</span>
      <code>${host}</code>
      ${who ? html`<span class="muted">as <strong>${who.username}</strong></span>` : html`<span class="form-error">token not recognized</span>`}
    </div>
    ${prList(ctx, pulls)}
    <details class="connect-reconnect">
      <summary>Reconnect or change token</summary>
      ${connectForm(ctx, entry, "Save")}
    </details>`;
}

export function registerLocalRemoteRoutes(web: Hono<AppEnv>): void {
  // The "Pull requests" tab: Connect form when no remote; remote identity + open
  // PRs when connected.
  web.get(
    "/:owner/:repo/pulls",
    webRoute(async (c, ctx) => {
      const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
      const notice = c.req.query("toast") ?? null;
      const remote = entry?.remoteClient;
      let body: Html;
      if (!remote) {
        body = notConnectedBody(ctx, entry, notice);
      } else {
        let who: { username: string } | null = null;
        let pulls: RemotePullSummary[] = [];
        let error: string | null = null;
        try {
          who = await remote.whoami();
        } catch (err) {
          error = friendlyLine(err);
        }
        try {
          pulls = await remote.listPulls(ctx.owner, ctx.repo, "open");
        } catch (err) {
          error = error ?? friendlyLine(err);
        }
        body = connectedBody(ctx, entry, who, pulls, error, notice);
      }
      return htmlResponse(repoPageShell(ctx, "pulls", `Pull requests - ${ctx.repo}`, body));
    }),
  );

  // Connect (or reconnect) a workspace to a remote Cosheaf: validate the token
  // with a whoami probe, then write the gitignored remote.json and rebuild the
  // entry so its remoteClient / open-PR capability light up.
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
        who = await new RemoteCosheafClient(url, token).whoami();
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
    webRouteForWrite(async (_c, ctx) => {
      const dest = `${repoHref(ctx.owner, ctx.repo, "/commit")}?toast=`;
      try {
        const result = await localBackend(ctx).sync();
        return redirect(dest + encodeURIComponent(result.message));
      } catch (err) {
        return redirect(dest + encodeURIComponent(friendlyLine(err)));
      }
    }),
  );
}
