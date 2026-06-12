import type { ForgejoBranch, ForgejoLabel } from "../forgejo-types.js";
import type { WorkspaceContext } from "../types.js";
import { repoHref, type WebListState } from "./web-context.js";
import { emptyHtml, html, type Html, joinHtml } from "./web-html.js";
import { pageShell } from "./web-shell.js";

const REPO_TABS = [
  ["files", "Files", ""],
  ["issues", "Issues", "/issues"],
  ["pulls", "Pull Requests", "/pulls"],
  ["chat", "Chat", "/chat"],
  ["notifications", "Notifications", "/notifications"],
  ["activity", "Activity", "/activity"],
  ["settings", "Settings", "/settings"],
] as const;

export function repoPage(opts: {
  title: string;
  owner: string;
  repo: string;
  active: "files" | "issues" | "pulls" | "chat" | "notifications" | "activity" | "settings";
  user: string;
  ws: WorkspaceContext;
  body: Html;
  readerAssets?: boolean;
}): string {
  const nav = REPO_TABS.map(([id, label, suffix]) => tab(opts, id, label, suffix));
  const activeLabel = REPO_TABS.find(([id]) => id === opts.active)?.[1] ?? opts.active;
  return pageShell({
    title: opts.title,
    user: opts.user,
    readerAssets: opts.readerAssets,
    sidebar: html`
      <a class="brand" href="/">Cosheaf</a>
      <div class="sidebar-workspace">
        <a href="${repoHref(opts.owner, opts.repo)}">${opts.repo}</a>
        <span class="role">${opts.ws.role}</span>
      </div>
      <nav class="repo-tabs">${nav}</nav>`,
    statusPath: [
      { label: opts.repo, href: repoHref(opts.owner, opts.repo) },
      { label: activeLabel.toLowerCase() },
    ],
    body: html`
      <main class="repo-page">
        <section class="repo-body">${opts.body}</section>
      </main>
    `,
  });
}

function tab(
  opts: { owner: string; repo: string; active: string },
  id: string,
  label: string,
  suffix: string,
): Html {
  return html`<a class="${opts.active === id ? "active" : ""}" href="${repoHref(opts.owner, opts.repo, suffix)}">${label}</a>`;
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
    </div>
  </section>`;
}

export function userPreferencesScript(): Html {
  return html`<script src="/cosheaf-preferences.js" defer></script>`;
}

export function stateField(value: WebListState): Html {
  return html`<label>State
    <select name="state" aria-label="State filter">
      <option value="open"${selected(value, "open")}>Open</option>
      <option value="closed"${selected(value, "closed")}>Closed</option>
      <option value="all"${selected(value, "all")}>All states</option>
    </select>
  </label>`;
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
