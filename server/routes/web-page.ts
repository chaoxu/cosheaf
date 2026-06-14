import type { ForgejoBranch, ForgejoLabel, ForgejoUser } from "../forgejo-types.js";
import type { WorkspaceContext } from "../types.js";
import { repoHref, type WebCtx, type WebListState } from "./web-context.js";
import { emptyHtml, html, type Html, joinHtml } from "./web-html.js";
import { type Panel, renderRegion } from "./web-panels.js";
import { modeToggle, notificationsNavLink, pageShell, sidebarIdentity, type StatusCrumb } from "./web-shell.js";

export type RepoTab = "files" | "issues" | "pulls" | "chat" | "notifications" | "activity" | "settings";

// A small "+ <label>" disclosure that keeps a durable add/create form closed by
// default behind a native <details>, so a panel/section reads cleanly when
// you're just looking. The summary is the only always-visible affordance
// (keyboard-focusable + labelled); opening it reveals the form unchanged. Used
// for settings create-forms, issue dependencies, PR reviewer requests, and rail
// label editing.
export function addDisclosure(label: string, form: Html): Html {
  return html`<details class="add-disclosure">
    <summary>+ ${label}</summary>
    ${form}
  </details>`;
}

// Shared <datalist> of repo collaborators for the filter-bar username inputs
// (Author/Assignee/Mentioned). Native datalist gives type-to-filter with no
// island; the fields stay free-text for usernames not in the collaborator set.
export const USERNAME_DATALIST_ID = "repo-usernames";
export function usernameDatalist(collaborators: readonly ForgejoUser[]): Html {
  return html`<datalist id="${USERNAME_DATALIST_ID}">${collaborators.map((u) => html`<option value="${u.login}"></option>`)}</datalist>`;
}

const REPO_TABS = [
  ["files", "Files", ""],
  ["issues", "Issues", "/issues"],
  ["pulls", "PRs", "/pulls"],
  ["chat", "Chat", "/chat"],
  ["notifications", "Notifications", "/notifications"],
  ["activity", "Activity", "/activity"],
  ["settings", "Settings", "/settings"],
] as const;

// Prefill repoPage's owner/repo/user/ws from a resolved WebCtx; handlers pass
// only what actually varies (active tab, title, body, and optional reader
// assets) instead of repeating the ctx spread at every call site.
export function repoPageShell(
  ctx: WebCtx,
  active: RepoTab,
  title: string,
  body: Html,
  opts: { readerAssets?: boolean; sidebarPanels?: readonly Panel[]; statusExtra?: readonly StatusCrumb[] } = {},
): string {
  return repoPage({
    title,
    body,
    active,
    owner: ctx.owner,
    repo: ctx.repo,
    user: ctx.user,
    ws: ctx.ws,
    wsTitle: ctx.wsTitle,
    readerAssets: opts.readerAssets,
    sidebarPanels: opts.sidebarPanels,
    statusExtra: opts.statusExtra,
  });
}

export function repoPage(opts: {
  title: string;
  owner: string;
  repo: string;
  active: RepoTab;
  user: string;
  ws: WorkspaceContext;
  // Workspace title (Forgejo repo description) for the Read-mode identity (#147);
  // "" falls back to the owner/repo slug in both the sidebar chip and breadcrumb.
  wsTitle: string;
  body: Html;
  readerAssets?: boolean;
  // Portable panels rendered into the left-sidebar region under the repo tabs
  // (#119 file tree via the #120 panel seam); other tabs leave it unset.
  sidebarPanels?: readonly Panel[];
  // Extra status-bar breadcrumb segments appended after owner/repo/tab — the
  // edit page uses this to show the branch + file path being edited (#126).
  statusExtra?: readonly StatusCrumb[];
}): string {
  const nav = REPO_TABS.map(([id, label, suffix]) => tab(opts, id, label, suffix));
  const activeLabel = REPO_TABS.find(([id]) => id === opts.active)?.[1] ?? opts.active;
  return pageShell({
    title: opts.title,
    user: opts.user,
    readerAssets: opts.readerAssets,
    sidebar: html`
      <span class="brand">Cosheaf</span>
      ${sidebarIdentity(opts.user)}
      ${modeToggle()}
      <nav class="sidebar-topnav">
        <a href="/">‹ Workspaces</a>
        ${notificationsNavLink(false)}
      </nav>
      <div class="sidebar-workspace">
        <a href="${repoHref(opts.owner, opts.repo)}">${workspaceChipIdent(opts.owner, opts.repo, opts.wsTitle)}</a>
        <span class="role">${opts.ws.role}</span>
      </div>
      <nav class="repo-tabs">${nav}</nav>
      ${opts.sidebarPanels?.length ? renderRegion(opts.sidebarPanels) : emptyHtml}`,
    statusPath: [
      // In Read mode the owner crumb hides and the repo crumb surfaces the
      // workspace title (#147); with no title these stay plain owner/repo.
      { label: opts.owner, cls: opts.wsTitle ? "status-owner" : undefined },
      { label: opts.repo, href: repoHref(opts.owner, opts.repo), wsTitle: opts.wsTitle || undefined },
      { label: activeLabel.toLowerCase() },
      ...(opts.statusExtra ?? []),
    ],
    body: html`
      <main class="repo-page">
        <section class="repo-body">${opts.body}</section>
      </main>
    `,
  });
}

// Sidebar workspace identity (#147). With a title we render both the title and
// the owner/repo slug; CSS shows the slug in Build mode and the title (slug
// demoted to a muted subtitle) in Read mode. With no title the slug alone shows
// in both modes (marked --only so Read mode doesn't demote it to nothing).
function workspaceChipIdent(owner: string, repo: string, title: string): Html {
  const slug = `${owner}/${repo}`;
  if (!title) return html`<span class="ws-slug ws-slug--only">${slug}</span>`;
  return html`<span class="ws-title">${title}</span><span class="ws-slug">${slug}</span>`;
}

function tab(
  opts: { owner: string; repo: string; active: string },
  id: string,
  label: string,
  suffix: string,
): Html {
  // Plain-label nav (Files, Issues, …) in the typography-first mono chrome (#149).
  // Every tab except Files is a contribute/forge surface — marked build-only so
  // Read mode (#131) can hide it and foreground the knowledge base.
  const buildOnly = id === "files" ? emptyHtml : html` data-build-only`;
  return html`<a class="${opts.active === id ? "active" : ""}"${buildOnly} href="${repoHref(opts.owner, opts.repo, suffix)}">${label}</a>`;
}

export function userPreferencesSection(user: string): Html {
  return html`<section class="settings-section" data-testid="settings-user-preferences">
    <div class="settings-section-header">
      <h2>User preferences</h2>
      <p>These settings follow your browser session and apply across workspaces.</p>
    </div>
    <div class="settings-form">
      <label class="settings-row">
        <span>Document theme</span>
        <select data-testid="settings-document-theme-select" data-document-theme-user="${user}">
          <option value="default">Default</option>
          <option value="blueprint-book">Blueprint Book</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Changed files default view</span>
        <span class="settings-inline-controls">
          <select data-testid="settings-diff-mode-select" data-diff-mode-user="${user}">
            <option value="source">Source</option>
            <option value="rich">Rich</option>
          </select>
          <select data-testid="settings-diff-shape-select" data-diff-shape-user="${user}">
            <option value="unified">Unified</option>
            <option value="split">Side-by-side</option>
            <option value="after">After only</option>
          </select>
        </span>
      </label>
      <label class="settings-row">
        <span>Date format</span>
        <select data-testid="settings-time-format-select" data-cosheaf-time-user="${user}">
          <option value="relative">Relative</option>
          <option value="absolute">Absolute</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Default mode</span>
        <select data-testid="settings-landing-mode-select" data-landing-mode-user="${user}">
          <option value="last">Last used</option>
          <option value="read">Read</option>
          <option value="build">Build</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Default editor mode</span>
        <select data-testid="settings-editor-mode-select" data-editor-mode-user="${user}">
          <option value="rich">Rich</option>
          <option value="source">Source</option>
        </select>
      </label>
    </div>
  </section>`;
}

// Profile editor backed by Forgejo's /user/settings. Username and email are
// shown read-only (identity is owned by the forge); the editable fields are
// the same ones Forgejo exposes on a user profile. `saved` toggles the
// post-submit confirmation; `error` surfaces a failed save.
export function userProfileSection(me: ForgejoUser, opts: { saved?: boolean; error?: string } = {}): Html {
  return html`<section class="settings-section" data-testid="settings-user-profile">
    <div class="settings-section-header">
      <h2>Profile</h2>
      <p>Your public profile on Cosheaf. Stored on the forge under your account.</p>
    </div>
    <form class="settings-form" method="post" action="/account/settings" data-testid="profile-form">
      <label class="settings-row">
        <span>Username</span>
        <input value="${me.login}" readonly disabled>
      </label>
      <label class="settings-row">
        <span>Email</span>
        <input value="${me.email ?? ""}" readonly disabled>
      </label>
      <label class="settings-row">
        <span>Display name</span>
        <input name="full_name" value="${me.full_name ?? ""}" data-testid="profile-full-name" placeholder="Optional">
      </label>
      <label class="settings-row">
        <span>Bio</span>
        <textarea name="description" data-testid="profile-description" rows="3" placeholder="Optional">${me.description ?? ""}</textarea>
      </label>
      <label class="settings-row">
        <span>Website</span>
        <input name="website" value="${me.website ?? ""}" data-testid="profile-website" placeholder="https://">
      </label>
      <label class="settings-row">
        <span>Location</span>
        <input name="location" value="${me.location ?? ""}" data-testid="profile-location" placeholder="Optional">
      </label>
      <div class="settings-actions">
        <button class="button primary" type="submit" data-testid="profile-submit">Save profile</button>
        ${opts.saved ? html`<p class="muted" data-testid="profile-saved">Saved.</p>` : emptyHtml}
        ${opts.error ? html`<p class="muted" data-testid="profile-error">${opts.error}</p>` : emptyHtml}
      </div>
    </form>
  </section>`;
}

// Inline open · closed · all text toggles. Submit buttons (not links) so the
// rest of the filter form — search, sort, advanced — rides along automatically
// and nothing is lost when switching state.
export function stateToggle(value: WebListState): Html {
  const opt = (s: WebListState, label: string) =>
    html`<button type="submit" name="state" value="${s}" class="state-toggle ${value === s ? "active" : ""}">${label}</button>`;
  return html`<span class="state-toggles" aria-label="State filter">${opt("open", "open")} · ${opt("closed", "closed")} · ${opt("all", "all")}</span>`;
}

export function sortField<T extends string>(value: T | "", options: Array<{ value: T; label: string }>): Html {
  return html`<label>Sort
    <select name="sort" aria-label="Sort filter">
      <option value="">Default</option>
      ${options.map((option) => html`<option value="${option.value}"${selected(value, option.value)}>${option.label}</option>`)}
    </select>
  </label>`;
}

export function selected(current: string, value: string): Html {
  return current === value ? html` selected` : emptyHtml;
}

export function labelChips(labels: readonly ForgejoLabel[]): Html {
  if (labels.length === 0) return emptyHtml;
  return html`<span class="label-chips">${labels.map(labelChip)}</span>`;
}

export function labelChip(label: ForgejoLabel): Html {
  const color = safeLabelColor(label.color);
  return html`<span class="label-chip" style="background-color:#${color}22;color:#${color}">${label.name}</span>`;
}

function safeLabelColor(value: string): string {
  const color = value.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(color) ? color : "71717a";
}

export function branchOptions(branches: readonly ForgejoBranch[], selectedBranch: string | null | undefined): Html {
  return joinHtml(
    branches.map((branch) => html`<option value="${branch.name}"${selected(selectedBranch ?? "", branch.name)}>${branch.name}</option>`),
  );
}
