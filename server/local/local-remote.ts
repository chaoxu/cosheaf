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
import { localBackend, resolveLocalWorkspace } from "./local-mode.js";
import { writeRemote } from "./local-workspace.js";
import { OriginCollaborationClient } from "./origin-collaboration-client.js";
import { remoteHostLabel, savedRemoteDisplayLabel } from "./saved-remotes.js";
import type { SelectableRemoteCredential, WorkspaceEntry } from "./workspace-registry.js";

// Validate a pasted Cosheaf URL + token: parse the URL, require http/https, and
// probe it with a whoami. The kind lets each caller keep its own exact wording
// and response type (badRequestPage vs redirect toast); `detail` carries the
// friendly reachability line for the "unreachable" case.
export type RemoteProbe =
  | { ok: true; username: string }
  | { ok: false; kind: "invalid_url" | "bad_protocol" | "unreachable" | "rejected"; detail: string };

export async function probeRemote(url: string, token: string): Promise<RemoteProbe> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return { ok: false, kind: "invalid_url", detail: "" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, kind: "bad_protocol", detail: "" };
  }
  let who: { username: string } | null;
  try {
    who = await new OriginCollaborationClient(url, token).whoami();
  } catch (err) {
    return { ok: false, kind: "unreachable", detail: friendlyLine(err) };
  }
  if (!who) return { ok: false, kind: "rejected", detail: "" };
  return { ok: true, username: who.username };
}

// The Connect form — shared by the not-connected state (shown prominently) and
// the connected state (inside a "Reconnect" disclosure). Pre-fills the URL from
// the git upstream's host so the common case is one paste (the token).
function connectForm(ctx: WebCtx, entry: WorkspaceEntry | undefined, savedRemotes: readonly SelectableRemoteCredential[], submitLabel: string): Html {
  const defaultUrl = entry?.gitRemote ? `https://${entry.gitRemote.host}` : "";
  const noGitRemote = !entry?.gitRemote;
  return html`${savedRemotes.length > 0 ? savedConnectForm(ctx, savedRemotes) : emptyHtml}
  <form class="connect-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/connect")}" data-testid="connect-form">
    <h2>New API key</h2>
    <label>Cosheaf URL
      <input name="url" type="url" required placeholder="https://cosheaf.example" value="${defaultUrl}" autocomplete="off" spellcheck="false" data-testid="connect-url">
    </label>
    <label>API token
      <input name="token" type="password" required placeholder="opaque Cosheaf token" autocomplete="off" spellcheck="false" data-testid="connect-token">
    </label>
    <label>Key label
      <input name="label" placeholder="Work account" autocomplete="off" spellcheck="false" data-testid="connect-label">
    </label>
    <label class="checkbox-row">
      <input name="save_remote" type="checkbox" value="1" checked data-testid="connect-save-remote">
      <span>Save this server/API key</span>
    </label>
    <p class="muted">The selected workspace connection is written to <code>.cosheaf/remote.json</code> (gitignored).</p>
    ${noGitRemote ? html`<p class="form-warning" data-testid="connect-no-git-remote">Local git step blocked: this folder has no git remote, so pushes have nowhere to go. Add one with <code>git remote add origin &lt;url&gt;</code> before opening a remote pull request.</p>` : emptyHtml}
    <div class="form-actions"><button class="button primary" type="submit">${submitLabel}</button></div>
  </form>`;
}

function savedConnectForm(ctx: WebCtx, savedRemotes: readonly SelectableRemoteCredential[]): Html {
  return html`<form class="connect-form connect-form--saved" method="post" action="${repoHref(ctx.owner, ctx.repo, "/connect")}" data-testid="connect-saved-form">
    <h2>Saved API key</h2>
    <label>Server/API key
      <select name="remote_id" required data-testid="connect-saved-remote">
        ${groupedSavedRemoteOptions(savedRemotes)}
      </select>
    </label>
    <div class="form-actions"><button class="button primary" type="submit">Connect saved key</button></div>
  </form>`;
}

function groupedSavedRemoteOptions(savedRemotes: readonly SelectableRemoteCredential[]): Html {
  const byServer = new Map<string, SelectableRemoteCredential[]>();
  for (const remote of savedRemotes) {
    const label = remoteHostLabel(remote.url);
    byServer.set(label, [...(byServer.get(label) ?? []), remote]);
  }
  return html`${[...byServer.entries()].map(([server, remotes]) => html`<optgroup label="${server}">
        ${remotes.map((remote) => html`<option value="${remote.id}">${savedRemoteDisplayLabel(remote)}</option>`)}
  </optgroup>`)}`;
}

// The not-connected Connect body, rendered by the local web router's connect gate
// for any collaboration surface (issues/pulls/notifications/activity/settings)
// when the workspace has no connected core. The shared collaboration routes take
// over once a core is connected (#268).
export function notConnectedBody(ctx: WebCtx, entry: WorkspaceEntry | undefined, savedRemotes: readonly SelectableRemoteCredential[], notice: string | null): Html {
  return html`
    <div class="page-title compact"><div><h1>Remote pull requests</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="pulls-notice">${notice}</p>` : emptyHtml}
    <div class="empty" data-testid="pulls-disconnected">Local git state only: no connected Cosheaf server. Connect a workspace server to push branches and open remote pull requests from here.</div>
    ${connectForm(ctx, entry, savedRemotes, "Connect")}`;
}

export function registerLocalRemoteRoutes(web: Hono<AppEnv>): void {
  // Connect (or reconnect) a workspace to a remote Cosheaf: validate the token
  // with a whoami probe, then write the gitignored remote.json and rebuild the
  // entry so its Core connection / open-PR capability light up.
  web.post(
    "/:owner/:repo/connect",
    webRouteForWrite(async (c, ctx) => {
      const form = await c.req.parseBody();
      const registry = c.get("localRegistry");
      const saved = registry.getSavedRemote(stringField(form.remote_id)?.trim() ?? "");
      const url = saved?.url ?? stringField(form.url)?.trim();
      const token = saved?.token ?? stringField(form.token)?.trim();
      if (!url || !token) return badRequestPage(ctx.user, "Both a Cosheaf URL and an API token are required.");
      const probe = await probeRemote(url, token);
      if (!probe.ok) {
        const message =
          probe.kind === "invalid_url"
            ? "That doesn't look like a valid URL."
            : probe.kind === "bad_protocol"
              ? "The Cosheaf URL must start with http:// or https://."
              : probe.kind === "unreachable"
                ? `Couldn't reach that Cosheaf: ${probe.detail}`
                : "The Cosheaf rejected that token. Double-check it and try again.";
        return badRequestPage(ctx.user, message);
      }
      const who = { username: probe.username };
      const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
      if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
      writeRemote(entry.path, { url, token });
      if (!saved && stringField(form.save_remote) === "1") {
        registry.saveRemote({ url, token, username: who.username, label: stringField(form.label) });
      }
      registry.rebuild(entry.slug);
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
