import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { type PageSearchResult, type SnippetPart, workspacePageExcerpts } from "../page-search.js";
import type { WebCtx } from "./web-context.js";
import { repoHref, timeEl } from "./web-context.js";
import { defaultFileLinkAttrs } from "./web-file-links.js";
import { markdownArticle } from "./web-file-preview.js";
import { emptyHtml, html, type Html } from "./web-html.js";

export function pageSearchForm(owner: string, repo: string): Html {
  return html`<form class="page-search" method="get" action="${repoHref(owner, repo, "/search")}">
    <input name="q" placeholder="Search pages" aria-label="Search pages" data-testid="page-search-box">
  </form>`;
}

export function searchResultRow(ctx: WebCtx, r: PageSearchResult): Html {
  return html`<a class="list-row search-result" ${defaultFileLinkAttrs(ctx.owner, ctx.repo, ctx.user, "main", r.path, ctx.ws.role !== "read")}>
    <span class="search-result-head"><strong>${r.title || r.path}</strong> <small class="muted">${r.path}</small></span>
    <span class="search-snippet">${renderSnippet(r.snippet)}</span>
  </a>`;
}

function renderSnippet(parts: readonly SnippetPart[]): Html {
  return html`${parts.map((p) => (p.match ? html`<mark>${p.text}</mark>` : p.text))}`;
}

// The repo-overview header: a clear "this is the repo, not a file" identity
// band + a few glanceable stats, shown above the README so the landing reads as
// an overview rather than just another rendered file.
export interface RepoHomeStats {
  pages: number;
  branches: number;
  openIssues: number;
  updated?: string;
  description?: string;
}

export function repoHomeHeader(ctx: WebCtx, owner: string, repo: string, stats: RepoHomeStats): Html {
  const stat = (value: Html | string | number, label: string, href?: string) => {
    const inner = html`<span class="repo-stat-num">${value}</span><span class="repo-stat-label">${label}</span>`;
    return href ? html`<a class="repo-stat" href="${href}">${inner}</a>` : html`<div class="repo-stat">${inner}</div>`;
  };
  const format = ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID ? "Coflat" : "Markdown";
  return html`<header class="repo-home" data-testid="repo-home-header">
    <div class="repo-home-id">
      <h1 class="repo-home-name">${repo}</h1>
      <span class="repo-home-owner">${owner}</span>
      <span class="repo-home-badge">${format}</span>
    </div>
    ${stats.description ? html`<p class="repo-home-desc">${stats.description}</p>` : ""}
    <div class="repo-home-stats">
      ${stat(stats.pages, stats.pages === 1 ? "page" : "pages")}
      ${stat(stats.branches, stats.branches === 1 ? "branch" : "branches", repoHref(owner, repo, "/branches"))}
      ${stat(stats.openIssues, "open issues", repoHref(owner, repo, "/issues"))}
      ${stats.updated ? html`<div class="repo-stat"><span class="repo-stat-num">${timeEl(stats.updated)}</span><span class="repo-stat-label">updated</span></div>` : ""}
    </div>
  </header>`;
}

export function repoLanding(
  ctx: WebCtx,
  branch: string,
  files: readonly ForgejoTreeEntry[],
  titles: Map<string, string>,
  readme: { path: string; rendered: Html } | null,
): Html {
  // Label the README so it's clear the overview is showing README.md (not the
  // whole repo or an arbitrary file); the rendered README follows below it.
  if (readme)
    return html`<section class="repo-readme" data-testid="repo-readme">
      <div class="repo-readme-label">${readme.path}</div>
      ${markdownArticle(ctx, readme.rendered, "files-readme")}
    </section>`;
  return pageIndex(ctx, branch, files, titles);
}

// Reading-oriented page index for the /files landing when there is no README:
// the workspace's markdown pages as title-first reading entries with a one-line
// body excerpt (#136). Distinct from the nav tree by scope (pages only, not
// every file) and form (titles + descriptions, not a compact file list).
function pageIndex(ctx: WebCtx, branch: string, files: readonly ForgejoTreeEntry[], titles: Map<string, string>): Html {
  const pages = files.filter((file) => fileKindForPath(file.path) === "markdown");
  if (pages.length === 0) return html`<div class="list"><div class="empty">No pages yet.</div></div>`;
  // Titles + excerpts come from the sidecar, which only indexes main.
  const excerpts = branch === "main" ? workspacePageExcerpts(ctx.db, ctx.ws.slug) : new Map<string, string>();
  return html`<div class="files-landing" data-testid="files-page-index">
    <p class="files-landing-hint muted">Pages in this workspace. The file tree (left) navigates every file.</p>
    <div class="list">${pages.map((file) => {
      const title = titles.get(file.path) || file.path;
      const excerpt = excerpts.get(file.path);
      return html`<a class="list-row page-row" ${defaultFileLinkAttrs(ctx.owner, ctx.repo, ctx.user, branch, file.path, ctx.ws.role !== "read")}>
          <span class="list-row-main"><strong>${title}</strong>${excerpt ? html`<span class="page-row-excerpt">${excerpt}</span>` : emptyHtml}<small>${file.path}</small></span>
        </a>`;
    })}</div>
  </div>`;
}
