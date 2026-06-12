import type { ForgejoBranch, ForgejoLabel } from "../forgejo-types.js";
import type { WorkspaceContext } from "../types.js";
import { escapeAttr, escapeHtml } from "./html-escape.js";
import { repoHref, type WebListState } from "./web-context.js";
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
  body: string;
  readerAssets?: boolean;
}): string {
  const nav = REPO_TABS.map(([id, label, suffix]) => tab(opts, id, label, suffix)).join("\n");
  const activeLabel = REPO_TABS.find(([id]) => id === opts.active)?.[1] ?? opts.active;
  return pageShell({
    title: opts.title,
    user: opts.user,
    readerAssets: opts.readerAssets,
    sidebar: `
      <a class="brand" href="/">Cosheaf</a>
      <div class="sidebar-workspace">
        <a href="${repoHref(opts.owner, opts.repo)}">${escapeHtml(opts.repo)}</a>
        <span class="role">${escapeHtml(opts.ws.role)}</span>
      </div>
      <nav class="repo-tabs">${nav}</nav>`,
    statusPath: [
      { label: opts.repo, href: repoHref(opts.owner, opts.repo) },
      { label: activeLabel.toLowerCase() },
    ],
    body: `
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
): string {
  return `<a class="${opts.active === id ? "active" : ""}" href="${repoHref(opts.owner, opts.repo, suffix)}">${label}</a>`;
}

export function userPreferencesSection(user: string): string {
  return `<section class="settings-section" data-testid="settings-user-preferences">
    <div class="settings-section-header">
      <h2>User preferences</h2>
      <p>These settings follow your browser session and apply across workspaces.</p>
    </div>
    <div class="settings-form">
      <label class="settings-row">
        <span>Document theme</span>
        <select data-testid="settings-document-theme-select" data-document-theme-user="${escapeAttr(user)}">
          <option value="default">Default</option>
          <option value="blueprint-book">Blueprint Book</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Changed files default view</span>
        <span class="settings-inline-controls">
          <select data-testid="settings-diff-mode-select" data-diff-mode-user="${escapeAttr(user)}">
            <option value="source">Source</option>
            <option value="rich">Rich</option>
          </select>
          <select data-testid="settings-diff-shape-select" data-diff-shape-user="${escapeAttr(user)}">
            <option value="unified">Unified</option>
            <option value="split">Side-by-side</option>
            <option value="after">After only</option>
          </select>
        </span>
      </label>
    </div>
  </section>`;
}

export function userPreferencesScript(): string {
  return `<script src="/cosheaf-preferences.js" defer></script>`;
}

export function stateField(value: WebListState): string {
  return `<label>State
    <select name="state" aria-label="State filter">
      <option value="open"${selected(value, "open")}>Open</option>
      <option value="closed"${selected(value, "closed")}>Closed</option>
      <option value="all"${selected(value, "all")}>All states</option>
    </select>
  </label>`;
}

export function sortField<T extends string>(value: T | "", options: Array<{ value: T; label: string }>): string {
  return `<label>Sort
    <select name="sort" aria-label="Sort filter">
      <option value="">Default</option>
      ${options.map((option) => `<option value="${option.value}"${selected(value, option.value)}>${escapeHtml(option.label)}</option>`).join("")}
    </select>
  </label>`;
}

export function selected(current: string, value: string): string {
  return current === value ? " selected" : "";
}

export function labelChips(labels: readonly ForgejoLabel[]): string {
  if (labels.length === 0) return "";
  return `<span class="label-chips">${labels.map(labelChip).join("")}</span>`;
}

export function labelChip(label: ForgejoLabel): string {
  const color = safeLabelColor(label.color);
  return `<span class="label-chip" style="background-color:#${color}22;color:#${color}">${escapeHtml(label.name)}</span>`;
}

function safeLabelColor(value: string): string {
  const color = value.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(color) ? color : "71717a";
}

export function branchOptions(branches: readonly ForgejoBranch[], selectedBranch: string | null | undefined): string {
  return branches
    .map((branch) => `<option value="${escapeAttr(branch.name)}"${selected(selectedBranch ?? "", branch.name)}>${escapeHtml(branch.name)}</option>`)
    .join("");
}
