import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { type FileKind, fileKindForPath } from "../../shared/file-kind.js";
import { REPO_CONFIG_PATH, bustRepoConfig } from "../repo-config.js";
import { resolveBranchPath, validBranchName } from "../branch-path.js";
import { repositoryRawHeadersForPath } from "../content-type.js";
import { type Forgejo, ForgejoError } from "../forgejo.js";
import { is404, onForgejo404 } from "../forgejo-errors.js";
import type { ForgejoBranch, ForgejoTreeEntry } from "../forgejo-types.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { type PageSearchResult, type SnippetPart, searchWorkspacePages, workspacePageExcerpts, workspacePageTitles } from "../page-search.js";
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
  notFoundPage,
  redirect,
  repoHref,
  requestOrigin,
  stringField,
  textField,
  urlPath,
  webRoute,
  webRouteForWrite,
  type WebCtx,
} from "./web-context.js";
import { emptyHtml, html, type Html, jsonScript } from "./web-html.js";
import { type Panel, panel } from "./web-panels.js";
import { markdownSurface, renderMarkdown } from "./web-markdown.js";
import { branchOptions, repoPageShell } from "./web-page.js";
import { webEditorAssets } from "./web-shell.js";
import { branchIcon, chevronIcon } from "./icons.js";

export function registerFileRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo", webRoute(async (c, ctx) => {
  const { owner, repo, fj, ws, user } = ctx;
  const [files, branches] = await Promise.all([
    repoFiles(fj, owner, repo, "main").catch(() => []),
    fj.listBranches(owner, repo).catch(() => []),
  ]);
  const titles = workspacePageTitles(ctx.db, ws.slug);
  const cloneUrl = `${requestOrigin(c)}/${owner}/${repo}.git`;
  const readme = await repoReadme(ctx, "main", files);
  return htmlResponse(
    repoPageShell(ctx, "files", `Files - ${repo}`, html`
        <div class="page-title compact page-title--actions-only">
          <div class="toolbar-actions">
            ${pageSearchForm(owner, repo)}
            <span class="build-only toolbar-actions">
              ${cloneBox(cloneUrl)}
              <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
              ${
                ws.role === "read"
                  ? ""
                  : newFileControl(owner, repo, user, "main")
              }
            </span>
          </div>
        </div>
        ${repoLanding(ctx, "main", files, titles, readme)}
      `, {
        readerAssets: Boolean(readme) && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
        sidebarPanels: [fileTreePanel(owner, repo, "main", files, null, titles, branches)],
      }),
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
  const [files, branches] = await Promise.all([
    repoFiles(fj, owner, repo, resolved.branch),
    fj.listBranches(owner, repo).catch(() => []),
  ]);
  if (!resolved.path) {
    const branchTitles = resolved.branch === "main" ? workspacePageTitles(ctx.db, ws.slug) : undefined;
    // The sidebar tree is the file navigator; the main panel shows the branch's
    // README (or a title-first page index), never a second copy of the file list.
    const readme = await repoReadme(ctx, resolved.branch, files);
    return htmlResponse(
      repoPageShell(ctx, "files", `${repo}: ${resolved.branch}`, html`
          <div class="page-title compact page-title--actions-only">
            <div class="toolbar-actions build-only">
              <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
              ${
                ws.role === "read"
                  ? ""
                  : html`${resolved.branch === "main" ? "" : html`<a class="button primary" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main`}">Open PR</a>`}
                    ${newFileControl(owner, repo, user, resolved.branch)}`
              }
            </div>
          </div>
          ${repoLanding(ctx, resolved.branch, files, branchTitles ?? new Map<string, string>(), readme)}
        `, {
          readerAssets: Boolean(readme) && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
          sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, null, branchTitles, branches)],
        }),
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
      ? await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel, renderTitle: true })
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
  // Page titles for the tree are only indexed for main (#168), mirroring fileList.
  const fileTitles = resolved.branch === "main" ? workspacePageTitles(ctx.db, ws.slug) : undefined;
  return htmlResponse(
    repoPageShell(ctx, "files", `${rel} - ${repo}`, html`
        <div class="file-toolbar">
          <div>
            ${
              // A rendered markdown page shows its own .cf-doc-title (and the
              // sidebar highlights the file), so the filename H1 + kind/size are
              // redundant noise; other kinds keep a filename header for identity.
              kind === "markdown" && !sourceView ? emptyHtml : html`<h1>${rel}</h1>`
            }
          </div>
          ${fileToolbar(ctx, { branch: resolved.branch, rel, kind, fileHref, sourceView })}
        </div>
        ${docBody}
      `, {
        readerAssets: kind === "markdown" && !sourceView && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
        sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, rel, fileTitles, branches)],
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
  const treeTitles = treeBranch === "main" ? workspacePageTitles(ctx.db, ctx.ws.slug) : undefined;
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
          <noscript>${editFallbackForm(ctx, { branch, rel, content, cancelHref })}</noscript>
        </section>
      ` : textEditPage(ctx, branch, rel, content, treeBranch), {
        statusExtra: [{ label: branch, icon: branchIcon({ size: 12 }) }],
        statusOmitTab: true,
        sidebarPanels: [fileTreePanel(ctx.owner, ctx.repo, treeBranch, files, rel, treeTitles)],
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
  if (kind !== "markdown" && kind !== "text") {
    return badRequestPage(ctx.user, "Only Markdown and text files can be edited in Cosheaf.");
  }
  try {
    await writeFile(ctx, branch, rel, content, oldRel ?? undefined);
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

// The per-file action toolbar on the file-view page: Branches/Raw, the
// markdown Source↔Rendered toggle, and the write controls (Open PR, Edit,
// Delete) gated by role/branch and marked build-only so Read mode hides them
// (#171). Extracted from the file-view handler (#24) to keep the handler legible.
function fileToolbar(
  ctx: WebCtx,
  opts: { branch: string; rel: string; kind: FileKind; fileHref: string; sourceView: boolean },
): Html {
  const { owner, repo, user } = ctx;
  const role = ctx.ws.role;
  const { branch, rel, kind, fileHref, sourceView } = opts;
  return html`<div class="toolbar-actions">
    <a class="button build-only" href="${repoHref(owner, repo, "/branches")}">Branches</a>
    <a class="button" href="${`${repoHref(owner, repo, "/raw/branch")}/${urlPath(branch)}/${urlPath(rel)}`}">Raw</a>
    ${
      kind === "markdown"
        ? sourceView
          ? html`<a class="button" href="${fileHref}">Rendered</a>`
          : html`<a class="button" href="${`${fileHref}?view=source`}">Source</a>`
        : ""
    }
    ${
      role === "read" || branch === "main"
        ? ""
        : html`<a class="button build-only" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(branch)}&base=main`}">Open PR</a>`
    }
    ${
      role === "read"
        ? ""
        : editableFileKind(kind)
          ? html`<a class="button primary build-only" href="${editHref(owner, repo, user, branch, rel)}">${kind === "markdown" ? "Edit" : "Edit text"}</a>`
          : ""
    }
    ${
      role === "read" || branch === "main"
        ? ""
        : html`<form class="inline-form build-only" method="post" action="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`}">
            <input type="hidden" name="action" value="delete">
            <button class="button danger" type="submit" data-testid="file-delete">Delete</button>
          </form>`
    }
  </div>`;
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
    return markdownArticle(ctx, view.rendered ?? emptyHtml, "file-preview-markdown");
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

// The non-island /_edit fallback form (the markdown editor's <noscript> and the
// plain text-file editor): a hidden old_path + Branch/Path inputs + content
// textarea + Save, all matching the POST /_edit field contract. The two callers
// differ only in classes/test-id and whether a Cancel sits in the form (the text
// page owns its own titlebar Cancel instead).
function editFallbackForm(
  ctx: WebCtx,
  opts: { branch: string; rel: string; content: string; cancelHref?: string; formClass?: string; formTestId?: string; textareaClass?: string },
): Html {
  return html`<form${opts.formClass ? html` class="${opts.formClass}"` : emptyHtml}${opts.formTestId ? html` data-testid="${opts.formTestId}"` : emptyHtml} method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
    <input type="hidden" name="old_path" value="${opts.rel}">
    <label>Branch <input name="branch" value="${opts.branch}" required></label>
    <label>Path <input name="path" value="${opts.rel}" required></label>
    <textarea${opts.textareaClass ? html` class="${opts.textareaClass}"` : emptyHtml} name="content" spellcheck="false">${opts.content}</textarea>
    <div class="form-actions">
      <button class="button primary" type="submit">Save</button>
      ${opts.cancelHref ? html`<a class="button" href="${opts.cancelHref}">Cancel</a>` : emptyHtml}
    </div>
  </form>`;
}

function textEditPage(ctx: WebCtx, branch: string, rel: string, content: string, cancelBranch: string): Html {
  return html`<section class="edit-page text-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><h1>${rel}</h1></div>
      <a class="button subtle" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(cancelBranch)}/${urlPath(rel)}`}">Cancel</a>
    </div>
    ${editFallbackForm(ctx, { branch, rel, content, formClass: "compose-form", formTestId: "text-edit-form", textareaClass: "text-file-editor" })}
  </section>`;
}

async function ensureBranch(fj: Forgejo, owner: string, repo: string, branch: string): Promise<void> {
  if (branch === "main") return;
  const exists = await fj.getBranch(owner, repo, branch);
  if (!exists) await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
}

// Write a Markdown or text file on a branch, handling create / update / rename
// uniformly. Markdown additionally runs the index plan (frontmatter/id handling
// + synchronous doc_map/FTS update); text writes its content as-is.
async function writeFile(
  ctx: WebCtx,
  branch: string,
  rel: string,
  content: string,
  previousRel?: string,
): Promise<void> {
  const isMarkdown = fileKindForPath(rel) === "markdown";
  const plan = isMarkdown
    ? planIndexPage(ctx.db, { workspaceSlug: ctx.ws.slug, filePath: rel, bodyText: content, formatId: ctx.ws.defaultMdFormat })
    : null;
  const finalContent = plan?.rewrittenContent ?? content;
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
  plan?.commit();
  // Drop the old doc_map row when renaming away from a markdown page — whether
  // the NEW path is markdown (rename within pages) or not (an .md→non-md rename
  // must still de-index the old path).
  if (isRename && (isMarkdown || (previousRel as string).endsWith(".md"))) {
    deletePage(ctx.db, ctx.ws.slug, previousRel as string);
  }
  // #182: a cosheaf.yaml edit through the editor busts its cached config for
  // this branch (read-after-write, same contract as the index update above).
  if (rel === REPO_CONFIG_PATH || previousRel === REPO_CONFIG_PATH) bustRepoConfig(ctx.db, ctx.ws.slug, branch);
  invalidateBranchTree(ctx.owner, ctx.repo, branch);
}

function branchCreatePanel(ctx: WebCtx, branches: readonly ForgejoBranch[]): Html {
  if (ctx.ws.role === "read") return emptyHtml;
  return html`<form class="filter-panel" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/new")}" data-testid="branch-create-form">
    <label>New branch
      <input name="name" placeholder="user/${ctx.user}/work" required data-testid="branch-create-name">
    </label>
    <label>Base
      <select name="base" data-testid="branch-create-base" data-option-icon="branch">
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
        <a class="inline-link branch-ref" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch.name)}`}">${branchIcon({ size: 13 })}<strong>${branch.name}</strong></a>
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
  titles: Map<string, string> | undefined,
): Html {
  const dirs = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => {
      const dirPath = prefix ? `${prefix}/${name}` : name;
      const open = activeRel === dirPath || (activeRel?.startsWith(`${dirPath}/`) ?? false);
      return html`<details class="ftree-dir"${open ? " open" : ""}>
        <summary>${chevronIcon({ size: 11, class: "disclosure-chevron" })}${name}</summary>
        <div class="ftree-children">${renderFileTreeLevel(child, dirPath, owner, repo, branch, activeRel, titles)}</div>
      </details>`;
    });
  const fileRows = node.files.map((file) => {
    const href = `${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}`;
    // Title-first leaves (#168), matching the main fileList: a titled page shows
    // its title in Read mode and its filename in Build mode (CSS swaps the two
    // spans by html[data-cosheaf-mode]); untitled/non-page leaves show the
    // filename in both modes. `title=` keeps the storage filename on hover.
    const title = file.path.endsWith(".md") ? titles?.get(file.path) : undefined;
    const label = title
      ? html`<span class="ftree-title">${title}</span><span class="ftree-name">${file.name}</span>`
      : file.name;
    return html`<a class="ftree-file${file.path === activeRel ? " active" : ""}" href="${href}" title="${file.name}">${label}</a>`;
  });
  return html`${dirs}${fileRows}`;
}

// Branch indicator + switcher in the file-tree header: shows the current branch
// and, when more than one exists, a <select> that navigates to that branch's
// files. NOT build-only, so it's the branch affordance available in Read mode
// too. An empty `branches` (the edit page) renders just the label — no
// navigate-away mid-edit. cosheaf-select.js styles the select and fires the
// native `change` the inline handler listens for; with JS off the native select
// still navigates.
function branchSwitcher(owner: string, repo: string, branch: string, branches: readonly ForgejoBranch[]): Html {
  const names = branches.map((b) => b.name);
  if (!names.includes(branch)) names.unshift(branch);
  // The switcher carries its own external icon span (the #185 canonical fix):
  // it must show even in the single-branch case below, which renders no <select>
  // for the widget to enhance, and its option values are URLs, not branch names.
  // So it does NOT use the form selects' data-option-icon="branch" hook (#187) —
  // that would render a second icon on the enhanced trigger.
  const icon = html`<span class="ftree-branch-icon">${branchIcon({ size: 13 })}</span>`;
  if (names.length <= 1) {
    return html`<span class="ftree-branch">${icon}<span class="ftree-branch-name">${branch}</span></span>`;
  }
  return html`<span class="ftree-branch">${icon}<select class="ftree-branch-select" aria-label="Switch branch" onchange="if(this.value)location.assign(this.value)">${names.map(
    (name) => html`<option value="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(name)}`}"${name === branch ? " selected" : ""}>${name}</option>`,
  )}</select></span>`;
}

function fileTreeSidebar(owner: string, repo: string, branch: string, files: readonly ForgejoTreeEntry[], activeRel: string | null, titles: Map<string, string> | undefined, branches: readonly ForgejoBranch[]): Html {
  if (files.length === 0) return emptyHtml;
  return html`<nav class="file-tree" aria-label="Files">
    <div class="file-tree-head">${branchSwitcher(owner, repo, branch, branches)}</div>
    ${renderFileTreeLevel(buildFileTree(files), "", owner, repo, branch, activeRel, titles)}
  </nav>`;
}

// Portable Panel unit (#120) for the branch file tree. The panel owns only its
// own <nav class="file-tree">; the host page places it into a region (the left
// sidebar today), so it could move to another region unchanged. `titles` is the
// workspace page-title map (main branch only — the index tracks main); leaves
// render titles where present (#168). `branches` feeds the header switcher
// (empty = label only).
export function fileTreePanel(owner: string, repo: string, branch: string, files: readonly ForgejoTreeEntry[], activeRel: string | null, titles?: Map<string, string>, branches: readonly ForgejoBranch[] = []): Panel {
  return panel("file-tree", () => fileTreeSidebar(owner, repo, branch, files, activeRel, titles, branches));
}

// README at the repo root, rendered for the /files landing (#136). The nav tree
// owns navigation; the main panel shows the README when present so it adds value
// instead of repeating the file list. Case-insensitive `README.md` at the root.
async function repoReadme(ctx: WebCtx, branch: string, files: readonly ForgejoTreeEntry[]): Promise<{ path: string; rendered: Html } | null> {
  const readme = files.find((file) => /^readme\.md$/i.test(file.path));
  if (!readme) return null;
  const content = await ctx.fj.getRawFile(ctx.owner, ctx.repo, branch, readme.path).catch(() => null);
  if (content === null) return null;
  const rendered = await renderMarkdown(ctx, content, { branch, documentPath: readme.path, renderTitle: true });
  return { path: readme.path, rendered };
}

// The /files main panel (#136): the README when present, otherwise a title-first
// reading index of the workspace's pages. Either way it complements the nav tree
// rather than duplicating it — the tree carries navigation over every file; the
// landing reads the workspace's knowledge.
function repoLanding(
  ctx: WebCtx,
  branch: string,
  files: readonly ForgejoTreeEntry[],
  titles: Map<string, string>,
  readme: { path: string; rendered: Html } | null,
): Html {
  if (readme) return markdownArticle(ctx, readme.rendered, "files-readme");
  return pageIndex(ctx, branch, files, titles);
}

// The shared reader-surface shell for a rendered markdown document: the file
// preview and the /files README landing render the same article.
function markdownArticle(ctx: WebCtx, rendered: Html, testId: string): Html {
  return html`<article class="document cosheaf-document-reader cf-theme-scope" data-testid="${testId}">
    ${markdownSurface(ctx, rendered)}
  </article>`;
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
      return html`<a class="list-row page-row" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}`}">
          <span class="list-row-main"><strong>${title}</strong>${excerpt ? html`<span class="page-row-excerpt">${excerpt}</span>` : emptyHtml}<small>${file.path}</small></span>
        </a>`;
    })}</div>
  </div>`;
}


function editBranchFor(username: string, requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== "main" ? trimmed : `user/${username}/web-edit`;
}

// The /_edit URL for a (branch, optional file) — co-locates the edit-branch
// convention (editBranchFor) and the query encoding. Mirrors rawFileHref.
function editHref(owner: string, repo: string, user: string, branch: string, rel?: string): string {
  const base = `${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, branch))}`;
  return rel ? `${base}&path=${encodeURIComponent(rel)}` : base;
}

// "New file" as a name-it-first control: a GET form whose `path` routes to
// /_edit, which picks the Markdown or plain-text editor from the extension — so
// you can create a `.bib` (or .csv, .tex, …), not only `.md`. Blank submits as
// `new.md`, preserving the old one-click create-a-page behavior.
function newFileControl(owner: string, repo: string, user: string, branch: string): Html {
  return html`<form class="newfile" action="${repoHref(owner, repo, "/_edit")}" method="get">
    <input type="hidden" name="branch" value="${editBranchFor(user, branch)}">
    <input class="newfile-path" name="path" placeholder="new.md" aria-label="New file name" autocomplete="off" spellcheck="false">
    <button class="button" type="submit">New file</button>
  </form>`;
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
