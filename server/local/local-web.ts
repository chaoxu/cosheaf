// The local Workbench's server-rendered web router — a deliberately small subset
// of the hosted `web` router. Its home is a workspace switcher over the registry
// of opened folders; from a workspace it mounts the file src/raw pages, the
// read/edit workbench, page search, and the commit surface. The hosted
// issue/pull/settings/account/admin pages are NOT mounted: they read the raw
// forge client, which is absent in local mode.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { repoHref } from "../../shared/url.js";
import type { AppEnv } from "../types.js";
import { globalRoute, htmlResponse, redirect, stringField } from "../routes/web-context.js";
import { emptyHtml, html, type Html } from "../routes/web-html.js";
import { pageShell, globalSidebar } from "../routes/web-shell.js";
import { registerFileRoutes } from "../routes/web-files.js";
import { registerLocalCommitRoutes } from "./local-commit.js";
import { registerLocalRemoteRoutes } from "./local-remote.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.js";

// A compact path for the card: abbreviate the home dir to ~ and elide a deep
// middle so it stays readable; the full path is kept in the title tooltip.
function shortPath(full: string): string {
  const home = homedir();
  const p = full === home ? "~" : full.startsWith(home + sep) ? `~${full.slice(home.length)}` : full;
  const segs = p.split(sep);
  return segs.length <= 4 ? p : `${segs[0]}${sep}…${sep}${segs.slice(-2).join(sep)}`;
}

// One workspace card on the switcher: name + slug, the folder path, and whether
// it is backed by a remote (so the user can tell a remote-connected workspace
// from a local-only one at a glance).
function workspaceCard(entry: WorkspaceEntry): Html {
  const href = repoHref(entry.identity.owner, entry.identity.repo);
  const remote = entry.gitRemote;
  const cosheafServer = entry.remote ? serverLabel(entry.remote.url) : null;
  const remoteRow = remote
    ? html`<div class="workspace-card__remote" data-testid="workspace-remote">
        <span class="badge">git remote</span>
        <code>${remote.host}/${remote.owner}/${remote.repo}</code>
        <span class="muted">via <code>${remote.name}</code></span>
        ${cosheafServer
          ? html`<span class="badge badge--ok" title="Remote Cosheaf server from .cosheaf/remote.json">Cosheaf server: ${cosheafServer}</span>`
          : html`<span class="muted" title="Add { url, token } to .cosheaf/remote.json to open remote pull requests">local git only; connect a Cosheaf server for collaboration</span>`}
      </div>`
    : html`<div class="workspace-card__remote muted" data-testid="workspace-remote">Local-only workspace. Collaboration features need a connected Cosheaf server.</div>`;
  return html`<li class="workspace-card" data-testid="workspace-card" data-slug="${entry.slug}">
    <div class="workspace-card__main">
      <a class="workspace-card__title" href="${href}"><strong>${entry.identity.title}</strong> <span class="muted">${entry.slug}</span></a>
      <div class="workspace-card__path" title="${entry.path}"><code>${entry.path ? shortPath(entry.path) : "(in-memory)"}</code></div>
      ${remoteRow}
    </div>
    <form class="workspace-card__remove" method="post" action="/_workspace/remove">
      <input type="hidden" name="slug" value="${entry.slug}">
      <button class="button subtle" type="submit" title="Forget this workspace (does not delete files)">Remove</button>
    </form>
  </li>`;
}

function serverLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch (_err) {
    return url;
  }
}

// --- Folder picker -------------------------------------------------------
// A server-side directory browser: a browser can't hand the server a folder
// path (sandboxed), and the Workbench runs where its files are, so folder
// selection has to walk the server's own filesystem.

const PICKER_MAX = 400; // cap a pathologically large directory listing

// Expand a leading `~` so a pasted "~/notes" resolves to the home directory.
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

// Clickable path segments so the user can jump to any ancestor directory. Each
// crumb is prefixed with a "/" separator in CSS, so `/a/b` renders `/a /b`.
function breadcrumb(dir: string): Html {
  let acc = "";
  const crumbs: Html[] = [];
  for (const segment of dir.split(sep).filter(Boolean)) {
    acc += sep + segment;
    const here = acc;
    crumbs.push(html`<a class="crumb" href="/_browse?path=${encodeURIComponent(here)}">${segment}</a>`);
  }
  return html`<nav class="browse-crumbs" data-testid="browse-crumbs">${crumbs.length ? crumbs : html`<span class="crumb">${sep}</span>`}</nav>`;
}

function isGitRepo(dir: string): boolean {
  try {
    statSync(join(dir, ".git"));
    return true;
  } catch (_err) {
    return false;
  }
}

function markdownCount(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => /\.(md|markdown)$/i.test(n)).length;
  } catch (_err) {
    return 0;
  }
}

function listChildDirs(dir: string): { name: string; path: string; git: boolean }[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .slice(0, PICKER_MAX)
    .map((e) => ({ name: e.name, path: join(dir, e.name), git: isGitRepo(join(dir, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function browsePage(user: string, dir: string, notice: string | null): string {
  const parent = dirname(dir);
  const home = homedir();
  const children = listChildDirs(dir);
  const git = isGitRepo(dir);
  const mdCount = markdownCount(dir);
  const body = html`<main class="page workbench-home">
    <div class="page-title compact"><div><h1>Pick a folder</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="browse-notice">${notice}</p>` : emptyHtml}
    <p class="muted">Browsing this machine's files. Go into a folder, then open it as a workspace.</p>
    <div class="browse-toolbar" data-testid="browse-toolbar">
      <a class="button subtle" href="/_browse?path=${encodeURIComponent(home)}">⌂ Home</a>
      ${dir !== parent ? html`<a class="button subtle" href="/_browse?path=${encodeURIComponent(parent)}" data-testid="browse-up">↑ Up</a>` : emptyHtml}
      ${breadcrumb(dir)}
    </div>
    <form class="browse-open-current" method="post" action="/_workspace/add">
      <input type="hidden" name="path" value="${dir}">
      <button class="button primary" type="submit" data-testid="browse-open-current">Open this folder</button>
      <span class="muted">${git ? "git repo · " : ""}${mdCount} markdown file${mdCount === 1 ? "" : "s"}</span>
    </form>
    ${
      children.length === 0
        ? html`<p class="muted" data-testid="browse-empty">No sub-folders here.</p>`
        : html`<ul class="browse-list" data-testid="browse-list">${children.map(
            (d) => html`<li class="browse-item">
              <a class="browse-item__name" href="/_browse?path=${encodeURIComponent(d.path)}" data-testid="browse-dir">${d.name}</a>
              ${d.git ? html`<span class="badge badge--ok" title="git repository">git</span>` : emptyHtml}
              <form method="post" action="/_workspace/add" class="browse-item__open">
                <input type="hidden" name="path" value="${d.path}">
                <button class="button subtle" type="submit">open</button>
              </form>
            </li>`,
          )}</ul>`
    }
    <p class="browse-back"><a href="/">← back to workspaces</a></p>
  </main>`;
  return pageShell({ title: "Pick a folder", user, sidebar: globalSidebar("workspaces", user, null, undefined, { profile: true }), body });
}

function switcherPage(registry: WorkspaceRegistry, user: string, notice: string | null): string {
  const workspaces = registry.list();
  const body = html`<main class="page workbench-home">
    <div class="page-title compact"><div><h1>Workspaces</h1></div></div>
    <p class="workbench-subtitle">Open a local folder as a Coflat workspace. Edits and commits stay in local git; pull requests live on the connected Cosheaf server.</p>
    ${notice ? html`<p class="muted" data-testid="workspace-notice">${notice}</p>` : emptyHtml}
    ${
      workspaces.length === 0
        ? html`<div class="empty" data-testid="workspace-empty">No workspaces yet — <strong>browse for a folder</strong> to open one.</div>`
        : html`<ul class="workspace-list" data-testid="workspace-list">${workspaces.map(workspaceCard)}</ul>`
    }
    <div class="workspace-add" data-testid="workspace-add">
      <a class="button primary" href="/_browse" data-testid="workspace-browse">Browse for a folder…</a>
      <form class="workspace-add__paste" method="post" action="/_workspace/add" data-testid="workspace-add-form">
        <label class="muted">or paste a path
          <input name="path" placeholder="/absolute/path/to/a/project" autocomplete="off" spellcheck="false" data-testid="workspace-add-path">
        </label>
        <button class="button subtle" type="submit">Add</button>
      </form>
    </div>
  </main>`;
  return pageShell({ title: "Workspaces", user, sidebar: globalSidebar("workspaces", user, null, undefined, { profile: true }), body });
}

// The Workbench profile page: a git authorship identity (name + email) used to
// sign commits when a folder's own git config has none. Stored centrally in the
// registry config, not per-folder.
function profilePage(registry: WorkspaceRegistry, user: string, notice: string | null): string {
  const profile = registry.getProfile();
  const body = html`<main class="page workbench-home">
    <div class="page-title compact"><div><h1>Profile</h1></div></div>
    <p class="workbench-subtitle">Your git authorship identity. Used to sign commits when a folder's own git config has none — so a freshly-cloned repo can commit without setup.</p>
    ${notice ? html`<p class="muted" data-testid="profile-notice">${notice}</p>` : emptyHtml}
    <form class="profile-form" method="post" action="/_profile" data-testid="profile-form">
      <label>Name
        <input name="name" required value="${profile?.name ?? ""}" placeholder="Ada Lovelace" autocomplete="off" data-testid="profile-name">
      </label>
      <label>Email
        <input name="email" type="email" required value="${profile?.email ?? ""}" placeholder="ada@example.com" autocomplete="off" data-testid="profile-email">
      </label>
      <div class="form-actions"><button class="button primary" type="submit">Save</button></div>
    </form>
  </main>`;
  return pageShell({ title: "Profile", user, sidebar: globalSidebar("account", user, null, undefined, { profile: true }), body });
}

export function createLocalWebRouter(): Hono<AppEnv> {
  const localWeb = new Hono<AppEnv>();
  localWeb.use("*", compress());

  // Home → the workspace switcher over all opened folders.
  localWeb.get(
    "/",
    globalRoute((c) => htmlResponse(switcherPage(c.get("localRegistry"), c.get("user").username, c.req.query("toast") ?? null))),
  );

  // Folder picker: browse the server's filesystem to choose a folder. A browser
  // can't hand the server a path, so selection walks the server's own files.
  localWeb.get(
    "/_browse",
    globalRoute((c) => {
      const raw = c.req.query("path");
      let dir = raw && raw.trim() ? resolve(expandTilde(raw)) : homedir();
      try {
        if (!statSync(dir).isDirectory()) dir = homedir();
      } catch (_err) {
        dir = homedir();
      }
      return htmlResponse(browsePage(c.get("user").username, dir, c.req.query("toast") ?? null));
    }),
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
        const entry = await c.get("localRegistry").addFolder(expandTilde(path));
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

  // Workbench profile (git authorship identity). Global, not per-workspace.
  localWeb.get(
    "/_profile",
    globalRoute((c) => htmlResponse(profilePage(c.get("localRegistry"), c.get("user").username, c.req.query("toast") ?? null))),
  );
  localWeb.post(
    "/_profile",
    globalRoute(async (c) => {
      const form = await c.req.parseBody();
      const name = stringField(form.name)?.trim() ?? "";
      const email = stringField(form.email)?.trim() ?? "";
      if (!name || !email) return redirect(`/_profile?toast=${encodeURIComponent("Both a name and email are required.")}`);
      c.get("localRegistry").setProfile({ name, email });
      return redirect(`/_profile?toast=${encodeURIComponent("Profile saved.")}`);
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
  registerLocalRemoteRoutes(localWeb);

  return localWeb;
}
