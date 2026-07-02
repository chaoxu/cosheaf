// The local Workbench's server-rendered web router — a deliberately small subset
// of the hosted `web` router. Its home is a workspace switcher over the registry
// of opened folders; from a workspace it mounts the file src/raw pages, the
// read/edit workbench, page search, and the commit surface. The hosted
// issue/pull/settings/account/admin pages are NOT mounted: they read the raw
// forge client, which is absent in local mode.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, setCookie } from "hono/cookie";
import { repoHref } from "../../shared/url.js";
import { registerNotificationActivityRoutes } from "../routes/web-activity.js";
import { registerBranchRoutes } from "../routes/web-branches.js";
import { globalRoute, htmlResponse, redirect, requestOrigin, resolveWebRepo, safeWebRedirect, stringField } from "../routes/web-context.js";
import { registerDiagnosticsRoutes } from "../routes/web-diagnostics.js";
import { registerFileRoutes } from "../routes/web-files.js";
import { emptyHtml, type Html, html } from "../routes/web-html.js";
import { registerIssueRoutes } from "../routes/web-issues.js";
import { type RepoTab, repoPageShell } from "../routes/web-page.js";
import { registerPullRoutes } from "../routes/web-pulls.js";
import { registerSettingsRoutes } from "../routes/web-settings.js";
import { globalSidebar, pageShell } from "../routes/web-shell.js";
import type { AppEnv } from "../types.js";
import { registerLocalAgentSessionRoutes } from "./local-agent-sessions.js";
import { hasWorkbenchAccess, localAuthGate, tokenMatches, WORKBENCH_COOKIE } from "./local-auth.js";
import { registerLocalCommitRoutes } from "./local-commit.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import { notConnectedBody, registerLocalRemoteRoutes } from "./local-remote.js";
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

function browsePage(user: string, dir: string, notice: string | null, signOut: boolean): string {
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
  return pageShell({ title: "Pick a folder", user, sidebar: globalSidebar("workspaces", user, null, undefined, { profile: true, signOut, local: true }), body });
}

function switcherPage(registry: WorkspaceRegistry, user: string, notice: string | null, signOut: boolean): string {
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
  return pageShell({ title: "Workspaces", user, sidebar: globalSidebar("workspaces", user, null, undefined, { profile: true, signOut, local: true }), body });
}

// The Workbench profile page: a git authorship identity (name + email) used to
// sign commits when a folder's own git config has none. Stored centrally in the
// registry config, not per-folder.
function profilePage(registry: WorkspaceRegistry, user: string, notice: string | null, signOut: boolean): string {
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
  return pageShell({ title: "Profile", user, sidebar: globalSidebar("account", user, null, undefined, { profile: true, signOut, local: true }), body });
}

// The Workbench access-token sign-in page, shown only when COSHEAF_WORKBENCH_TOKEN
// is set (the operator exposed the Workbench beyond loopback). A single token
// field; no username — the Workbench is single-user. `next` is a same-site path
// to return to after login.
function loginPage(next: string, error: boolean): string {
  const body = html`<main class="auth-page">
    <form class="auth-card" method="post" action="/login" data-testid="workbench-login">
      <h1>Cosheaf Workbench</h1>
      ${error ? html`<p class="auth-notice auth-notice--error" role="alert">That access token was not recognized.</p>` : emptyHtml}
      <p class="muted">This Workbench requires an access token.</p>
      <input type="hidden" name="next" value="${next}">
      <label>Access token <input name="token" type="password" autocomplete="current-password" required autofocus data-testid="workbench-login-token"></label>
      <button type="submit">Sign in</button>
    </form>
  </main>`;
  return pageShell({ title: "Sign in", body });
}


// The <title> label for a gated collaboration surface shown in its not-connected
// Connect state.
const CONNECT_TITLES: Record<string, string> = {
  issues: "Issues",
  pulls: "Pull requests",
  notifications: "Notifications",
  activity: "Activity",
  settings: "Settings",
};

// The connect gate for a collaboration surface (#268): when the workspace has no
// connected core, render the Connect prompt instead of letting the shared route
// call ctx.collab (which would throw NoCoreConnectedError). When a core IS
// connected, fall through to the shared route that reads the connected core.
function coreConnectGate(active: RepoTab, titleLabel?: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const entry = owner && repo ? resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry : undefined;
    // Unknown workspace → let the shared route resolve and 404. Connected core →
    // the shared route renders the real page.
    if (!entry || entry.remote) return next();
    const ctx = await resolveWebRepo(c);
    if (!ctx.ok) return ctx.response;
    // titleLabel overrides the tab→title map for surfaces (e.g. branches) that
    // share a tab with a differently-named page.
    const title = `${titleLabel ?? CONNECT_TITLES[active] ?? active} - ${ctx.repo}`;
    return htmlResponse(repoPageShell(ctx, active, title, notConnectedBody(ctx, entry, c.req.query("toast") ?? null)));
  };
}

export function createLocalWebRouter(): Hono<AppEnv> {
  const localWeb = new Hono<AppEnv>();
  localWeb.use("*", compress());
  // Access gate: a no-op unless COSHEAF_WORKBENCH_TOKEN is set, in which case
  // every page (except /login, /logout) requires the token. Runs before the
  // routes so an unauthenticated browser bounces to /login.
  localWeb.use("*", localAuthGate());

  // Home → the workspace switcher over all opened folders.
  localWeb.get(
    "/",
    globalRoute((c) => htmlResponse(switcherPage(c.get("localRegistry"), c.get("user").username, c.req.query("toast") ?? null, Boolean(c.get("config").accessToken)))),
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
      return htmlResponse(browsePage(c.get("user").username, dir, c.req.query("toast") ?? null, Boolean(c.get("config").accessToken)));
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
    globalRoute((c) => htmlResponse(profilePage(c.get("localRegistry"), c.get("user").username, c.req.query("toast") ?? null, Boolean(c.get("config").accessToken)))),
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

  // Sign-in for the access-token gate. With no token configured the Workbench is
  // loopback no-auth, so /login just bounces to the switcher (also the backstop
  // for a stray 401 from the editor island's api.ts). With a token, GET renders
  // the form (or skips it when already signed in) and POST validates the token.
  localWeb.get("/login", (c) => {
    const expected = c.get("config").accessToken;
    if (!expected) return redirect("/");
    const next = safeWebRedirect(c.req.query("next") ?? null) ?? "/";
    if (hasWorkbenchAccess(c, expected)) return redirect(next);
    return htmlResponse(loginPage(next, c.req.query("error") === "1"));
  });
  localWeb.post("/login", async (c) => {
    const expected = c.get("config").accessToken;
    if (!expected) return redirect("/");
    const form = await c.req.parseBody();
    const next = safeWebRedirect(stringField(form.next)) ?? "/";
    if (!tokenMatches(stringField(form.token) ?? null, expected)) {
      return redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
    }
    setCookie(c, WORKBENCH_COOKIE, expected, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      // Mark Secure when the browser-facing scheme is https — directly (the
      // request URL) or via the operator's TLS proxy (X-Forwarded-Proto). Local
      // mode trusts no proxy hops, so requestOrigin alone would always see http;
      // reading the header here is fail-safe: a spoofed https only makes the
      // cookie Secure (then unsent over http), never leaks it.
      secure: requestOrigin(c).startsWith("https://") || c.req.header("x-forwarded-proto") === "https",
    });
    // c.redirect (not the redirect() helper) so the Set-Cookie just written to
    // c.res survives — a fresh Response would drop it.
    return c.redirect(next, 303);
  });
  localWeb.get("/logout", (c) => {
    deleteCookie(c, WORKBENCH_COOKIE, { path: "/" });
    // c.redirect so the cookie-clearing Set-Cookie survives (a fresh Response
    // from the redirect() helper would drop it).
    return c.redirect(c.get("config").accessToken ? "/login" : "/", 303);
  });

  // The repo landing, file tree/src/raw pages, and the read/edit workbench —
  // all resolve through resolveWebRepo (which looks up the registry) and read
  // ctx.backend, so they work against the registered working tree unchanged.
  // Diagnostics reads the local SQLite sidecar, so it needs no connected core.
  registerFileRoutes(localWeb);
  registerLocalCommitRoutes(localWeb);
  registerLocalAgentSessionRoutes(localWeb);
  registerDiagnosticsRoutes(localWeb);

  // Collaboration surfaces (#268): gate on a connected core first — no core →
  // the Connect prompt; a connected core → the SAME shared routes the hosted app
  // mounts, reading the core through ctx.collab. The gate `.use()` calls MUST be
  // registered before the shared routes so they run first in Hono's chain.
  localWeb.use("/:owner/:repo/issues", coreConnectGate("issues"));
  localWeb.use("/:owner/:repo/issues/*", coreConnectGate("issues"));
  localWeb.use("/:owner/:repo/pulls", coreConnectGate("pulls"));
  localWeb.use("/:owner/:repo/pulls/*", coreConnectGate("pulls"));
  // Branches list its branches from the connected core (ctx.collab.listBranches),
  // so gate it like the other collaboration surfaces; it renders under the files
  // tab, hence the explicit "Branches" title. The /commits/:sha detail page is
  // NOT gated — it reads the local git working tree through ctx.backend.
  localWeb.use("/:owner/:repo/branches", coreConnectGate("files", "Branches"));
  localWeb.use("/:owner/:repo/branches/*", coreConnectGate("files", "Branches"));
  localWeb.use("/:owner/:repo/notifications", coreConnectGate("notifications"));
  localWeb.use("/:owner/:repo/notifications/*", coreConnectGate("notifications"));
  localWeb.use("/:owner/:repo/activity", coreConnectGate("activity"));
  localWeb.use("/:owner/:repo/settings", coreConnectGate("settings"));
  localWeb.use("/:owner/:repo/settings/*", coreConnectGate("settings"));
  registerIssueRoutes(localWeb);
  registerPullRoutes(localWeb);
  // Branches list (gated above) + the local /commits/:sha detail page. Mounted in
  // the same relative order as the hosted router (after pulls, before activity).
  registerBranchRoutes(localWeb);
  registerNotificationActivityRoutes(localWeb);
  registerSettingsRoutes(localWeb);

  // The Connect / Sync actions (local-only). The not-connected Connect prompt is
  // served by the gate above; this just keeps the POST /connect and /sync flows.
  registerLocalRemoteRoutes(localWeb);

  return localWeb;
}
