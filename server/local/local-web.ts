// The local Workbench's server-rendered web router — a deliberately small subset
// of the hosted `web` router. Its home is a workspace switcher over the registry
// of opened folders; from a workspace it mounts the file src/raw pages, the
// read/edit workbench, page search, and the commit surface. The hosted
// issue/pull/settings/account/admin pages are NOT mounted: they read the raw
// forge client, which is absent in local mode.

import { Hono } from "hono";
import { compress } from "hono/compress";
import { repoHref } from "../../shared/url.js";
import type { AppEnv } from "../types.js";
import { globalRoute, htmlResponse, redirect, stringField } from "../routes/web-context.js";
import { emptyHtml, html, type Html } from "../routes/web-html.js";
import { pageShell, globalSidebar } from "../routes/web-shell.js";
import { registerFileRoutes } from "../routes/web-files.js";
import { registerLocalCommitRoutes } from "./local-commit.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.js";

// One workspace card on the switcher: name + slug, the folder path, and whether
// it is backed by a remote (so the user can tell a remote-connected workspace
// from a local-only one at a glance).
function workspaceCard(entry: WorkspaceEntry): Html {
  const href = repoHref(entry.identity.owner, entry.identity.repo);
  const remote = entry.gitRemote;
  const remoteRow = remote
    ? html`<div class="workspace-card__remote" data-testid="workspace-remote">
        <span class="badge">remote</span>
        <code>${remote.host}/${remote.owner}/${remote.repo}</code>
        <span class="muted">via <code>${remote.name}</code></span>
        ${entry.identity.canOpenPull ? html`<span class="badge badge--ok" title="A Cosheaf token is configured (.cosheaf/remote.json)">open-PR ready</span>` : html`<span class="muted" title="Add { url, token } to .cosheaf/remote.json to open pull requests">read-only remote</span>`}
      </div>`
    : html`<div class="workspace-card__remote muted" data-testid="workspace-remote">local-only (no git upstream)</div>`;
  return html`<li class="workspace-card" data-testid="workspace-card" data-slug="${entry.slug}">
    <div class="workspace-card__main">
      <a class="workspace-card__title" href="${href}"><strong>${entry.identity.title}</strong> <span class="muted">${entry.slug}</span></a>
      <div class="workspace-card__path muted"><code>${entry.path || "(in-memory)"}</code></div>
      ${remoteRow}
    </div>
    <form class="workspace-card__remove" method="post" action="/_workspace/remove">
      <input type="hidden" name="slug" value="${entry.slug}">
      <button class="button subtle" type="submit" title="Forget this workspace (does not delete files)">Remove</button>
    </form>
  </li>`;
}

function switcherPage(registry: WorkspaceRegistry, user: string, notice: string | null): string {
  const workspaces = registry.list();
  const body = html`<main class="page workbench-home">
    <div class="page-title compact"><div><h1>Workspaces</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="workspace-notice">${notice}</p>` : emptyHtml}
    ${
      workspaces.length === 0
        ? html`<div class="empty" data-testid="workspace-empty">No workspaces yet. Add a folder below to open it.</div>`
        : html`<ul class="workspace-list" data-testid="workspace-list">${workspaces.map(workspaceCard)}</ul>`
    }
    <form class="workspace-add" method="post" action="/_workspace/add" data-testid="workspace-add-form">
      <label>Add a folder
        <input name="path" required placeholder="/absolute/path/to/a/project" autocomplete="off" spellcheck="false" data-testid="workspace-add-path">
      </label>
      <div class="form-actions"><button class="button primary" type="submit">Add workspace</button></div>
    </form>
  </main>`;
  return pageShell({ title: "Workspaces", user, sidebar: globalSidebar("workspaces", user), body });
}

export function createLocalWebRouter(): Hono<AppEnv> {
  const localWeb = new Hono<AppEnv>();
  localWeb.use("*", compress());

  // Home → the workspace switcher over all opened folders.
  localWeb.get(
    "/",
    globalRoute((c) => htmlResponse(switcherPage(c.get("localRegistry"), c.get("user").username, c.req.query("toast") ?? null))),
  );

  // Open a folder as a workspace: derive its identity, index it, register it.
  // The path is whatever the user typed; addFolder validates it is a directory.
  localWeb.post(
    "/_workspace/add",
    globalRoute(async (c) => {
      const form = await c.req.parseBody();
      const path = stringField(form.path);
      if (!path) return redirect("/?toast=" + encodeURIComponent("A folder path is required."));
      try {
        const entry = await c.get("localRegistry").addFolder(path);
        return redirect(repoHref(entry.identity.owner, entry.identity.repo));
      } catch (err) {
        return redirect("/?toast=" + encodeURIComponent(err instanceof Error ? err.message : "Could not open that folder."));
      }
    }),
  );

  // Forget a workspace (leaves files + index untouched).
  localWeb.post(
    "/_workspace/remove",
    globalRoute(async (c) => {
      const form = await c.req.parseBody();
      const slug = stringField(form.slug);
      if (slug) c.get("localRegistry").removeFolder(slug);
      return redirect("/?toast=" + encodeURIComponent(slug ? `Removed ${slug}` : "Nothing to remove"));
    }),
  );

  // Local mode has no auth, so /login can never be reached legitimately. Keep a
  // backstop redirect so a stray bounce (e.g. the editor island's api.ts 401
  // path) lands on the switcher instead of dead-ending on a missing route.
  localWeb.get("/login", () => redirect("/"));
  localWeb.get("/logout", () => redirect("/"));

  // Tier 2: after the editor opens a PR it navigates to /:owner/:repo/pulls/:n.
  // The PR lives on the remote Cosheaf, so bounce there. 404 when no remote.
  localWeb.get("/:owner/:repo/pulls/:n{[0-9]+}", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const entry = resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry;
    const remote = entry?.remoteClient;
    if (!remote) return c.notFound();
    return redirect(remote.pullUrl(owner, repo, Number(c.req.param("n"))));
  });

  // The repo landing, file tree/src/raw pages, and the read/edit workbench —
  // all resolve through resolveWebRepo (which looks up the registry) and read
  // ctx.backend, so they work against the registered working tree unchanged.
  registerFileRoutes(localWeb);
  registerLocalCommitRoutes(localWeb);

  return localWeb;
}
