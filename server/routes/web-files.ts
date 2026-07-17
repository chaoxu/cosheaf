import { canWrite } from "../../shared/roles.js";
import type { Hono } from "hono";
import { join } from "node:path";
import { buildPdfImagePreviewPaths, isPdfAssetPath } from "../../shared/asset-previews.js";
import { rasterizePdfFirstPage } from "../pdf-raster.js";
import { fileKindForPath, type FileKind, isEditableTextFile } from "../../shared/file-kind.js";
import { resolveBranchPath, resolveBranchPathFromNames, validBranchName } from "../branch-path.js";
import { repositoryRawHeadersForPath } from "../content-type.js";
import { isRetiredDefaultEditBranch } from "../edit-branch-retirement.js";
import {
  WorkspaceBackendError,
  onWorkspaceNotFound,
  type WorkspaceBackend,
} from "../workspace-backend.js";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { indexLocalDelete, indexLocalWrite, planIndexPage } from "../indexer.js";
import { assertLocalAnnotationsReadable, localAnnotationSidecarConflict, moveLocalAnnotationsPath } from "../local/local-annotations.js";
import { publishLocalFileMutationEvents } from "../local/local-events.js";
import { documentTags, searchWorkspacePages, workspacePageTitles, workspacePagesByTag, workspaceTagCloud } from "../page-search.js";
import { bustRepoConfig, loadRepoConfig, REPO_CONFIG_PATH } from "../repo-config.js";
import { getCachedTree, invalidateBranchTree, setCachedTree } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { isStaleShaConflict, rollbackCreatedRenameDestination, safeRel } from "./files.js";
import { branchIcon } from "./icons.js";
import { editBranchFor, editHref, newFileControl, rawFileHref, readHref, userDefaultEditBranch } from "./web-file-links.js";
import { editableFileKind, filePreview, previewKindForFile } from "./web-file-preview.js";
import { fileToolbar } from "./web-file-toolbar.js";
import { fileTreePanel } from "./web-file-tree.js";
import {
  badRequestPage,
  forbiddenPage,
  htmlResponse,
  notFoundPage,
  redirect,
  repoHref,
  routeRest,
  stringField,
  textField,
  urlPath,
  type WebCtx,
  webRoute,
  webRouteForWrite,
} from "./web-context.js";
import { emptyHtml, type Html, html, jsonScript } from "./web-html.js";
import { coflatReaderPayload, renderMarkdown } from "./web-markdown.js";
import { repoPageShell } from "./web-page.js";
import { pdfExportOptionsHref, registerPdfExportRoutes } from "./web-pdf-export.js";
import { clonePanel, sshCloneUrl } from "./web-repo-clone.js";
import { pageSearchForm, repoHomeHeader, repoLanding, searchResultRow, tagChip } from "./web-repo-landing.js";
import { webEditShellAssets, webEditorAssets } from "./web-shell.js";

function hasFileContent(file: unknown): file is { content: string } {
  return Boolean(file && typeof file === "object" && "content" in file && typeof (file as { content?: unknown }).content === "string");
}

export function registerFileRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo", webRoute(async (c, ctx) => {
    const { owner, repo, backend, ws, user } = ctx;
    const repoMeta = await backend.getRepo(owner, repo).catch(() => null);
    // The default branch is whatever the backend reports — "main" hosted, but the
    // working tree's checked-out branch in the local Workbench — so the landing,
    // file tree, and edit links route to the branch actually in use (not a
    // hardcoded "main" the local backend would then refuse to match).
    const defaultBranch = repoMeta?.default_branch || "main";
    const [files, branches] = await Promise.all([
      repoFiles(backend, owner, repo, defaultBranch).catch(() => []),
      backend.listBranches(owner, repo).catch(() => []),
    ]);
    const titles = workspacePageTitles(ctx.db, ws.slug);
    // No clone panel in local mode (it has no real remote), so skip the URL too.
    const cloneUrl = ctx.writeMode === "direct" ? null : sshCloneUrl(c.get("config").forgejoUrl, owner, repo, repoMeta?.ssh_url);
    const assetPreviewPaths = buildPdfImagePreviewPaths(files.map((file) => file.path));
    const readme = await repoReadme(ctx, defaultBranch, files, assetPreviewPaths);
    const stats = {
      pages: files.filter((file) => /\.md$/i.test(file.path)).length,
      branches: branches.length,
      openIssues: repoMeta?.open_issues_count ?? 0,
      updated: repoMeta?.updated_at,
      description: repoMeta?.description,
    };
    return htmlResponse(
      repoPageShell(ctx, "files", `Files - ${repo}`, html`
        <div class="page-title compact page-title--actions-only">
          <div class="toolbar-actions">
            ${pageSearchForm(owner, repo)}
            <span class="toolbar-actions">${!canWrite(ws.role) ? "" : newFileControl(owner, repo, user, defaultBranch)}</span>
          </div>
        </div>
        ${repoHomeHeader(ctx, owner, repo, stats)}
        ${cloneUrl ? clonePanel(cloneUrl) : emptyHtml}
        ${repoLanding(ctx, defaultBranch, files, titles, readme)}
      `, {
        readerAssets: Boolean(readme) && ctx.coflat,
        sidebarPanels: [fileTreePanel(owner, repo, defaultBranch, files, null, titles, branches, user, ws.role !== "read")],
      }),
    );
  }));

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

// #388: browse surface for the page_tags index. Tag cloud ranked by IDF (rare
// tags larger), each chip linking to the pages carrying it. Tags are main-only.
web.get("/:owner/:repo/tags", webRoute(async (_c, ctx) => {
  const tags = workspaceTagCloud(ctx.db, ctx.ws.slug);
  const maxIdf = tags.reduce((m, t) => Math.max(m, t.idf), 0) || 1;
  return htmlResponse(
    repoPageShell(ctx, "files", `Tags - ${ctx.repo}`, html`
        <div class="page-title compact"><div><h1>Tags</h1></div></div>
        ${
          tags.length === 0
            ? html`<div class="empty">No tags yet. Add a <code>tags:</code> list to a page's frontmatter.</div>`
            : html`<div class="tag-cloud" data-testid="tag-cloud">${tags.map((t) =>
                tagChip(ctx, t.tag, { count: t.count, sizeRem: 0.85 + 0.5 * (t.idf / maxIdf) }))}</div>`
        }
      `),
  );
}));

web.get("/:owner/:repo/tags/:tag", webRoute(async (c, ctx) => {
  const tag = c.req.param("tag") ?? "";
  const pages = workspacePagesByTag(ctx.db, ctx.ws.slug, tag);
  return htmlResponse(
    repoPageShell(ctx, "files", `#${tag} - ${ctx.repo}`, html`
        <div class="page-title compact">
          <div><h1>#${tag}</h1><p class="muted">${pages.length} page${pages.length === 1 ? "" : "s"}</p></div>
          <a class="button subtle" href="${repoHref(ctx.owner, ctx.repo, "/tags")}">All tags</a>
        </div>
        ${
          pages.length === 0
            ? html`<div class="empty">No pages tagged <strong>${tag}</strong>.</div>`
            : html`<div class="list" data-testid="tag-pages">${pages.map((p) => html`<a
                class="list-row"
                href="${readHref(ctx.owner, ctx.repo, "main", p.path)}"
              ><span class="search-result-head"><strong>${p.title || p.path}</strong> <small class="muted">${p.path}</small></span></a>`)}</div>`
        }
      `),
  );
}));

// "More" menu listing alternate representations of a Coflat document (PDF
// export, raw source). Rendered identically in the read view and at the top of
// the editor shell, so the export affordances are reachable in both.
function fileRepresentationsMenu(owner: string, repo: string, branch: string, rel: string): Html {
  return html`<div class="doc-reader-chrome">
    <details class="doc-reader-more">
      <summary>More</summary>
      <div class="doc-reader-more-menu" aria-label="File representations">
        <a href="${pdfExportOptionsHref(owner, repo, branch, rel)}">PDF</a>
        <a href="${rawFileHref(owner, repo, branch, rel)}">Raw</a>
      </div>
    </details>
  </div>`;
}

web.get("/:owner/:repo/src/branch/*", webRoute(async (c, ctx) => {
  const { owner, repo, backend, ws, user } = ctx;
  // Direct write-mode (local Workbench): edit the resolved ref in place rather
  // than forking a per-user edit branch.
  const directWrite = ctx.writeMode === "direct";
  const requestedMode = c.req.query("mode");
  if ((requestedMode === "read" || requestedMode === "edit") && ws.role !== "read") {
    const requestedEditBranch = c.req.query("edit_branch");
    const editBranch = requestedEditBranch === undefined ? null : editBranchFor(ctx.user, requestedEditBranch);
    if (editBranch !== null && !validBranchName(editBranch)) return badRequestPage(ctx.user, "Valid branch name is required.");
    const requestedPath = c.req.query("path");
    if (requestedPath !== undefined && requestedPath.trim() !== "" && !safeRel(requestedPath)) {
      return badRequestPage(ctx.user, "Valid file path is required.");
    }
  }
  const branches = await backend.listBranches(owner, repo).catch(() => []);
  const resolved = resolveBranchPathFromNames(branches.map((branch) => branch.name), routeRest(c, owner, repo, "/src/branch/"));
  if (!resolved) return notFoundPage(user, "Branch not found");
  if (!resolved.path) {
    if ((requestedMode === "read" || requestedMode === "edit") && ws.role !== "read") {
      const requestedPath = c.req.query("path");
      const rel = requestedPath === undefined || requestedPath.trim() === "" ? "new.md" : safeRel(requestedPath);
      if (!rel) return badRequestPage(ctx.user, "Valid file path is required.");
      const kind = fileKindForPath(rel);
      if (!editableFileKind(kind)) return badRequestPage(ctx.user, "This file type can be previewed or opened raw, but cannot be edited in Cosheaf.");
      const editBranch = directWrite ? resolved.branch : editBranchFor(ctx.user, c.req.query("edit_branch") ?? resolved.branch);
      if (!directWrite && !validBranchName(editBranch)) return badRequestPage(ctx.user, "Valid branch name is required.");
      return editPageResponse(ctx, { branch: editBranch, rel, kind, initialMode: requestedMode });
    }
    const files = await repoFiles(backend, owner, repo, resolved.branch);
    const assetPreviewPaths = buildPdfImagePreviewPaths(files.map((file) => file.path));
    const branchTitles = resolved.branch === "main" ? workspacePageTitles(ctx.db, ws.slug) : undefined;
    // The sidebar tree is the file navigator; the main panel shows the branch's
    // README (or a title-first page index), never a second copy of the file list.
    const readme = await repoReadme(ctx, resolved.branch, files, assetPreviewPaths);
    return htmlResponse(
      repoPageShell(ctx, "files", `${repo}: ${resolved.branch}`, html`
          <div class="page-title compact page-title--actions-only">
            <div class="toolbar-actions">
              ${
                !canWrite(ws.role)
                  ? ""
                  : html`${resolved.branch === "main" ? "" : html`<a class="button primary" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main`}">Open PR</a>`}
                    ${newFileControl(owner, repo, user, resolved.branch)}`
              }
            </div>
          </div>
          ${repoLanding(ctx, resolved.branch, files, branchTitles ?? new Map<string, string>(), readme)}
        `, {
          readerAssets: Boolean(readme) && ctx.coflat,
          sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, null, branchTitles, branches, user, ws.role !== "read")],
        }),
    );
  }
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(user, "File not found");
  const kind = fileKindForPath(rel);
  const sourceView = c.req.query("view") === "source";
  const workbenchMode =
    requestedMode === "read" || requestedMode === "edit"
      ? requestedMode
      : requestedMode === undefined && !sourceView && kind === "markdown" && ctx.coflat
        ? "read"
        : null;
  if (workbenchMode && editableFileKind(kind) && ws.role !== "read") {
    const editBranchParam = c.req.query("edit_branch");
    const editBranch = directWrite
      ? resolved.branch
      : requestedMode === "edit"
        ? editBranchFor(ctx.user, editBranchParam ?? resolved.branch)
        : requestedMode === "read" && editBranchParam !== undefined
          ? editBranchFor(ctx.user, editBranchParam)
          : resolved.branch;
    if (!directWrite && !validBranchName(editBranch)) return badRequestPage(ctx.user, "Valid branch name is required.");
    return editPageResponse(ctx, {
      branch: editBranch,
      rel,
      kind,
      initialMode: workbenchMode,
    });
  }
  const readText = kind === "markdown" || (kind === "text" && sourceView);
  const [fileRead, files] = await Promise.all([
    readText
      ? backend.readFile(owner, repo, resolved.branch, rel).catch(onWorkspaceNotFound(null))
      : backend.getFileMeta(owner, repo, resolved.branch, rel).catch(onWorkspaceNotFound(null)),
    repoFiles(backend, owner, repo, resolved.branch).catch(() => []),
  ]);
  if (!fileRead) return notFoundPage(user, "File not found");
  const meta = { sha: fileRead.sha, size: fileRead.size };
  const assetPreviewPaths = buildPdfImagePreviewPaths(files.map((file) => file.path));
  const content = readText && hasFileContent(fileRead) ? fileRead.content : null;
  const previewKind = await previewKindForFile(backend, owner, repo, resolved.branch, rel, kind, meta.size);
  const coflatMarkdownDocument = kind === "markdown" && ctx.coflat;
  const rendered =
    kind === "markdown" && content !== null && !sourceView
      ? await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel, renderTitle: true, assetPreviewPaths, sourcePositions: coflatMarkdownDocument })
      : null;
  const fileHref = `${repoHref(owner, repo, "/src/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}`;
  const readerChrome = coflatMarkdownDocument
    ? fileRepresentationsMenu(ctx.owner, ctx.repo, resolved.branch, rel)
    : emptyHtml;
  // Coflat-rendered markdown gets a shared document rail: view-switch actions
  // at the top and the table of contents below. The reader island fills the TOC
  // from Coflat's outline data, while the editor renders the same rail shape
  // from its live outline.
  // #388: this page's own tags (main-only, same gate as fileTitles), as chips
  // linking to the tag browse page.
  const fileTags = resolved.branch === "main" ? documentTags(ctx.db, ws.slug, rel) : [];
  const tagChipsRow = fileTags.length > 0
    ? html`<div class="tag-chips" data-testid="doc-tags">${fileTags.map((t) => tagChip(ctx, t))}</div>`
    : emptyHtml;
  const preview = filePreview(ctx, resolved.branch, rel, previewKind, { rendered, source: content, sourceView });
  const sourceRailPayload =
    coflatMarkdownDocument && sourceView && content !== null
      ? coflatReaderPayload(
        ctx,
        content,
        { branch: resolved.branch, documentPath: rel, renderTitle: true, assetPreviewPaths },
        await loadRepoConfig(ctx.db, ctx.backend, owner, repo, resolved.branch),
      )
      : null;
  const docBody =
    coflatMarkdownDocument
      ? html`<div class="doc-with-toc">
          <div class="doc-main">
            ${readerChrome}
            ${tagChipsRow}
            ${preview}
          </div>
          <aside
            class="doc-rail"
            aria-label="Document tools"
            data-document-rail
            data-doc-mode="read"
            data-read-href="${readHref(ctx.owner, ctx.repo, resolved.branch, rel)}"
            data-edit-href="${editableFileKind(kind) && ctx.ws.role !== "read" ? editHref(ctx.owner, ctx.repo, ctx.user, resolved.branch, rel) : ""}"
          >
            ${sourceRailPayload ? html`<script type="application/json" data-document-rail-source>${jsonScript(sourceRailPayload)}</script>` : emptyHtml}
          </aside>
        </div>`
      : preview;
  // Page titles for the tree are only indexed for main (#168), mirroring fileList.
  const fileTitles = resolved.branch === "main" ? workspacePageTitles(ctx.db, ws.slug) : undefined;
  const pageBody = coflatMarkdownDocument
    ? docBody
    : html`<div class="file-toolbar">
      <div>
        ${kind === "markdown" ? emptyHtml : html`<h1>${rel}</h1>`}
      </div>
      ${fileToolbar(ctx, { branch: resolved.branch, rel, kind, fileHref, sourceView, sha: meta.sha })}
    </div>
    ${docBody}`;
  return htmlResponse(
    repoPageShell(ctx, "files", `${rel} - ${repo}`, pageBody, {
        readerAssets: coflatMarkdownDocument,
        sidebarPanels: [fileTreePanel(owner, repo, resolved.branch, files, rel, fileTitles, branches, user, ws.role !== "read")],
      }),
  );
}));

web.post("/:owner/:repo/src/branch/*", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  if (stringField(form.action) !== "delete") return badRequestPage(ctx.user, "Unsupported file action.");
  const resolved = await resolveBranchPath(ctx.backend, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/src/branch/"));
  if (!resolved?.path) return notFoundPage(ctx.user, "File not found");
  if (resolved.branch === "main") return forbiddenPage(ctx.user);
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(ctx.user, "File not found");
  const expectedShaField = form.expected_sha;
  if (expectedShaField !== undefined && typeof expectedShaField !== "string") {
    return badRequestPage(ctx.user, "Invalid delete freshness token.");
  }
  const expectedSha = typeof expectedShaField === "string" ? expectedShaField : undefined;
  const meta = await ctx.backend.getFileMeta(ctx.owner, ctx.repo, resolved.branch, rel);
  if (!meta) return notFoundPage(ctx.user, "File not found");
  if (expectedSha !== undefined && meta.sha !== expectedSha) {
    return badRequestPage(ctx.user, "This file changed on the branch while you were viewing it. Reload and try again.");
  }
  try {
    await ctx.backend.deleteFile(ctx.owner, ctx.repo, {
      branch: resolved.branch,
      path: rel,
      sha: meta.sha,
      message: `delete ${rel}`,
    });
  } catch (err) {
    if (isStaleShaConflict(err)) {
      return badRequestPage(ctx.user, "This file changed on the branch while you were viewing it. Reload and try again.");
    }
    throw err;
  }
  indexLocalDelete(ctx.writeMode === "direct", ctx.db, ctx.ws.slug, rel);
  if (rel === REPO_CONFIG_PATH) bustRepoConfig(ctx.db, ctx.ws.slug, resolved.branch);
  invalidateBranchTree(ctx.owner, ctx.repo, resolved.branch);
  if (ctx.writeMode === "direct") publishLocalFileMutationEvents(c, ctx.ws.slug, { action: "removed", path: rel });
  else c.get("sse").publish(ctx.ws.slug, { type: "change", path: rel });
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(resolved.branch)}`);
}));

web.get("/:owner/:repo/raw/branch/*", webRoute(async (c, ctx) => {
  const resolved = await resolveBranchPath(ctx.backend, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/raw/branch/"));
  if (!resolved?.path) return new Response("not found", { status: 404 });
  const rel = safeRel(resolved.path);
  if (!rel) return new Response("not found", { status: 404 });
  const content = await ctx.backend.getRawFileBytes(ctx.owner, ctx.repo, resolved.branch, rel);
  // PDF figures (`![](fig.pdf)`) can't render in <img>; the display asset URL
  // carries ?preview=png (see pdfDisplaySuffix), so rasterize page 1 to a cached
  // PNG for those requests. Falls back to the raw bytes if rendering fails.
  if (c.req.query("preview") === "png" && isPdfAssetPath(rel)) {
    try {
      const png = await rasterizePdfFirstPage(Buffer.from(content), {
        cacheDir: join(c.get("config").dataDir, "cache", "pdf-png"),
      });
      return new Response(png, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
      });
    } catch (_err) {
      // Corrupt/encrypted PDF — serve the raw bytes rather than 500.
    }
  }
  return new Response(content, { headers: repositoryRawHeadersForPath(rel, content) });
}));

registerPdfExportRoutes(web);

async function editPageResponse(
  ctx: WebCtx,
  opts: { branch: string; rel: string; kind: FileKind; initialMode: "read" | "edit" | "auto" },
): Promise<Response> {
  const { branch, rel, kind, initialMode } = opts;
  const [branchInfo, mainInfo] = await Promise.all([
    ctx.backend.getBranch(ctx.owner, ctx.repo, branch),
    branch === "main" ? Promise.resolve(null) : ctx.backend.getBranch(ctx.owner, ctx.repo, "main"),
  ]);
  const resetEditBranch = Boolean(branchInfo) && await retiredDefaultEditBranch(ctx, branch);
  const branchExists = !resetEditBranch && (branch === "main" || Boolean(branchInfo));
  const branchRef = branchInfo?.commit?.id ?? branch;
  const branchRead = resetEditBranch
    ? null
    : await ctx.backend.readFile(ctx.owner, ctx.repo, branchRef, rel).catch(onWorkspaceNotFound(null));
  const mainRef = mainInfo?.commit?.id ?? "main";
  const mainRead = branchRead ? null : await ctx.backend.readFile(ctx.owner, ctx.repo, mainRef, rel).catch(onWorkspaceNotFound(null));
  const baseSha = branchRead?.sha ?? (!branchExists ? mainRead?.sha : null) ?? null;
  const sourceSha = !branchRead && branchExists ? (mainRead?.sha ?? null) : null;
  const content = branchRead?.content ?? mainRead?.content ?? "";
  const repoConfig = kind === "markdown" && ctx.coflat
    ? await loadRepoConfig(ctx.db, ctx.backend, ctx.owner, ctx.repo, branchExists ? branch : "main")
    : null;
  // The edit branch is created lazily on first save, so for a brand-new edit
  // branch the tree (file list) and Cancel target come from main instead.
  const treeBranch = branchExists ? branch : "main";
  const readBranch = branchRead ? branch : mainRead ? "main" : treeBranch;
  const files = await repoFiles(ctx.backend, ctx.owner, ctx.repo, treeBranch).catch(() => []);
  const readFiles = readBranch === treeBranch
    ? files
    : await repoFiles(ctx.backend, ctx.owner, ctx.repo, readBranch).catch(() => []);
  const assetPreviewPaths = buildPdfImagePreviewPaths(readFiles.map((file) => file.path));
  const treeTitles = treeBranch === "main" ? workspacePageTitles(ctx.db, ctx.ws.slug) : undefined;
  const cancelHref = `${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(readBranch)}/${urlPath(rel)}`;
  const coflatMarkdownEdit = kind === "markdown" && ctx.coflat;
  // The titlebar is gone (#126): the file path + branch live in the status-bar
  // breadcrumb; rename + Cancel moved into the editor's bottom status bar. The
  // file tree mirrors the read page's sidebar so edit/read chrome match (#123).
  return htmlResponse(
    repoPageShell(ctx, "files", `Edit ${rel}`, coflatMarkdownEdit ? html`
        <section class="edit-page" data-edit-shell data-initial-mode="${initialMode}" data-mode="${initialMode}">
          ${fileRepresentationsMenu(ctx.owner, ctx.repo, readBranch, rel)}
          <div
            id="web-editor-root"
            data-owner="${ctx.owner}"
            data-repo="${ctx.repo}"
            data-path="${rel}"
            data-branch="${branch}"
            data-branch-exists="${branchExists ? "1" : "0"}"
            data-read-branch="${readBranch}"
            data-username="${ctx.user}"
            data-role="${ctx.ws.role}"
            data-base-sha="${baseSha ?? ""}"
            data-source-sha="${sourceSha ?? ""}"
            data-reset-edit-branch="${resetEditBranch ? "1" : "0"}"
            data-write-mode="${ctx.writeMode}"
            data-can-open-pull="${ctx.canOpenPull ? "1" : "0"}"
            data-origin-id="${ctx.originId ?? ""}"
          ><div class="web-editor-loading">Loading editor...</div></div>
          <script id="web-editor-content" type="application/json">${jsonScript(content)}</script>
          <script id="web-editor-repo-config" type="application/json">${jsonScript(repoConfig ?? {})}</script>
          <script id="web-editor-asset-previews" type="application/json">${jsonScript(assetPreviewPaths)}</script>
          ${webEditShellAssets()}
          <noscript>${editFallbackForm(ctx, { branch, rel, content, baseSha, sourceSha, cancelHref })}</noscript>
        </section>
      ` : kind === "markdown" ? html`
        <section class="edit-page">
          <div
            id="web-editor-root"
            data-owner="${ctx.owner}"
            data-repo="${ctx.repo}"
            data-path="${rel}"
            data-branch="${branch}"
            data-branch-exists="${branchExists ? "1" : "0"}"
            data-read-branch="${readBranch}"
            data-username="${ctx.user}"
            data-role="${ctx.ws.role}"
            data-base-sha="${baseSha ?? ""}"
            data-source-sha="${sourceSha ?? ""}"
            data-reset-edit-branch="${resetEditBranch ? "1" : "0"}"
            data-write-mode="${ctx.writeMode}"
            data-can-open-pull="${ctx.canOpenPull ? "1" : "0"}"
            data-origin-id="${ctx.originId ?? ""}"
          ></div>
          <script id="web-editor-content" type="application/json">${jsonScript(content)}</script>
          <script id="web-editor-repo-config" type="application/json">${jsonScript(repoConfig ?? {})}</script>
          <script id="web-editor-asset-previews" type="application/json">${jsonScript(assetPreviewPaths)}</script>
          ${webEditorAssets()}
          <noscript>${editFallbackForm(ctx, { branch, rel, content, baseSha, sourceSha, cancelHref })}</noscript>
        </section>
      ` : textEditPage(ctx, branch, rel, content, baseSha, sourceSha, treeBranch), {
        readerAssets: false,
        statusExtra: [{ label: branch, icon: branchIcon({ size: 12 }) }],
        statusOmitTab: true,
        sidebarPanels: [fileTreePanel(ctx.owner, ctx.repo, treeBranch, files, rel, treeTitles, [], ctx.user, ctx.ws.role !== "read", branch)],
      }),
  );
}

web.post("/:owner/:repo/_edit", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  // Direct write-mode (local Workbench) saves to the working-tree ref as-is;
  // hosted folds the request onto a per-user edit branch.
  const directWrite = ctx.writeMode === "direct";
  const branch = directWrite ? (stringField(form.branch) ?? "main") : editBranchFor(ctx.user, stringField(form.branch));
  // Validate in both modes — even in direct mode the branch flows into the
  // post-save redirect URL, so it must be a safe ref ("main" or a valid name).
  const branchValid = directWrite ? branch === "main" || validBranchName(branch) : validBranchName(branch);
  if (!branchValid) return badRequestPage(ctx.user, "Valid branch name is required.");
  const rel = safeRel(stringField(form.path) ?? undefined);
  const oldRel = safeRel(stringField(form.old_path) ?? undefined);
  const content = textField(form.content);
  const expectedShaField = form.expected_sha;
  if (expectedShaField !== undefined && typeof expectedShaField !== "string") {
    return badRequestPage(ctx.user, "Invalid edit freshness token.");
  }
  const expectedSha = typeof expectedShaField === "string" ? expectedShaField === "" ? null : expectedShaField : undefined;
  const expectedSourceShaField = form.expected_source_sha;
  if (expectedSourceShaField !== undefined && typeof expectedSourceShaField !== "string") {
    return badRequestPage(ctx.user, "Invalid source freshness token.");
  }
  const expectedSourceSha = typeof expectedSourceShaField === "string" && expectedSourceShaField ? expectedSourceShaField : undefined;
  if (!rel || content === null) return redirect(repoHref(ctx.owner, ctx.repo));
  if (form.old_path !== undefined && (!oldRel || !isEditableTextFile(oldRel)))
    return badRequestPage(ctx.user, "Invalid original path.");
  await ensureBranch(ctx.backend, ctx.owner, ctx.repo, branch);
  const kind = fileKindForPath(rel);
  if (kind !== "markdown" && kind !== "text") {
    return badRequestPage(ctx.user, "Only Markdown and text files can be edited in Cosheaf.");
  }
  try {
    await writeFile(ctx, branch, rel, content, oldRel ?? undefined, expectedSha, expectedSourceSha);
  } catch (err) {
    // A concurrent save advanced the branch head between our read and write.
    // Surface a reload-and-retry message instead of a bare gateway error (#92).
    if (isStaleShaConflict(err)) {
      return badRequestPage(ctx.user, "This file changed on the branch while you were editing. Reload the page to get the latest version, then reapply your edit.");
    }
    if (err instanceof Error && /^destination already exists: /.test(err.message)) {
      return badRequestPage(ctx.user, "A file already exists at the new path.");
    }
    if (localAnnotationSidecarConflict(err)) {
      return badRequestPage(ctx.user, "Local annotations could not be read. Fix .cosheaf/local-annotations.json, then retry.");
    }
    throw err;
  }
  if (ctx.writeMode === "direct") {
    publishLocalFileMutationEvents(c, ctx.ws.slug, oldRel && oldRel !== rel
      ? { action: "moved", path: rel, previous_path: oldRel }
      : { action: "changed", path: rel });
  } else {
    if (oldRel && oldRel !== rel) c.get("sse").publish(ctx.ws.slug, { type: "change", path: oldRel });
    c.get("sse").publish(ctx.ws.slug, { type: "change", path: rel });
  }
  return redirect(
    kind === "markdown"
      ? `${readHref(ctx.owner, ctx.repo, branch, rel)}?mode=edit`
      : readHref(ctx.owner, ctx.repo, branch, rel),
  );
}));
}

async function repoFiles(backend: WorkspaceBackend, owner: string, repo: string, ref: string) {
  let tree = getCachedTree(owner, repo, ref);
  if (!tree) {
    tree = await backend.getTree(owner, repo, ref, true);
    setCachedTree(owner, repo, ref, tree);
  }
  return tree
    .filter((entry) => entry.type === "blob")
    .sort((a, b) => a.path.localeCompare(b.path));
}

// The non-island fallback form (the markdown editor's <noscript> and the plain
// text-file editor): a hidden old_path + Branch/Path inputs + content textarea
// + Save, all matching the POST /_edit save contract. The two callers differ
// only in classes/test-id and whether a Cancel sits in the form (the text page
// owns its own titlebar Cancel instead).
function editFallbackForm(
  ctx: WebCtx,
  opts: { branch: string; rel: string; content: string; baseSha?: string | null; sourceSha?: string | null; cancelHref?: string; formClass?: string; formTestId?: string; textareaClass?: string },
): Html {
  return html`<form${opts.formClass ? html` class="${opts.formClass}"` : emptyHtml}${opts.formTestId ? html` data-testid="${opts.formTestId}"` : emptyHtml} method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
    <input type="hidden" name="old_path" value="${opts.rel}">
    ${opts.baseSha === undefined ? emptyHtml : html`<input type="hidden" name="expected_sha" value="${opts.baseSha ?? ""}">`}
    ${opts.sourceSha ? html`<input type="hidden" name="expected_source_sha" value="${opts.sourceSha}">` : emptyHtml}
    <label>Branch <input name="branch" value="${opts.branch}" required></label>
    <label>Path <input name="path" value="${opts.rel}" required></label>
    <textarea${opts.textareaClass ? html` class="${opts.textareaClass}"` : emptyHtml} name="content" spellcheck="false">${opts.content}</textarea>
    <div class="form-actions">
      <button class="button primary" type="submit">Save</button>
      ${opts.cancelHref ? html`<a class="button" href="${opts.cancelHref}">Cancel</a>` : emptyHtml}
    </div>
  </form>`;
}

function textEditPage(ctx: WebCtx, branch: string, rel: string, content: string, baseSha: string | null, sourceSha: string | null, cancelBranch: string): Html {
  return html`<section class="edit-page text-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><h1>${rel}</h1></div>
      <a class="button subtle" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(cancelBranch)}/${urlPath(rel)}`}">Cancel</a>
    </div>
    ${editFallbackForm(ctx, { branch, rel, content, baseSha, sourceSha, formClass: "compose-form", formTestId: "text-edit-form", textareaClass: "text-file-editor" })}
  </section>`;
}

async function ensureBranch(backend: WorkspaceBackend, owner: string, repo: string, branch: string): Promise<void> {
  if (branch === "main") return;
  const exists = await backend.getBranch(owner, repo, branch);
  if (exists) return;
  try {
    await backend.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
  } catch (err) {
    if (err instanceof WorkspaceBackendError && err.status === 409 && await backend.getBranch(owner, repo, branch)) return;
    throw err;
  }
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
  expectedSha?: string | null,
  expectedSourceSha?: string,
): Promise<void> {
  const isMarkdown = fileKindForPath(rel) === "markdown";
  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await ctx.backend.getFileMeta(ctx.owner, ctx.repo, branch, rel);
  if (isRename && existing) throw new Error(`destination already exists: ${rel}`);
  const previous = isRename ? await ctx.backend.getFileMeta(ctx.owner, ctx.repo, branch, previousRel as string) : null;
  const fallbackRename =
    isRename && !previous && expectedSha === null && expectedSourceSha !== undefined;
  if (isRename && !previous && !fallbackRename) {
    throw new WorkspaceBackendError(409, "stale_sha", `missing source for rename ${previousRel}`);
  }
  const casMeta = isRename ? previous : existing;
  const casPath = isRename ? (previousRel as string) : rel;
  let mainSourceMeta: Awaited<ReturnType<WorkspaceBackend["getFileMeta"]>> | undefined;
  if (isRename && previous && isMarkdown && fileKindForPath(previousRel as string) === "markdown") {
    mainSourceMeta = await ctx.backend.getFileMeta(ctx.owner, ctx.repo, "main", previousRel as string);
  }
  const replacePath = isRename && previous && mainSourceMeta === null
    ? previousRel as string
    : undefined;
  const plan = isMarkdown
    ? planIndexPage(ctx.db, {
        workspaceSlug: ctx.ws.slug,
        filePath: rel,
        bodyText: content,
        replacePath,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? content;
  const localAnnotationEntry = ctx.writeMode === "direct" && ctx.localEntry && previousRel && previousRel !== rel
    ? ctx.localEntry
    : null;
  if (localAnnotationEntry) assertLocalAnnotationsReadable(localAnnotationEntry);
  if (expectedSha !== undefined && (casMeta?.sha ?? null) !== expectedSha) {
    throw new WorkspaceBackendError(409, "stale_sha", `stale sha for ${casPath}`);
  }
  if (expectedSourceSha !== undefined && !casMeta?.sha) {
    const sourceMeta = mainSourceMeta ?? await ctx.backend.getFileMeta(ctx.owner, ctx.repo, "main", casPath);
    if ((sourceMeta?.sha ?? null) !== expectedSourceSha) {
      throw new WorkspaceBackendError(409, "stale_sha", `stale source sha for ${casPath}`);
    }
  }
  const written = await ctx.backend.putFile(ctx.owner, ctx.repo, {
    branch,
    path: rel,
    content: finalContent,
    sha: existing?.sha,
    message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
  });
  if (isRename && previous) {
    try {
      await ctx.backend.deleteFile(ctx.owner, ctx.repo, {
        branch,
        path: previousRel as string,
        sha: previous.sha,
        message: `remove ${previousRel} after rename`,
      });
    } catch (err) {
      if (!isStaleShaConflict(err)) throw err;
      try {
        await rollbackCreatedRenameDestination(ctx.backend, ctx.owner, ctx.repo, branch, rel, written.content?.sha);
      } catch (rollbackErr) {
        invalidateBranchTree(ctx.owner, ctx.repo, branch);
        throw new Error(`rename rollback failed for ${rel}: ${(rollbackErr as Error).message}`);
      }
      invalidateBranchTree(ctx.owner, ctx.repo, branch);
      throw err;
    }
  }
  // Move the local-annotation sidecar to the new path adjacent to the rename,
  // before the (blocking, SQLite-committing) index write below, so no external
  // reader observes the renamed-away file with an unmoved annotation through the
  // index-commit window (#395 rename/move atomicity).
  if (localAnnotationEntry && previousRel) {
    moveLocalAnnotationsPath(localAnnotationEntry, previousRel, rel);
  }
  // The sidecar is branchless and mirrors Forgejo main. Branch writes still use
  // the plan for frontmatter/id rewriting, but must not publish unmerged branch
  // content into search/backlinks/tree doc metadata.
  // Branch writes don't publish into the sidecar (webhooks/reindex reconcile
  // main). Local Workbench (direct write-mode) is the exception — see
  // indexLocalWrite — indexing now to keep search/backlinks live.
  indexLocalWrite(ctx.writeMode === "direct", ctx.db, ctx.ws.slug, plan, previousRel && previousRel !== rel ? previousRel : undefined);
  // #182: a cosheaf.yaml edit through the editor busts its cached config for
  // this branch (read-after-write for config, independent of sidecar indexing).
  if (rel === REPO_CONFIG_PATH || previousRel === REPO_CONFIG_PATH) bustRepoConfig(ctx.db, ctx.ws.slug, branch);
  invalidateBranchTree(ctx.owner, ctx.repo, branch);
}

// README at the repo root, rendered for the /files landing (#136). The nav tree
// owns navigation; the main panel shows the README when present so it adds value
// instead of repeating the file list. Case-insensitive `README.md` at the root.
async function repoReadme(ctx: WebCtx, branch: string, files: readonly ForgejoTreeEntry[], assetPreviewPaths: ReturnType<typeof buildPdfImagePreviewPaths>): Promise<{ path: string; rendered: Html } | null> {
  const readme = files.find((file) => /^readme\.md$/i.test(file.path));
  if (!readme) return null;
  const content = await ctx.backend.getRawFile(ctx.owner, ctx.repo, branch, readme.path).catch(() => null);
  if (content === null) return null;
  const rendered = await renderMarkdown(ctx, content, { branch, documentPath: readme.path, renderTitle: true, assetPreviewPaths });
  return { path: readme.path, rendered };
}

async function retiredDefaultEditBranch(ctx: WebCtx, branch: string): Promise<boolean> {
  return isRetiredDefaultEditBranch({
    backend: ctx.backend,
    owner: ctx.owner,
    repo: ctx.repo,
    branch,
    defaultEditBranch: userDefaultEditBranch(ctx.user),
  });
}
