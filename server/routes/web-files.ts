import type { Hono } from "hono";
import { buildPdfImagePreviewPaths } from "../../shared/asset-previews.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fileKindForPath, type FileKind, isEditableTextFile } from "../../shared/file-kind.js";
import { resolveBranchPath, validBranchName } from "../branch-path.js";
import { repositoryRawHeadersForPath } from "../content-type.js";
import {
  WorkspaceBackendError,
  onWorkspaceNotFound,
  type WorkspaceBackend,
} from "../workspace-backend.js";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { planIndexPage } from "../indexer.js";
import { searchWorkspacePages, workspacePageTitles } from "../page-search.js";
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
import { pageSearchForm, repoHomeHeader, repoLanding, searchResultRow } from "./web-repo-landing.js";
import { webEditShellAssets, webEditorAssets } from "./web-shell.js";

export function registerFileRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo", webRoute(async (c, ctx) => {
    const { owner, repo, backend, ws, user } = ctx;
    const [files, branches, repoMeta] = await Promise.all([
      repoFiles(backend, owner, repo, "main").catch(() => []),
      backend.listBranches(owner, repo).catch(() => []),
      backend.getRepo(owner, repo).catch(() => null),
    ]);
    const titles = workspacePageTitles(ctx.db, ws.slug);
    const cloneUrl = sshCloneUrl(c.get("config").forgejoUrl, owner, repo, repoMeta?.ssh_url);
    const assetPreviewPaths = buildPdfImagePreviewPaths(files.map((file) => file.path));
    const readme = await repoReadme(ctx, "main", files, assetPreviewPaths);
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
            <span class="toolbar-actions">${ws.role === "read" ? "" : newFileControl(owner, repo, user, "main")}</span>
          </div>
        </div>
        ${repoHomeHeader(ctx, owner, repo, stats)}
        ${clonePanel(cloneUrl)}
        ${repoLanding(ctx, "main", files, titles, readme)}
      `, {
        readerAssets: Boolean(readme) && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
        sidebarPanels: [fileTreePanel(owner, repo, "main", files, null, titles, branches, user, ws.role !== "read")],
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
  const resolved = await resolveBranchPath(backend, owner, repo, routeRest(c, owner, repo, "/src/branch/"));
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
    const [files, branches] = await Promise.all([
      repoFiles(backend, owner, repo, resolved.branch),
      backend.listBranches(owner, repo).catch(() => []),
    ]);
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
      : requestedMode === undefined && !sourceView && kind === "markdown" && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID
        ? "auto"
        : null;
  if (workbenchMode && editableFileKind(kind) && ws.role !== "read") {
    const editBranchParam = c.req.query("edit_branch");
    const editBranch = directWrite ? resolved.branch : editBranchFor(ctx.user, editBranchParam ?? resolved.branch);
    if (!directWrite && !validBranchName(editBranch)) return badRequestPage(ctx.user, "Valid branch name is required.");
    return editPageResponse(ctx, {
      branch: editBranch,
      rel,
      kind,
      initialMode: workbenchMode,
    });
  }
  const meta = await backend.getFileMeta(owner, repo, resolved.branch, rel).catch(onWorkspaceNotFound(null));
  if (!meta) return notFoundPage(user, "File not found");
  const [files, branches] = await Promise.all([
    repoFiles(backend, owner, repo, resolved.branch),
    backend.listBranches(owner, repo).catch(() => []),
  ]);
  const assetPreviewPaths = buildPdfImagePreviewPaths(files.map((file) => file.path));
  const content = kind === "markdown" || (kind === "text" && sourceView) ? await backend.getRawFile(owner, repo, resolved.branch, rel) : null;
  const previewKind = await previewKindForFile(backend, owner, repo, resolved.branch, rel, kind, meta.size);
  const coflatMarkdownDocument = kind === "markdown" && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID;
  const rendered =
    kind === "markdown" && content !== null && !sourceView
      ? await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel, renderTitle: true, assetPreviewPaths, sourcePositions: coflatMarkdownDocument })
      : null;
  const fileHref = `${repoHref(owner, repo, "/src/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}`;
  const readerChrome = coflatMarkdownDocument
    ? html`<div class="doc-reader-chrome">
        <details class="doc-reader-more">
          <summary>More</summary>
          <div class="doc-reader-more-menu" aria-label="File representations">
            <a href="${pdfExportOptionsHref(ctx.owner, ctx.repo, resolved.branch, rel)}">PDF</a>
            <a href="${rawFileHref(ctx.owner, ctx.repo, resolved.branch, rel)}">Raw</a>
          </div>
        </details>
      </div>`
    : emptyHtml;
  // Coflat-rendered markdown gets a shared document rail: view-switch actions
  // at the top and the table of contents below. The reader island fills the TOC
  // from Coflat's outline data, while the editor renders the same rail shape
  // from its live outline.
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
  if (rel === REPO_CONFIG_PATH) bustRepoConfig(ctx.db, ctx.ws.slug, resolved.branch);
  invalidateBranchTree(ctx.owner, ctx.repo, resolved.branch);
  c.get("sse").publish(ctx.ws.slug, { type: "change", path: rel });
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(resolved.branch)}`);
}));

web.get("/:owner/:repo/raw/branch/*", webRoute(async (c, ctx) => {
  const resolved = await resolveBranchPath(ctx.backend, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/raw/branch/"));
  if (!resolved?.path) return new Response("not found", { status: 404 });
  const rel = safeRel(resolved.path);
  if (!rel) return new Response("not found", { status: 404 });
  const content = await ctx.backend.getRawFileBytes(ctx.owner, ctx.repo, resolved.branch, rel);
  return new Response(content, { headers: repositoryRawHeadersForPath(rel, content) });
}));

registerPdfExportRoutes(web);

async function editPageResponse(
  ctx: WebCtx,
  opts: { branch: string; rel: string; kind: FileKind; initialMode: "read" | "edit" | "auto" },
): Promise<Response> {
  const { branch, rel, kind, initialMode } = opts;
  const branchInfo = branch === "main" ? await ctx.backend.getBranch(ctx.owner, ctx.repo, "main") : await ctx.backend.getBranch(ctx.owner, ctx.repo, branch);
  const resetEditBranch = Boolean(branchInfo) && await retiredDefaultEditBranch(ctx, branch);
  const branchExists = !resetEditBranch && (branch === "main" || Boolean(branchInfo));
  const branchRef = branchInfo?.commit?.id ?? branch;
  const branchMeta = resetEditBranch ? null : await ctx.backend.getFileMeta(ctx.owner, ctx.repo, branchRef, rel);
  const mainInfo = branchMeta ? null : await ctx.backend.getBranch(ctx.owner, ctx.repo, "main");
  const mainRef = mainInfo?.commit?.id ?? "main";
  const mainMeta = branchMeta ? null : await ctx.backend.getFileMeta(ctx.owner, ctx.repo, mainRef, rel);
  const sourceRef = branchMeta ? branchRef : mainMeta ? mainRef : null;
  const baseSha = branchMeta?.sha ?? (!branchExists ? mainMeta?.sha : null) ?? null;
  const sourceSha = !branchMeta && branchExists ? (mainMeta?.sha ?? null) : null;
  const content = sourceRef ? await ctx.backend.getRawFile(ctx.owner, ctx.repo, sourceRef, rel) : "";
  const repoConfig = kind === "markdown" && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID
    ? await loadRepoConfig(ctx.db, ctx.backend, ctx.owner, ctx.repo, branchExists ? branch : "main")
    : null;
  // The edit branch is created lazily on first save, so for a brand-new edit
  // branch the tree (file list) and Cancel target come from main instead.
  const treeBranch = branchExists ? branch : "main";
  const readBranch = branchMeta ? branch : mainMeta ? "main" : treeBranch;
  const files = await repoFiles(ctx.backend, ctx.owner, ctx.repo, treeBranch).catch(() => []);
  const readFiles = readBranch === treeBranch
    ? files
    : await repoFiles(ctx.backend, ctx.owner, ctx.repo, readBranch).catch(() => []);
  const assetPreviewPaths = buildPdfImagePreviewPaths(readFiles.map((file) => file.path));
  const treeTitles = treeBranch === "main" ? workspacePageTitles(ctx.db, ctx.ws.slug) : undefined;
  const cancelHref = `${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(readBranch)}/${urlPath(rel)}`;
  const coflatMarkdownEdit = kind === "markdown" && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID;
  // The titlebar is gone (#126): the file path + branch live in the status-bar
  // breadcrumb; rename + Cancel moved into the editor's bottom status bar. The
  // file tree mirrors the read page's sidebar so edit/read chrome match (#123).
  return htmlResponse(
    repoPageShell(ctx, "files", `Edit ${rel}`, coflatMarkdownEdit ? html`
        <section class="edit-page" data-edit-shell data-initial-mode="${initialMode}" data-mode="${initialMode}">
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
            data-format-id="${ctx.ws.defaultMdFormat}"
            data-base-sha="${baseSha ?? ""}"
            data-source-sha="${sourceSha ?? ""}"
            data-reset-edit-branch="${resetEditBranch ? "1" : "0"}"
            data-write-mode="${ctx.writeMode}"
            data-can-open-pull="${ctx.canOpenPull ? "1" : "0"}"
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
            data-format-id="${ctx.ws.defaultMdFormat}"
            data-base-sha="${baseSha ?? ""}"
            data-source-sha="${sourceSha ?? ""}"
            data-reset-edit-branch="${resetEditBranch ? "1" : "0"}"
            data-write-mode="${ctx.writeMode}"
            data-can-open-pull="${ctx.canOpenPull ? "1" : "0"}"
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
  if (!directWrite && !validBranchName(branch)) return badRequestPage(ctx.user, "Valid branch name is required.");
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
    throw err;
  }
  if (oldRel && oldRel !== rel) c.get("sse").publish(ctx.ws.slug, { type: "change", path: oldRel });
  c.get("sse").publish(ctx.ws.slug, { type: "change", path: rel });
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
        formatId: ctx.ws.defaultMdFormat,
        replacePath,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? content;
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
  // The sidecar is branchless and mirrors Forgejo main. Branch writes still use
  // the plan for frontmatter/id rewriting, but must not publish unmerged branch
  // content into search/backlinks/tree doc metadata.
  // Deliberately do not call plan.commit() here; webhooks/reindex reconcile main.
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
  if (branch !== userDefaultEditBranch(ctx.user)) return false;
  const pulls = await ctx.backend.listPulls(ctx.owner, ctx.repo, "all").catch(() => []);
  const unmerged = pulls.filter((pull) => pull.head.ref === branch && pull.base.ref === "main" && !pull.merged);
  return unmerged.length > 0 && unmerged.every((pull) => pull.state === "closed");
}
