import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { type FileKind, fileKindForPath, fileKindLabel } from "../../shared/file-kind.js";
import { resolveBranchPath } from "../branch-path.js";
import { repositoryRawHeadersForPath } from "../content-type.js";
import { type Forgejo, ForgejoError } from "../forgejo.js";
import { is404, onForgejo404 } from "../forgejo-errors.js";
import type { ForgejoBranch, ForgejoTreeEntry } from "../forgejo-types.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { type PageSearchResult, type SnippetPart, searchWorkspacePages } from "../page-search.js";
import { invalidateBranchTree, invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { isStaleShaConflict, safeRel } from "./files.js";
import {
  badRequestPage,
  displayLogin,
  forbiddenPage,
  timeEl,
  htmlResponse,
  jsonScript,
  notFoundPage,
  redirect,
  repoHref,
  requestOrigin,
  stringField,
  textField,
  urlPath,
  validBranchName,
  webRoute,
  webRouteForWrite,
  type WebCtx,
} from "./web-context.js";
import { emptyHtml, html, type Html } from "./web-html.js";
import { type Panel, panel } from "./web-panels.js";
import { markdownSurface, renderMarkdown } from "./web-markdown.js";
import { branchOptions, repoPageShell } from "./web-page.js";
import { webEditorAssets } from "./web-shell.js";

export function registerFileRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo", webRoute(async (c, ctx) => {
  const { owner, repo, fj, ws, user } = ctx;
  const files = await repoFiles(fj, owner, repo, "main").catch(() => []);
  const cloneUrl = `${requestOrigin(c)}/${owner}/${repo}.git`;
  return htmlResponse(
    repoPageShell(ctx, "files", `Files - ${repo}`, html`
        <div class="page-title compact">
          <div><p class="eyebrow">Branch</p><h1>main</h1></div>
          <div class="toolbar-actions">
            ${pageSearchForm(owner, repo)}
            ${cloneBox(cloneUrl)}
            <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
            ${
              ws.role === "read"
                ? ""
                : html`<a class="button" href="${`${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, "main"))}`}">New file</a>`
            }
          </div>
        </div>
        ${fileList(owner, repo, "main", files)}
      `, { sidebarPanels: [fileTreePanel(owner, repo, "main", files, null)] }),
  );
}));

// Git clone affordance. The URL points at cosheaf's own origin; the proxy in
// routes/git-proxy.ts authenticates with the user's cosheaf PAT (used as the
// git password) and forwards to Forgejo, so the backing forge is never shown.
function cloneBox(cloneUrl: string): Html {
  return html`<details class="clone-box">
    <summary class="button">Clone</summary>
    <div class="clone-popover">
      <p class="clone-hint">Clone over HTTPS with your Cosheaf token as the password:</p>
      <div class="clone-row">
        <input class="clone-url" readonly value="${cloneUrl}" aria-label="Clone URL" onclick="this.select()">
        <button class="button" type="button" onclick="navigator.clipboard?.writeText(this.previousElementSibling.value)">Copy</button>
      </div>
    </div>
  </details>`;
}

// Full-text page search over the workspace's indexed pages (the SQLite FTS
// sidecar) — the knowledge-base capability a plain forge doesn't have. Reads
// the sidecar directly; only indexed pages on `main` are searchable.
web.get("/:owner/:repo/search", webRoute(async (c, ctx) => {
  const q = (c.req.query("q") ?? "").trim();
  const results = q ? searchWorkspacePages(ctx.db, ctx.ws.slug, q) : [];
  return htmlResponse(
    repoPageShell(ctx, "files", `Search - ${ctx.repo}`, html`
        <div class="page-title compact">
          <div><h1>Search</h1></div>
        </div>
        <form class="page-search page-search--full" method="get" action="${repoHref(ctx.owner, ctx.repo, "/search")}">
          <input name="q" value="${q}" placeholder="Search page titles and text" aria-label="Search pages" data-testid="page-search-input" autofocus>
          <button class="button primary" type="submit">Search</button>
        </form>
        ${
          q === ""
            ? html`<div class="empty">Enter a query to search this workspace's pages.</div>`
            : results.length === 0
              ? html`<div class="empty" data-testid="page-search-empty">No pages match "${q}".</div>`
              : html`<div class="list" data-testid="page-search-results">${results.map((r) => searchResultRow(ctx, r))}</div>`
        }
      `),
  );
}));

web.get("/:owner/:repo/src/branch/*", webRoute(async (c, ctx) => {
  const { owner, repo, fj, ws, user } = ctx;
  const resolved = await resolveBranchPath(fj, owner, repo, routeRest(c, owner, repo, "/src/branch/"));
  if (!resolved) return notFoundPage(user, "Branch not found");
  const files = await repoFiles(fj, owner, repo, resolved.branch);
  if (!resolved.path) {
    return htmlResponse(
      repoPageShell(ctx, "files", `${repo}: ${resolved.branch}`, html`
          <div class="page-title compact">
            <div><p class="eyebrow">Branch</p><h1>${resolved.branch}</h1></div>
            <div class="toolbar-actions">
              <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
              ${
                ws.role === "read"
                  ? ""
                  : html`${resolved.branch === "main" ? "" : html`<a class="button primary" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main`}">Open pull request</a>`}
                    <a class="button" href="${`${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}`}">New file</a>`
              }
            </div>
          </div>
          ${fileList(owner, repo, resolved.branch, files)}
        `, { sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, null)] }),
    );
  }
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(user, "File not found");
  const meta = await fj.getFileMeta(owner, repo, resolved.branch, rel).catch(onForgejo404(null));
  if (!meta) return notFoundPage(user, "File not found");
  const kind = fileKindForPath(rel);
  const sourceView = c.req.query("view") === "source";
  const content = kind === "markdown" || (kind === "text" && sourceView) ? await fj.getRawFile(owner, repo, resolved.branch, rel) : null;
  const rendered =
    kind === "markdown" && content !== null && !sourceView
      ? await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel })
      : null;
  const fileHref = `${repoHref(owner, repo, "/src/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}`;
  // Coflat-rendered markdown gets a sticky table-of-contents rail (filled by the
  // reader island from the document's headings). Only the coflat reader island
  // runs, so the rail is gated on the coflat format. The nav stays hidden for
  // docs with too few headings; the `:has(>.doc-toc[hidden])` CSS then collapses
  // the grid to a single full-width column (no reserved track or gutter).
  const preview = filePreview(ctx, resolved.branch, rel, kind, { rendered, source: content, sourceView });
  const docBody =
    kind === "markdown" && !sourceView && rendered !== null && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID
      ? html`<div class="doc-with-toc">
          <div class="doc-main">${preview}</div>
          <nav class="doc-toc" data-reader-toc aria-label="On this page" hidden></nav>
        </div>`
      : preview;
  return htmlResponse(
    repoPageShell(ctx, "files", `${rel} - ${repo}`, html`
        <div class="file-toolbar">
          <div>
            <p class="eyebrow">${resolved.branch}</p>
            <h1>${rel}</h1>
            <p class="file-meta">${fileKindLabel(kind)} <span>${formatBytes(meta.size)}</span></p>
          </div>
          <div class="toolbar-actions">
            <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
            <a class="button" href="${`${repoHref(owner, repo, "/raw/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}`}">Raw</a>
            ${
              kind === "markdown"
                ? sourceView
                  ? html`<a class="button" href="${fileHref}">Rendered</a>`
                  : html`<a class="button" href="${`${fileHref}?view=source`}">Source</a>`
                : ""
            }
            ${
              ws.role === "read" || resolved.branch === "main"
                ? ""
                : html`<a class="button" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main`}">Open pull request</a>`
            }
            ${
              ws.role === "read"
                ? ""
                : editableFileKind(kind)
                  ? html`<a class="button primary" href="${`${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}&path=${encodeURIComponent(rel)}`}">${kind === "markdown" ? "Edit" : "Edit text"}</a>`
                  : ""
            }
            ${
              ws.role === "read" || resolved.branch === "main"
                ? ""
                : html`<form class="inline-form" method="post" action="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}`}">
                    <input type="hidden" name="action" value="delete">
                    <button class="button danger" type="submit" data-testid="file-delete">Delete</button>
                  </form>`
            }
          </div>
        </div>
        ${docBody}
      `, {
        readerAssets: kind === "markdown" && !sourceView && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
        sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, rel)],
      }),
  );
}));

web.post("/:owner/:repo/src/branch/*", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  if (stringField(form.action) !== "delete") return badRequestPage(ctx.user, "Unsupported file action.");
  const resolved = await resolveBranchPath(ctx.fj, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/src/branch/"));
  if (!resolved?.path) return notFoundPage(ctx.user, "File not found");
  if (resolved.branch === "main") return forbiddenPage(ctx.user);
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(ctx.user, "File not found");
  const meta = await ctx.fj.getFileMeta(ctx.owner, ctx.repo, resolved.branch, rel);
  if (!meta) return notFoundPage(ctx.user, "File not found");
  await ctx.fj.deleteFile(ctx.owner, ctx.repo, {
    branch: resolved.branch,
    path: rel,
    sha: meta.sha,
    message: `delete ${rel}`,
  });
  invalidateBranchTree(ctx.owner, ctx.repo, resolved.branch);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(resolved.branch)}`);
}));

web.get("/:owner/:repo/raw/branch/*", webRoute(async (c, ctx) => {
  const resolved = await resolveBranchPath(ctx.fj, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/raw/branch/"));
  if (!resolved?.path) return new Response("not found", { status: 404 });
  const rel = safeRel(resolved.path);
  if (!rel) return new Response("not found", { status: 404 });
  const content = await ctx.fj.getRawFileBytes(ctx.owner, ctx.repo, resolved.branch, rel);
  return new Response(content, { headers: repositoryRawHeadersForPath(rel, content) });
}));

web.get("/:owner/:repo/_edit", webRouteForWrite(async (c, ctx) => {
  const branch = editBranchFor(ctx.user, c.req.query("branch"));
  const rel = safeRel(c.req.query("path") || "new.md") ?? "new.md";
  const kind = fileKindForPath(rel);
  if (!editableFileKind(kind)) return badRequestPage(ctx.user, "This file type can be previewed or opened raw, but cannot be edited in Cosheaf.");
  const content = await ctx.fj.getRawFile(ctx.owner, ctx.repo, branch, rel).catch(async (err) => {
    if (is404(err)) {
      return ctx.fj.getRawFile(ctx.owner, ctx.repo, "main", rel).catch(() => "");
    }
    throw err;
  });
  const branchExists =
    branch === "main" ||
    (await ctx.fj.listBranches(ctx.owner, ctx.repo).catch(() => []))
      .some((candidate) => candidate.name === branch);
  // The edit branch is created lazily on first save, so for a brand-new edit
  // branch the tree (file list) and Cancel target come from main instead.
  const treeBranch = branchExists ? branch : "main";
  const files = await repoFiles(ctx.fj, ctx.owner, ctx.repo, treeBranch).catch(() => []);
  const cancelHref = `${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(treeBranch)}/${urlPath(rel)}`;
  // The titlebar is gone (#126): the file path + branch live in the status-bar
  // breadcrumb; rename + Cancel moved into the editor's bottom status bar. The
  // file tree mirrors the read page's sidebar so edit/read chrome match (#123).
  return htmlResponse(
    repoPageShell(ctx, "files", `Edit ${rel}`, kind === "markdown" ? html`
        <section class="edit-page">
          <div
            id="web-editor-root"
            data-owner="${ctx.owner}"
            data-repo="${ctx.repo}"
            data-path="${rel}"
            data-branch="${branch}"
            data-branch-exists="${branchExists ? "1" : "0"}"
            data-username="${ctx.user}"
            data-role="${ctx.ws.role}"
            data-format-id="${ctx.ws.defaultMdFormat}"
          ></div>
          <script id="web-editor-content" type="application/json">${jsonScript(content)}</script>
          ${webEditorAssets()}
          <noscript>
            <form method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
              <input type="hidden" name="old_path" value="${rel}">
              <label>Branch <input name="branch" value="${branch}" required></label>
              <label>Path <input name="path" value="${rel}" required></label>
              <textarea name="content" spellcheck="false">${content}</textarea>
              <div class="form-actions">
                <button class="button primary" type="submit">Save</button>
                <a class="button" href="${cancelHref}">Cancel</a>
              </div>
            </form>
          </noscript>
        </section>
      ` : textEditPage(ctx, branch, rel, content, treeBranch), {
        statusExtra: [{ label: branch }, { label: rel }],
        sidebarPanels: [fileTreePanel(ctx.owner, ctx.repo, treeBranch, files, rel)],
      }),
  );
}));

web.post("/:owner/:repo/_edit", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  const branch = editBranchFor(ctx.user, stringField(form.branch));
  const rel = safeRel(stringField(form.path) ?? undefined);
  const oldRel = safeRel(stringField(form.old_path) ?? undefined);
  const content = textField(form.content);
  if (!rel || content === null) return redirect(repoHref(ctx.owner, ctx.repo));
  await ensureBranch(ctx.fj, ctx.owner, ctx.repo, branch);
  const kind = fileKindForPath(rel);
  try {
    if (kind === "markdown") {
      await writeMarkdownFile(ctx, branch, rel, content, oldRel ?? undefined);
    } else if (kind === "text") {
      await writeTextFile(ctx, branch, rel, content, oldRel ?? undefined);
    } else {
      return badRequestPage(ctx.user, "Only Markdown and text files can be edited in Cosheaf.");
    }
  } catch (err) {
    // A concurrent save advanced the branch head between our read and write.
    // Surface a reload-and-retry message instead of a bare gateway error (#92).
    if (isStaleShaConflict(err)) {
      return badRequestPage(ctx.user, "This file changed on the branch while you were editing. Reload the page to get the latest version, then reapply your edit.");
    }
    throw err;
  }
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`);
}));
}

export function registerBranchRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/branches", webRoute(async (_c, ctx) => {
  const [branches, pulls] = await Promise.all([
    ctx.fj.listBranches(ctx.owner, ctx.repo),
    ctx.fj.listPulls(ctx.owner, ctx.repo, "open").catch(() => []),
  ]);
  const openHeads = new Set(pulls.map((pull) => pull.head.ref));
  return htmlResponse(
    repoPageShell(ctx, "files", `Branches - ${ctx.repo}`, html`
        <div class="page-title compact"><h1>Branches</h1></div>
        ${branchCreatePanel(ctx, branches)}
        ${branchList(ctx, branches, openHeads)}
      `),
  );
}));

web.post("/:owner/:repo/branches/new", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  const name = stringField(form.name);
  const base = stringField(form.base) ?? "main";
  if (!validBranchName(name) || name === "main") return badRequestPage(ctx.user, "Valid non-main branch name is required.");
  if (!validBranchName(base)) return badRequestPage(ctx.user, "Valid base branch is required.");
  try {
    await ctx.fj.createBranch(ctx.owner, ctx.repo, { newBranchName: name, oldBranchName: base });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409) {
      return badRequestPage(ctx.user, "Branch already exists.");
    }
    throw err;
  }
  invalidateRepoTrees(ctx.owner, ctx.repo);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(name)}`);
}));

web.post("/:owner/:repo/branches/delete", webRouteForWrite(async (c, ctx) => {
  const name = stringField((await c.req.parseBody()).name);
  if (!validBranchName(name) || name === "main") return badRequestPage(ctx.user, "Valid non-main branch name is required.");
  await deleteBranchQuietly(ctx.fj, ctx.owner, ctx.repo, name);
  invalidateRepoTrees(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, "/branches"));
}));

web.get("/:owner/:repo/commits/:sha", webRoute(async (c, ctx) => {
  const sha = c.req.param("sha");
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return notFoundPage(ctx.user, "Commit not found");
  const commit = await ctx.fj.getCommit(ctx.owner, ctx.repo, sha).catch(onForgejo404(null));
  if (!commit) return notFoundPage(ctx.user, "Commit not found");
  return htmlResponse(
    repoPageShell(ctx, "activity", `${commit.sha.slice(0, 10)} - ${ctx.repo}`, html`
        <div class="page-title compact">
          <div>
            <p class="eyebrow">Commit</p>
            <h1>${commit.sha.slice(0, 10)}</h1>
          </div>
        </div>
        <div class="commit-card">
          <pre>${commit.commit.message.trim() || "(no commit message)"}</pre>
          <p>${displayLogin(commit.commit.author?.name ?? commit.author?.login)} - ${timeEl(commit.commit.author?.date)}</p>
          <code>${commit.sha}</code>
        </div>
      `),
  );
}));
}

async function repoFiles(fj: Forgejo, owner: string, repo: string, ref: string) {
  const tree = await fj.getTree(owner, repo, ref, true);
  return tree
    .filter((entry) => entry.type === "blob")
    .sort((a, b) => a.path.localeCompare(b.path));
}

function editableFileKind(kind: FileKind): boolean {
  return kind === "markdown" || kind === "text";
}

function rawFileHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/raw/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

function filePreview(
  ctx: WebCtx,
  branch: string,
  rel: string,
  kind: FileKind,
  view: { rendered: Html | null; source: string | null; sourceView: boolean },
): Html {
  const rawHref = rawFileHref(ctx.owner, ctx.repo, branch, rel);
  if (view.sourceView && view.source !== null) return sourceFilePreview(view.source);
  if (kind === "markdown") {
    return html`<article class="document cosheaf-document-reader cf-theme-scope" data-testid="file-preview-markdown">
      ${markdownSurface(ctx, view.rendered ?? emptyHtml)}
    </article>`;
  }
  if (kind === "text") {
    return html`<article class="file-preview file-preview-embed" data-testid="file-preview-text">
      <object data-testid="file-preview-text-raw" data="${rawHref}" type="text/plain">
        <p>Text preview is not available in this browser. <a class="inline-link" href="${rawHref}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "pdf") {
    return html`<article class="file-preview file-preview-embed">
      <object data-testid="file-preview-pdf" data="${rawHref}" type="application/pdf">
        <p>PDF preview is not available in this browser. <a class="inline-link" href="${rawHref}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "image") {
    return html`<article class="file-preview file-preview-image">
      <img data-testid="file-preview-image" src="${rawHref}" alt="${rel}">
    </article>`;
  }
  return html`<article class="file-preview file-preview-fallback" data-testid="file-preview-raw">
    <p>No inline preview is available for this file type.</p>
    <a class="button" href="${rawHref}">Open raw file</a>
  </article>`;
}

function sourceFilePreview(content: string): Html {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return html`<article class="file-preview file-preview-source-lines" data-testid="file-preview-source">
    <table class="source-lines"><tbody>${lines.map((line, index) => {
      const lineNo = index + 1;
      return html`<tr id="L${lineNo}" data-testid="source-line-${lineNo}">
          <td class="line-action"></td>
          <td><a href="#L${lineNo}">${lineNo}</a></td>
          <td><pre>${line}</pre></td>
        </tr>`;
    })}</tbody></table>
    <script>
      (() => {
        const match = /^#L(\\d+)(?:-(?:L)?(\\d+))?$/.exec(window.location.hash);
        if (!match) return;
        const first = Number(match[1]);
        const last = Number(match[2] || match[1]);
        const start = Math.max(1, Math.min(first, last));
        const end = Math.max(first, last);
        for (let line = start; line <= end; line += 1) {
          document.getElementById("L" + line)?.classList.add("marked");
        }
        document.getElementById("L" + start)?.scrollIntoView({ block: "center" });
      })();
    </script>
  </article>`;
}

function textEditPage(ctx: WebCtx, branch: string, rel: string, content: string, cancelBranch: string): Html {
  return html`<section class="edit-page text-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><h1>${rel}</h1></div>
      <a class="button" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(cancelBranch)}/${urlPath(rel)}`}">Cancel</a>
    </div>
    <form class="compose-form" data-testid="text-edit-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
      <input type="hidden" name="old_path" value="${rel}">
      <label>Branch <input name="branch" value="${branch}" required></label>
      <label>Path <input name="path" value="${rel}" required></label>
      <textarea class="text-file-editor" name="content" spellcheck="false">${content}</textarea>
      <div class="form-actions">
        <button class="button primary" type="submit">Save</button>
      </div>
    </form>
  </section>`;
}

async function ensureBranch(fj: Forgejo, owner: string, repo: string, branch: string): Promise<void> {
  if (branch === "main") return;
  const exists = await fj.getBranch(owner, repo, branch);
  if (!exists) await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
}

async function writeMarkdownFile(
  ctx: WebCtx,
  branch: string,
  rel: string,
  content: string,
  previousRel?: string,
): Promise<void> {
  const plan = planIndexPage(ctx.db, {
    workspaceSlug: ctx.ws.slug,
    filePath: rel,
    bodyText: content,
    formatId: ctx.ws.defaultMdFormat,
  });
  const finalContent = plan.rewrittenContent ?? content;
  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await ctx.fj.getFileMeta(ctx.owner, ctx.repo, branch, rel);
  if (isRename && existing) throw new Error(`destination already exists: ${rel}`);
  const previous = isRename ? await ctx.fj.getFileMeta(ctx.owner, ctx.repo, branch, previousRel as string) : null;
  await ctx.fj.putFile(ctx.owner, ctx.repo, {
    branch,
    path: rel,
    content: finalContent,
    sha: existing?.sha,
    message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
  });
  if (isRename && previous) {
    await ctx.fj.deleteFile(ctx.owner, ctx.repo, {
      branch,
      path: previousRel as string,
      sha: previous.sha,
      message: `remove ${previousRel} after rename`,
    });
  }
  plan.commit();
  if (isRename) deletePage(ctx.db, ctx.ws.slug, previousRel as string);
  invalidateBranchTree(ctx.owner, ctx.repo, branch);
}

async function writeTextFile(
  ctx: WebCtx,
  branch: string,
  rel: string,
  content: string,
  previousRel?: string,
): Promise<void> {
  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await ctx.fj.getFileMeta(ctx.owner, ctx.repo, branch, rel);
  if (isRename && existing) throw new Error(`destination already exists: ${rel}`);
  const previous = isRename ? await ctx.fj.getFileMeta(ctx.owner, ctx.repo, branch, previousRel as string) : null;
  await ctx.fj.putFile(ctx.owner, ctx.repo, {
    branch,
    path: rel,
    content,
    sha: existing?.sha,
    message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
  });
  if (isRename && previous) {
    await ctx.fj.deleteFile(ctx.owner, ctx.repo, {
      branch,
      path: previousRel as string,
      sha: previous.sha,
      message: `remove ${previousRel} after rename`,
    });
    if ((previousRel as string).endsWith(".md")) deletePage(ctx.db, ctx.ws.slug, previousRel as string);
  }
  invalidateBranchTree(ctx.owner, ctx.repo, branch);
}

function branchCreatePanel(ctx: WebCtx, branches: readonly ForgejoBranch[]): Html {
  if (ctx.ws.role === "read") return emptyHtml;
  return html`<form class="filter-panel" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/new")}" data-testid="branch-create-form">
    <label>New branch
      <input name="name" placeholder="user/${ctx.user}/work" required data-testid="branch-create-name">
    </label>
    <label>Base
      <select name="base" data-testid="branch-create-base">
        ${branchOptions(branches, "main")}
      </select>
    </label>
    <div class="filter-actions">
      <button class="button primary" type="submit">Create branch</button>
    </div>
  </form>`;
}

function branchList(ctx: WebCtx, branches: readonly ForgejoBranch[], openHeads: ReadonlySet<string>): Html {
  if (branches.length === 0) return html`<div class="list"><div class="empty">No branches.</div></div>`;
  return html`<div class="list">${branches.map((branch) => {
    const hasOpenPr = openHeads.has(branch.name);
    return html`<div class="list-row branch-row">
        <a class="inline-link" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch.name)}`}"><strong>${branch.name}</strong></a>
        <span>${branch.commit.id.slice(0, 10)}${hasOpenPr ? html` <span class="meta-pill">open PR</span>` : ""}</span>
        ${
          ctx.ws.role === "read" || branch.name === "main" || hasOpenPr
            ? html`<span></span>`
            : html`<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/delete")}">
                <input type="hidden" name="name" value="${branch.name}">
                <button class="button danger" type="submit" data-testid="branch-delete">Delete</button>
              </form>`
        }
      </div>`;
  })}</div>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function pageSearchForm(owner: string, repo: string): Html {
  return html`<form class="page-search" method="get" action="${repoHref(owner, repo, "/search")}">
    <input name="q" placeholder="Search pages" aria-label="Search pages" data-testid="page-search-box">
  </form>`;
}

function renderSnippet(parts: readonly SnippetPart[]): Html {
  return html`${parts.map((p) => (p.match ? html`<mark>${p.text}</mark>` : p.text))}`;
}

function searchResultRow(ctx: WebCtx, r: PageSearchResult): Html {
  const href = `${repoHref(ctx.owner, ctx.repo, "/src/branch/main/")}${urlPath(r.path)}`;
  return html`<a class="list-row search-result" href="${href}">
    <span class="search-result-head"><strong>${r.title || r.path}</strong> <small class="muted">${r.path}</small></span>
    <span class="search-snippet">${renderSnippet(r.snippet)}</span>
  </a>`;
}

// Nested, collapsible branch file tree for the left sidebar on /files pages
// (#119). Built from the flat blob list already fetched for the page — no extra
// round-trip. Directories are native <details> (collapsible like any file
// explorer); the active file is highlighted and its ancestor folders auto-open.
interface FileTreeNode {
  dirs: Map<string, FileTreeNode>;
  files: Array<{ name: string; path: string }>;
}

function buildFileTree(files: readonly ForgejoTreeEntry[]): FileTreeNode {
  const root: FileTreeNode = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: file.path });
  }
  return root;
}

function renderFileTreeLevel(
  node: FileTreeNode,
  prefix: string,
  owner: string,
  repo: string,
  branch: string,
  activeRel: string | null,
): Html {
  const dirs = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => {
      const dirPath = prefix ? `${prefix}/${name}` : name;
      const open = activeRel === dirPath || (activeRel?.startsWith(`${dirPath}/`) ?? false);
      return html`<details class="ftree-dir"${open ? " open" : ""}>
        <summary>${name}</summary>
        <div class="ftree-children">${renderFileTreeLevel(child, dirPath, owner, repo, branch, activeRel)}</div>
      </details>`;
    });
  const fileRows = node.files.map((file) => {
    const href = `${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}`;
    return html`<a class="ftree-file${file.path === activeRel ? " active" : ""}" href="${href}">${file.name}</a>`;
  });
  return html`${dirs}${fileRows}`;
}

function fileTreeSidebar(owner: string, repo: string, branch: string, files: readonly ForgejoTreeEntry[], activeRel: string | null): Html {
  if (files.length === 0) return emptyHtml;
  return html`<nav class="file-tree" aria-label="Files">
    <div class="file-tree-head">Files</div>
    ${renderFileTreeLevel(buildFileTree(files), "", owner, repo, branch, activeRel)}
  </nav>`;
}

// Portable Panel unit (#120) for the branch file tree. The panel owns only its
// own <nav class="file-tree">; the host page places it into a region (the left
// sidebar today), so it could move to another region unchanged.
export function fileTreePanel(owner: string, repo: string, branch: string, files: readonly ForgejoTreeEntry[], activeRel: string | null): Panel {
  return panel("file-tree", () => fileTreeSidebar(owner, repo, branch, files, activeRel));
}

function fileList(owner: string, repo: string, branch: string, files: ForgejoTreeEntry[]): Html {
  if (files.length === 0) return html`<div class="list"><div class="empty">No files.</div></div>`;
  return html`<div class="list">${files.map((file) => {
    const kind = fileKindForPath(file.path);
    return html`<a class="list-row" href="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}`}">
        <strong>${file.path}</strong>
        <span>${fileKindLabel(kind)}</span>
        <small>${formatBytes(file.size ?? 0)}</small>
      </a>`;
  })}</div>`;
}

function editBranchFor(username: string, requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== "main" ? trimmed : `user/${username}/web-edit`;
}

function routeRest(c: Context<AppEnv>, owner: string, repo: string, suffix: string): string {
  const path = c.req.path;
  const prefix = repoHref(owner, repo, suffix);
  return path.startsWith(prefix) ? decodePathPart(path.slice(prefix.length)) : "";
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return "";
  }
}
