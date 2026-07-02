import type { BranchRow } from "../../shared/branches.js";
import type { LocaleId, MessageKey, T } from "../../shared/i18n/index.js";
import type { ForgejoLabel, ForgejoUser } from "../forgejo-types.js";
import type { WorkspaceContext } from "../types.js";
import { backIcon } from "./icons.js";
import { repoHref, type WebCtx, type WebListState } from "./web-context.js";
import { emptyHtml, type Html, html, joinHtml, raw } from "./web-html.js";
import { pageShell, type StatusCrumb, sidebarIdentity } from "./web-shell.js";

export type RepoTab = "files" | "issues" | "pulls" | "chat" | "notifications" | "activity" | "diagnostics" | "settings" | "commit";

// A small "+ <label>" disclosure that keeps a durable add/create form closed by
// default behind a native <details>, so a panel/section reads cleanly when
// you're just looking. The summary is the only always-visible affordance
// (keyboard-focusable + labelled); opening it reveals the form unchanged. Used
// for settings create-forms, issue dependencies, PR reviewer requests, and rail
// label editing.
export function addDisclosure(label: string, form: Html): Html {
  // Always a write affordance (settings create-forms, issue dependencies, PR
  // reviewer requests, rail label/assignee editing).
  return html`<details class="add-disclosure">
    <summary>+ ${label}</summary>
    ${form}
  </details>`;
}

// Shared <datalist> id used by on-demand username autocomplete fields.
export const USERNAME_DATALIST_ID = "repo-usernames";

// [id, message key, url suffix]. Labels resolve through t() at render time so
// the repo nav translates without REPO_TABS holding pre-baked English.
const REPO_TABS = [
  ["files", "tab.files", ""],
  ["issues", "tab.issues", "/issues"],
  ["pulls", "tab.pulls", "/pulls"],
  ["notifications", "nav.notifications", "/notifications"],
  ["activity", "tab.activity", "/activity"],
  ["diagnostics", "tab.diagnostics", "/diagnostics"],
  ["settings", "settings.title", "/settings"],
] as const satisfies ReadonlyArray<readonly [string, MessageKey, string]>;

// Prefill repoPage's owner/repo/user/ws from a resolved WebCtx; handlers pass
// only what actually varies (active tab, title, body, and optional reader
// assets) instead of repeating the ctx spread at every call site.
export function repoPageShell(
  ctx: WebCtx,
  active: RepoTab,
  title: string,
  body: Html,
  opts: { readerAssets?: boolean; sidebarPanels?: readonly Html[]; statusExtra?: readonly StatusCrumb[]; statusOmitTab?: boolean } = {},
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
    statusOmitTab: opts.statusOmitTab,
    userAvatarSrc: ctx.userAvatarSrc,
    // Local Workbench (direct write-mode): render the local repo nav. Shared
    // collaboration tabs are mounted behind the connected-server gate.
    local: ctx.local,
    locale: ctx.locale,
    t: ctx.t,
  });
}

export function repoPage(opts: {
  title: string;
  owner: string;
  repo: string;
  active: RepoTab;
  user: string;
  ws: WorkspaceContext;
  // Workspace title (Forgejo repo description); "" falls back to the owner/repo slug.
  wsTitle: string;
  body: Html;
  readerAssets?: boolean;
  // Optional content rendered into the left-sidebar region under the repo tabs.
  sidebarPanels?: readonly Html[];
  // Extra status-bar breadcrumb segments appended after owner/repo/tab — the
  // edit page uses this to show the branch being edited (#126).
  statusExtra?: readonly StatusCrumb[];
  // Drop the active-tab crumb from the breadcrumb. The edit page sets this so
  // the trail reads owner / repo / branch / <filename> instead of carrying a
  // pointless "files" segment (#164).
  statusOmitTab?: boolean;
  // The signed-in user's same-origin avatar src for the sidebar identity (#177).
  userAvatarSrc?: string | null;
  // Local Workbench: render the local nav and avoid linking to hosted-only
  // owner/profile pages.
  local?: boolean;
  locale: LocaleId;
  t: T;
}): string {
  const t = opts.t;
  const nav = opts.local
    ? [
        // Local Workbench: files + the local-only Commit surface, then the shared
        // collaboration tabs the local app mounts against the connected server
        // (or a Connect prompt when none is connected).
        tab(opts, "files", t("tab.files"), ""),
        tab(opts, "commit", "Commit", "/commit"),
        tab(opts, "issues", t("tab.issues"), "/issues"),
        tab(opts, "pulls", t("tab.pulls"), "/pulls"),
        tab(opts, "notifications", t("nav.notifications"), "/notifications"),
        tab(opts, "activity", t("tab.activity"), "/activity"),
        tab(opts, "diagnostics", t("tab.diagnostics"), "/diagnostics"),
        tab(opts, "settings", t("settings.title"), "/settings"),
      ]
    : REPO_TABS.map(([id, key, suffix]) => tab(opts, id, t(key), suffix));
  const activeKey = REPO_TABS.find(([id]) => id === opts.active)?.[1];
  const activeLabel = activeKey ? t(activeKey) : opts.active;
  return pageShell({
    title: opts.title,
    user: opts.user,
    locale: opts.locale,
    readerAssets: opts.readerAssets,
    sidebar: html`
      ${sidebarIdentity(opts.user, false, opts.userAvatarSrc ?? null, t, false, false, { local: opts.local })}
      <nav class="sidebar-topnav">
        <a href="/">${backIcon({ size: 14 })} ${t("nav.workspaces")}</a>
      </nav>
      <div class="sidebar-workspace">
        <a href="${repoHref(opts.owner, opts.repo)}">${workspaceChipIdent(opts.owner, opts.repo, opts.wsTitle)}</a>
        <span class="role">${opts.ws.role}</span>
      </div>
      <nav class="repo-tabs">${nav}</nav>
      ${opts.sidebarPanels?.length ? joinHtml(opts.sidebarPanels) : emptyHtml}`,
    statusPath: [
      { label: opts.owner, href: opts.local ? repoHref(opts.owner, opts.repo) : `/users/${encodeURIComponent(opts.owner)}`, cls: opts.wsTitle ? "status-owner" : undefined },
      { label: opts.repo, href: repoHref(opts.owner, opts.repo), wsTitle: opts.wsTitle || undefined },
      ...(opts.statusOmitTab ? [] : [{ label: activeLabel.toLowerCase() }]),
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
// the owner/repo slug; current chrome keeps the slug primary.
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
  return html`<a class="${opts.active === id ? "active" : ""}" href="${repoHref(opts.owner, opts.repo, suffix)}">${label}</a>`;
}

export function userPreferencesSection(user: string, locale: LocaleId, t: T): Html {
  // Language is server-driven (the chosen option is `selected` from the resolved
  // locale) because the server needs it at render time; cosheaf-preferences.js
  // writes the cosheaf_lang cookie + reloads on change. The other selects stay
  // client-only (localStorage), so only their display text is translated — their
  // option values are unchanged.
  const langSelected = (id: LocaleId): Html => (locale === id ? raw(" selected") : emptyHtml);
  // Grouped into Appearance / Documents / Editing as peer sections (matching the
  // Profile/Avatar/SSH/Session sections on the page). Every preference here is
  // client-only (localStorage or the lang cookie), so each group repeats the
  // "this browser only" hint so the contrast with account-backed sections is clear.
  const group = (titleKey: MessageKey, testId: string, rows: Html): Html => html`
    <section class="settings-section" data-testid="${testId}">
      <div class="settings-section-header">
        <h2>${t(titleKey)}</h2>
        <p>${t("prefs.group.browser_only")}</p>
      </div>
      <div class="settings-form">${rows}</div>
    </section>`;
  return html`
    ${group("prefs.group.appearance", "settings-user-preferences", html`
      <label class="settings-row">
        <span>${t("prefs.language")}</span>
        <select data-testid="settings-language-select" data-lang-select>
          <option value="en"${langSelected("en")}>English</option>
          <option value="zh"${langSelected("zh")}>中文</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.color_scheme")}</span>
        <select data-testid="settings-color-scheme-select" data-color-scheme-user="${user}">
          <option value="light">${t("prefs.opt.light")}</option>
          <option value="dark">${t("prefs.opt.dark")}</option>
          <option value="system">${t("prefs.opt.system")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.density")}</span>
        <select data-testid="settings-density-select" data-density-user="${user}">
          <option value="compact">${t("prefs.opt.compact")}</option>
          <option value="normal">${t("prefs.opt.normal")}</option>
          <option value="comfortable">${t("prefs.opt.comfortable")}</option>
          <option value="large">${t("prefs.opt.large")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.reading_width")}</span>
        <select data-testid="settings-reading-width-select" data-reading-width-user="${user}">
          <option value="narrow">${t("prefs.opt.narrow")}</option>
          <option value="normal">${t("prefs.opt.normal")}</option>
          <option value="wide">${t("prefs.opt.wide")}</option>
        </select>
      </label>`)}
    ${group("prefs.group.documents", "settings-doc-preferences", html`
      <label class="settings-row">
        <span>${t("prefs.section_numbering")}</span>
        <input type="checkbox" role="switch" class="settings-switch" data-testid="settings-section-numbering-toggle" data-section-numbering-user="${user}">
      </label>
      <label class="settings-row">
        <span>${t("prefs.file_labels")}</span>
        <select data-testid="settings-file-labels-select" data-file-labels-user="${user}">
          <option value="filename">${t("prefs.opt.filenames")}</option>
          <option value="title">${t("prefs.opt.markdown_titles")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.document_theme")}</span>
        <select data-testid="settings-document-theme-select" data-document-theme-user="${user}">
          <option value="default">${t("prefs.opt.theme_default")}</option>
          <option value="blueprint-book">Blueprint Book</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.date_format")}</span>
        <select data-testid="settings-time-format-select" data-cosheaf-time-user="${user}">
          <option value="relative">${t("prefs.opt.relative")}</option>
          <option value="absolute">${t("prefs.opt.absolute")}</option>
        </select>
      </label>`)}
    ${group("prefs.group.editing", "settings-editing-preferences", html`
      <label class="settings-row">
        <span>${t("prefs.open_files")}</span>
        <select data-testid="settings-file-open-mode-select" data-file-open-mode-user="${user}">
          <option value="edit">${t("prefs.opt.edit")}</option>
          <option value="read">${t("prefs.opt.read")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.default_editor_mode")}</span>
        <select data-testid="settings-editor-mode-select" data-editor-mode-user="${user}">
          <option value="rich">${t("prefs.opt.rich")}</option>
          <option value="source">${t("prefs.opt.source")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.autosave")}</span>
        <select data-testid="settings-autosave-select" data-autosave-user="${user}">
          <option value="off">${t("common.off")}</option>
          <option value="1000">${t("prefs.opt.every_1s")}</option>
          <option value="1500">${t("prefs.opt.every_1_5s")}</option>
          <option value="3000">${t("prefs.opt.every_3s")}</option>
          <option value="5000">${t("prefs.opt.every_5s")}</option>
        </select>
      </label>
      <label class="settings-row">
        <span>${t("prefs.diff_default_view")}</span>
        <span class="settings-inline-controls">
          <select data-testid="settings-diff-mode-select" data-diff-mode-user="${user}">
            <option value="source">${t("prefs.opt.source")}</option>
            <option value="rich">${t("prefs.opt.rich")}</option>
          </select>
          <select data-testid="settings-diff-shape-select" data-diff-shape-user="${user}">
            <option value="unified">${t("prefs.opt.unified")}</option>
            <option value="split">${t("prefs.opt.split")}</option>
            <option value="after">${t("prefs.opt.after")}</option>
          </select>
        </span>
      </label>`)}`;
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

// The shared issue/pull filter panel shell: the compact form with the state
// toggle, title search, sort field, apply/reset, and an advanced-filters
// <details> whose grid contents differ per list (labels/milestone/user fields).
// Callers pass the pre-rendered stateToggle + sort and their advanced fields.
export function filterPanel(opts: {
  action: string;
  testId: string;
  listPrefs: string;
  q: string;
  searchAriaLabel: string;
  stateToggle: Html;
  sort: Html;
  advancedFields: Html;
}): Html {
  return html`<form class="filter-panel filter-panel--compact" method="get" action="${opts.action}" data-testid="${opts.testId}" data-list-prefs="${opts.listPrefs}">
    <datalist id="${USERNAME_DATALIST_ID}"></datalist>
    <div class="filter-basic">
      ${opts.stateToggle}
      <label class="filter-search">Search <input name="q" value="${opts.q}" placeholder="title text" aria-label="${opts.searchAriaLabel}"></label>
      ${opts.sort}
      <div class="filter-actions">
        <button class="link-button" type="submit">apply</button>
        <a class="link-button" href="${opts.action}">reset</a>
      </div>
    </div>
    <details class="filter-advanced">
      <summary>Advanced filters</summary>
      <div class="filter-advanced-grid">
        ${opts.advancedFields}
      </div>
    </details>
  </form>`;
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

export function branchOptions(branches: readonly BranchRow[], selectedBranch: string | null | undefined): Html {
  return joinHtml(
    branches.map((branch) => html`<option value="${branch.name}"${selected(selectedBranch ?? "", branch.name)}>${branch.name}</option>`),
  );
}
