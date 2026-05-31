import type Database from "better-sqlite3";
import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, setCookie } from "hono/cookie";
import { COFLAT_FORMAT_ID, documentFormatFromTopics, isFormatTopic } from "../../shared/document-format.js";
import { type FileKind, fileKindForPath, fileKindLabel } from "../../shared/file-kind.js";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { ROLES, type Role } from "../../shared/roles.js";
import {
  type ActivityFeedItem,
  activityCommitRef,
  branchFromRef,
  collapseNoisyEditBranchCommits,
  parseActivityContent,
} from "../activity-feed.js";
import { resolveBranchPath } from "../branch-path.js";
import { repositoryRawHeadersForPath } from "../content-type.js";
import { runCoverifyChatReply } from "../coverify-cli.js";
import { changedLines, commentableLines, patchRows } from "../diff-lines.js";
import { fileLineToWritePosition, positionToFileLine, type Side } from "../diff-position.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { Forgejo, ForgejoError, type ForgejoPull, mergePullWithRetry } from "../forgejo.js";
import type {
  ForgejoActivity,
  ForgejoBranch,
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoNotificationThread,
  ForgejoPullReviewComment,
  ForgejoReview,
  ForgejoTimelineEvent,
  ForgejoTreeEntry,
} from "../forgejo-types.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { AUTH_COOKIE, invalidateWorkspacePermissionCache, resolveAuth } from "../middleware.js";
import { invalidateBranchTree, invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { setWorkspaceMember } from "../workspace-members.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { safeRel } from "./files.js";
import { escapeAttr, escapeHtml } from "./html-escape.js";
import { validateLabelSelection } from "./label-utils.js";
import {
  CHAT_LABEL,
  chatBranchFromBody,
  chatIssueBody,
  chatLiveScript,
  chatPendingTurn,
  chatReplyPending,
  chatTitleFrom,
  chatTurns,
  isChatIssue,
  renderChatTurn,
} from "./web-chat.js";
import { globalHeader, pageShell, webEditorAssets } from "./web-shell.js";
import { compareWebTimelineItems, webTimelineDescriptionHtml } from "./web-timeline.js";

export const web = new Hono<AppEnv>();
web.use("*", compress());

web.get("/login", (_c) =>
  htmlResponse(
    pageShell({
      title: "Sign in",
      body: `
        <main class="auth-page">
          <form class="auth-card" method="post" action="/login">
            <h1>Cosheaf</h1>
            <label>Username <input name="username" autocomplete="username" required></label>
            <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">Sign in</button>
          </form>
        </main>
      `,
    }),
  ),
);

web.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const username = stringField(form.username);
  const password = stringField(form.password);
  if (!username || !password) return redirect("/login?error=missing");
  const outcome = await exchangeForgejoCredsForPat(
    c.get("db"),
    c.get("config").forgejoUrl,
    username,
    password,
  );
  if (outcome.kind !== "ok") return redirect("/login?error=invalid");
  setCookie(c, AUTH_COOKIE, outcome.pat, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.req.url.startsWith("https://"),
  });
  return c.redirect("/", 303);
});

web.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.redirect("/login", 303);
});

web.get("/", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const config = c.get("config");
  const repos = await configReposForUser(c);
  return htmlResponse(
    pageShell({
      title: "Repositories",
      user: auth.user.username,
      body: `
        ${globalHeader(auth.user.username)}
        <main class="page">
          <div class="page-title">
            <div>
              <p class="eyebrow">Repositories</p>
              <h1>${escapeHtml(config.forgejoOwner)}</h1>
            </div>
          </div>
          <div class="list">
            ${repos
              .map(
                (repo) => `
                  <a class="list-row" href="${repoHref(config.forgejoOwner, repo.name)}">
                    <strong>${escapeHtml(repo.name)}</strong>
                    <span>${escapeHtml(repo.description ?? "")}</span>
                    <small>${escapeHtml(repo.role)}</small>
                  </a>
                `,
              )
              .join("") || `<div class="empty">No repositories available.</div>`}
          </div>
        </main>
      `,
    }),
  );
});

web.get("/account/settings", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  return htmlResponse(
    pageShell({
      title: "Account settings",
      user: auth.user.username,
      body: `
        ${globalHeader(auth.user.username)}
        <main class="page">
          <div class="settings-page account-settings">
            <div class="page-title compact">
              <div>
                <p class="eyebrow">Account</p>
                <h1>Settings</h1>
              </div>
            </div>
            ${userPreferencesSection(auth.user.username)}
          </div>
        </main>
        ${userPreferencesScript()}
      `,
    }),
  );
});

web.get("/:owner/:repo", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const { owner, repo, fj, ws, user } = ctx;
  const files = await repoFiles(fj, owner, repo, "main").catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Files - ${repo}`,
      owner,
      repo,
      active: "files",
      user,
      ws,
      body: `
        <div class="page-title compact">
          <div><p class="eyebrow">Branch</p><h1>main</h1></div>
          <div class="toolbar-actions">
            <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
            ${
              ws.role === "read"
                ? ""
                : `<a class="button" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, "main"))}">New file</a>`
            }
          </div>
        </div>
        ${fileList(owner, repo, "main", files)}
      `,
    }),
  );
});

web.get("/:owner/:repo/src/branch/*", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const { owner, repo, fj, ws, user } = ctx;
  const resolved = await resolveBranchPath(fj, owner, repo, routeRest(c, owner, repo, "/src/branch/"));
  if (!resolved) return notFoundPage(user, "Branch not found");
  const files = await repoFiles(fj, owner, repo, resolved.branch);
  if (!resolved.path) {
    return htmlResponse(
      repoPage({
        title: `${repo}: ${resolved.branch}`,
        owner,
        repo,
        active: "files",
        user,
        ws,
        body: `
          <div class="page-title compact">
            <div><p class="eyebrow">Branch</p><h1>${escapeHtml(resolved.branch)}</h1></div>
            <div class="toolbar-actions">
              <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
              ${
                ws.role === "read"
                  ? ""
                  : `${resolved.branch === "main" ? "" : `<a class="button primary" href="${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main">Open pull request</a>`}
                    <a class="button" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}">New file</a>`
              }
            </div>
          </div>
          ${fileList(owner, repo, resolved.branch, files)}
        `,
      }),
    );
  }
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(user, "File not found");
  const meta = await fj.getFileMeta(owner, repo, resolved.branch, rel).catch((err) => {
    if (err instanceof ForgejoError && err.status === 404) return null;
    throw err;
  });
  if (!meta) return notFoundPage(user, "File not found");
  const kind = fileKindForPath(rel);
  const content = kind === "markdown" ? await fj.getRawFile(owner, repo, resolved.branch, rel) : null;
  const rendered =
    kind === "markdown" && content !== null
      ? await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel })
      : null;
  return htmlResponse(
    repoPage({
      title: `${rel} - ${repo}`,
      owner,
      repo,
      active: "files",
      user,
      ws,
      readerAssets: kind === "markdown" && ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
      body: `
        <div class="file-toolbar">
          <div>
            <p class="eyebrow">${escapeHtml(resolved.branch)}</p>
            <h1>${escapeHtml(rel)}</h1>
            <p class="file-meta">${escapeHtml(fileKindLabel(kind))} <span>${formatBytes(meta.size)}</span></p>
          </div>
          <div class="toolbar-actions">
            <a class="button" href="${repoHref(owner, repo, "/branches")}">Branches</a>
            <a class="button" href="${repoHref(owner, repo, "/raw/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}">Raw</a>
            ${
              ws.role === "read" || resolved.branch === "main"
                ? ""
                : `<a class="button" href="${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(resolved.branch)}&base=main">Open pull request</a>`
            }
            ${
              ws.role === "read"
                ? ""
                : editableFileKind(kind)
                  ? `<a class="button primary" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}&path=${encodeURIComponent(rel)}">${kind === "markdown" ? "Edit" : "Edit text"}</a>`
                  : ""
            }
            ${
              ws.role === "read" || resolved.branch === "main"
                ? ""
                : `<form class="inline-form" method="post" action="${repoHref(owner, repo, "/src/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}">
                    <input type="hidden" name="action" value="delete">
                    <button class="button danger" type="submit" data-testid="file-delete">Delete</button>
                  </form>`
            }
          </div>
        </div>
        ${filePreview(ctx, resolved.branch, rel, kind, rendered ?? content)}
      `,
    }),
  );
});

web.post("/:owner/:repo/src/branch/*", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
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
});

web.get("/:owner/:repo/raw/branch/*", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const resolved = await resolveBranchPath(ctx.fj, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/raw/branch/"));
  if (!resolved?.path) return new Response("not found", { status: 404 });
  const rel = safeRel(resolved.path);
  if (!rel) return new Response("not found", { status: 404 });
  const content = await ctx.fj.getRawFileBytes(ctx.owner, ctx.repo, resolved.branch, rel);
  return new Response(content, { headers: repositoryRawHeadersForPath(rel, content) });
});

web.get("/:owner/:repo/_edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const branch = editBranchFor(ctx.user, c.req.query("branch"));
  const rel = safeRel(c.req.query("path") || "new.md") ?? "new.md";
  const kind = fileKindForPath(rel);
  if (!editableFileKind(kind)) return badRequestPage(ctx.user, "This file type can be previewed or opened raw, but cannot be edited in Cosheaf.");
  const content = await ctx.fj.getRawFile(ctx.owner, ctx.repo, branch, rel).catch(async (err) => {
    if (err instanceof ForgejoError && err.status === 404) {
      return ctx.fj.getRawFile(ctx.owner, ctx.repo, "main", rel).catch(() => "");
    }
    throw err;
  });
  return htmlResponse(
    repoPage({
      title: `Edit ${rel}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "files",
      user: ctx.user,
      ws: ctx.ws,
      body: kind === "markdown" ? `
        <section class="edit-page">
          <div class="file-toolbar edit-titlebar">
            <div>
              <p class="eyebrow">Edit on branch</p>
              <h1>
                <input
                  id="web-editor-path-input"
                  data-testid="editor-path-input"
                  aria-label="File path"
                  value="${escapeAttr(rel)}"
                >
                <span id="web-editor-path-dirty" class="dirty-dot" hidden>*</span>
              </h1>
            </div>
            <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}">Cancel</a>
          </div>
          <div
            id="web-editor-root"
            data-slug="${escapeAttr(ctx.repo)}"
            data-owner="${escapeAttr(ctx.owner)}"
            data-repo="${escapeAttr(ctx.repo)}"
            data-path="${escapeAttr(rel)}"
            data-branch="${escapeAttr(branch)}"
            data-username="${escapeAttr(ctx.user)}"
            data-role="${escapeAttr(ctx.ws.role)}"
            data-format-id="${escapeAttr(ctx.ws.defaultMdFormat)}"
          ></div>
          <script id="web-editor-content" type="application/json">${jsonScript(content)}</script>
          ${webEditorAssets()}
          <noscript>
            <form method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
              <input type="hidden" name="old_path" value="${escapeAttr(rel)}">
              <label>Branch <input name="branch" value="${escapeAttr(branch)}" required></label>
              <label>Path <input name="path" value="${escapeAttr(rel)}" required></label>
              <textarea name="content" spellcheck="false">${escapeHtml(content)}</textarea>
              <button class="button primary" type="submit">Save</button>
            </form>
          </noscript>
        </section>
      ` : textEditPage(ctx, branch, rel, content),
    }),
  );
});

web.post("/:owner/:repo/_edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const branch = editBranchFor(ctx.user, stringField(form.branch));
  const rel = safeRel(stringField(form.path) ?? undefined);
  const oldRel = safeRel(stringField(form.old_path) ?? undefined);
  const content = textField(form.content);
  if (!rel || content === null) return redirect(repoHref(ctx.owner, ctx.repo));
  await ensureBranch(ctx.fj, ctx.owner, ctx.repo, branch);
  const kind = fileKindForPath(rel);
  if (kind === "markdown") {
    await writeMarkdownFile(ctx, branch, rel, content, oldRel ?? undefined);
  } else if (kind === "text") {
    await writeTextFile(ctx, branch, rel, content, oldRel ?? undefined);
  } else {
    return badRequestPage(ctx.user, "Only Markdown and text files can be edited in Cosheaf.");
  }
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`);
});

web.get("/:owner/:repo/issues", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const filters = parseIssueListFilters(c);
  const [issues, labels, milestones] = await Promise.all([
    ctx.fj.listIssues(ctx.owner, ctx.repo, {
      state: filters.state,
      limit: 50,
      q: filters.q || undefined,
      labels: filters.labels || undefined,
      milestones: filters.milestones || undefined,
      created_by: filters.createdBy || undefined,
      assigned_by: filters.assignedBy || undefined,
      mentioned_by: filters.mentionedBy || undefined,
      sort: filters.sort || undefined,
    }),
    ctx.fj.listLabels(ctx.owner, ctx.repo),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all"),
  ]);
  return htmlResponse(
    repoPage({
      title: `Issues - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "issues",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="page-title compact">
          <div><p class="eyebrow">${filters.state}</p><h1>Issues</h1></div>
          ${ctx.ws.role === "read" ? "" : `<a class="button primary" href="${repoHref(ctx.owner, ctx.repo, "/issues/new")}">New issue</a>`}
        </div>
        ${issueFilterForm(ctx.owner, ctx.repo, filters, labels, milestones)}
        ${issueList(ctx.owner, ctx.repo, issues.filter((issue) => !isChatIssue(issue)), "No matching issues.")}
      `,
    }),
  );
});

web.get("/:owner/:repo/issues/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const labels = await ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `New issue - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "issues",
      user: ctx.user,
      ws: ctx.ws,
      body: issueCreatePage(ctx, labels),
    }),
  );
});

web.post("/:owner/:repo/issues/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const title = stringField(form.title);
  const body = textField(form.body) ?? "";
  const labelIds = positiveIntFields(form.labels);
  const labels = await ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []);
  if (!title) {
    return htmlResponse(
      repoPage({
        title: `New issue - ${ctx.repo}`,
        owner: ctx.owner,
        repo: ctx.repo,
        active: "issues",
        user: ctx.user,
        ws: ctx.ws,
        body: issueCreatePage(ctx, labels, { title: "", body, labelIds, error: "Issue title is required." }),
      }),
      400,
    );
  }
  const validation = validateLabelSelection(labelIds, labels, []);
  if (!validation.ok) {
    return htmlResponse(
      repoPage({
        title: `New issue - ${ctx.repo}`,
        owner: ctx.owner,
        repo: ctx.repo,
        active: "issues",
        user: ctx.user,
        ws: ctx.ws,
        body: issueCreatePage(ctx, labels, { title, body, labelIds, error: validation.message }),
      }),
      400,
    );
  }
  const issue = await ctx.fj.createIssue(ctx.owner, ctx.repo, { title, body, labels: labelIds });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number: issue.number, action: "opened" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}`));
});

web.get("/:owner/:repo/issues/:number", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const [issue, comments, timeline, allLabels, dependencies, blocks, pinnedIssues] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return null;
      throw err;
    }),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.fj.listIssueDependencies(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueBlocks(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listPinnedIssues(ctx.owner, ctx.repo).catch(() => []),
  ]);
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  const isPinned = pinnedIssues.some((pinned) => pinned.number === issue.number);
  const body = await renderMarkdownSurface(ctx, issue.body ?? "", { surface: "thread" });
  const timelineHtml = await renderIssueTimeline(ctx, issue.number, comments, timeline ?? []);
  const nextIssueState = issue.state === "open" ? "closed" : "open";
  const stateActionLabel = issue.state === "open" ? "Close issue" : "Reopen";
  return htmlResponse(
    repoPage({
      title: `#${issue.number} ${issue.title}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "issues",
      user: ctx.user,
      ws: ctx.ws,
      readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
      body: `
        <article class="thread">
          <header class="thread-header">
            <span class="state ${issue.state}">${escapeHtml(issue.state)}</span>
            <div class="thread-title-row">
              <h1>${escapeHtml(issue.title)} <span>#${issue.number}</span></h1>
              ${
                ctx.ws.role === "read"
                  ? ""
                  : `<div class="toolbar-actions">
                      <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/pin`)}">
                        <input type="hidden" name="pinned" value="${isPinned ? "false" : "true"}">
                        <button class="button" type="submit" data-testid="issue-toggle-pin">${isPinned ? "Unpin" : "Pin issue"}</button>
                      </form>
                      <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/state`)}">
                        <input type="hidden" name="state" value="${nextIssueState}">
                        <button class="button" type="submit" data-testid="issue-toggle-state">${stateActionLabel}</button>
                      </form>
                    </div>`
              }
            </div>
            <p>${isPinned ? `<span class="meta-pill">pinned</span> ` : ""}by ${escapeHtml(displayLogin(ctx.owner, issue.user?.login))} - ${formatDate(issue.created_at)}</p>
          </header>
          <div class="issue-document">
            ${body}
          </div>
          ${issueEditForm(ctx, issue)}
          ${labelEditForm({
            testId: "issue-label-form",
            action: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/labels`),
            disabled: ctx.ws.role === "read",
            labels: allLabels,
            currentLabels: issue.labels,
          })}
          ${issueRelationsPanel(ctx, issue, dependencies, blocks)}
          ${timelineHtml}
          ${
            ctx.ws.role === "read"
              ? ""
              : `<form class="comment-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/comments`)}">
                   <textarea name="body" placeholder="Leave a comment" required></textarea>
                   <button class="button primary" type="submit">Comment</button>
                 </form>`
          }
        </article>
      `,
    }),
  );
});

web.post("/:owner/:repo/issues/:number/edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const body = textField(form.body);
  if (!title || body === null) return badRequestPage(ctx.user, "Issue title and description are required.");
  await ctx.fj.editIssue(ctx.owner, ctx.repo, number, { title, body });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/labels", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const form = await c.req.parseBody({ all: true });
  const labelIds = positiveIntFields(form.labels);
  const [allLabels, issue] = await Promise.all([
    ctx.fj.listLabels(ctx.owner, ctx.repo),
    ctx.fj.getIssue(ctx.owner, ctx.repo, number),
  ]);
  const validation = validateLabelSelection(labelIds, allLabels, issue.labels);
  if (!validation.ok) return badRequestPage(ctx.user, validation.message);
  await ctx.fj.setIssueLabels(ctx.owner, ctx.repo, number, labelIds);
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  const body = stringField((await c.req.parseBody()).body);
  if (number && body) await ctx.fj.createIssueComment(ctx.owner, ctx.repo, number, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number ?? ""}`));
});

web.post("/:owner/:repo/issues/:number/comments/:id/edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!number || !id) return notFoundPage(ctx.user, "Comment not found");
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  await ctx.fj.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/comments/:id/delete", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  if (!number || !id) return notFoundPage(ctx.user, "Comment not found");
  await ctx.fj.deleteIssueComment(ctx.owner, ctx.repo, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/pin", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const pinned = stringField((await c.req.parseBody()).pinned);
  if (pinned === "true") await ctx.fj.pinIssue(ctx.owner, ctx.repo, number);
  else if (pinned === "false") await ctx.fj.unpinIssue(ctx.owner, ctx.repo, number);
  else return badRequestPage(ctx.user, "Pinned state is required.");
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const form = await c.req.parseBody();
  const index = positiveInt(stringField(form.index) ?? undefined);
  const relation = stringField(form.relation);
  if (!index || index === number) return badRequestPage(ctx.user, "A different issue number is required.");
  if (relation === "blocks") await ctx.fj.addIssueDependency(ctx.owner, ctx.repo, index, number);
  else if (relation === "depends_on") await ctx.fj.addIssueDependency(ctx.owner, ctx.repo, number, index);
  else return badRequestPage(ctx.user, "Relation is required.");
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/dependencies/delete", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const form = await c.req.parseBody();
  const index = positiveInt(stringField(form.index) ?? undefined);
  const relation = stringField(form.relation);
  if (!index) return badRequestPage(ctx.user, "Issue number is required.");
  if (relation === "blocks") await ctx.fj.removeIssueBlock(ctx.owner, ctx.repo, number, index);
  else if (relation === "depends_on") await ctx.fj.removeIssueDependency(ctx.owner, ctx.repo, number, index);
  else return badRequestPage(ctx.user, "Relation is required.");
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/state", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const state = stringField((await c.req.parseBody()).state);
  if (state !== "open" && state !== "closed") return badRequestPage(ctx.user, "State must be open or closed.");
  await ctx.fj.editIssue(ctx.owner, ctx.repo, number, { state });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: state === "closed" ? "closed" : "reopened" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

// Find the "chat" label id, creating it once if missing. Chats are issues
// carrying this label, applied only by the chat "new" route.
async function ensureChatLabel(fj: Forgejo, owner: string, repo: string): Promise<number> {
  const labels = await fj.listLabels(owner, repo);
  const existing = labels.find((label) => label.name === CHAT_LABEL);
  if (existing) return existing.id;
  const created = await fj.createLabel(owner, repo, { name: CHAT_LABEL, color: "8b5cf6", description: "Coverify chat" });
  return created.id;
}

// chatgpt-style sessions sidebar: a "New chat" entry plus one row per chat,
// with the active one highlighted. Shared by the list and thread views.
function listChats(ctx: WebCtx) {
  return ctx.fj
    .listIssues(ctx.owner, ctx.repo, { labels: CHAT_LABEL, state: "open", limit: 50 })
    .then((issues) => issues.filter(isChatIssue))
    .catch(() => [] as ForgejoIssue[]);
}

function chatSidebar(owner: string, repo: string, chats: ForgejoIssue[], active: number | null, role: string): string {
  const newChat =
    role === "read"
      ? ""
      : `<a class="chat-new-link${active === null ? " active" : ""}" href="${repoHref(owner, repo, "/chat")}">+ New chat</a>`;
  const sessions =
    chats
      .map(
        (chat) =>
          `<a class="chat-session${chat.number === active ? " active" : ""}" href="${repoHref(owner, repo, `/chat/${chat.number}`)}" title="${escapeAttr(chat.title)}">${escapeHtml(chat.title)}</a>`,
      )
      .join("") || `<div class="chat-sessions-empty">No chats yet</div>`;
  return `<aside class="chat-sidebar">${newChat}<nav class="chat-sessions">${sessions}</nav></aside>`;
}

web.get("/:owner/:repo/chat", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const [chats, branches] = await Promise.all([
    listChats(ctx),
    ctx.ws.role === "read" ? Promise.resolve([]) : ctx.fj.listBranches(ctx.owner, ctx.repo),
  ]);
  return htmlResponse(
    repoPage({
      title: `Chat - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "chat",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="chat-app">
          ${chatSidebar(ctx.owner, ctx.repo, chats, null, ctx.ws.role)}
          <section class="chat-main">
            <p class="chat-notice">Everyone with access to this workspace can see these chats — they're not private.</p>
            ${
              ctx.ws.role === "read"
                ? `<div class="chat-blank">Read-only access — you can't start chats here.</div>`
                : `<div class="chat-blank">Start a new chat with Coverify, or pick a session on the left.</div>
                   <form class="chat-composer" method="post" action="${repoHref(ctx.owner, ctx.repo, "/chat/new")}">
                     <label>Branch
                       <select name="branch">${branchOptions(branches, "main")}</select>
                     </label>
                     <textarea name="message" placeholder="Start a chat with Coverify" required></textarea>
                     <button class="button primary" type="submit">Send</button>
                   </form>`
            }
          </section>
        </div>
      `,
    }),
  );
});

web.post("/:owner/:repo/chat/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const message = stringField(form.message);
  if (!message) return redirect(repoHref(ctx.owner, ctx.repo, "/chat"));
  const branch = stringField(form.branch) || "main";
  if (!validBranchName(branch)) return badRequestPage(ctx.user, "Valid branch name is required.");
  const branchExists = await ctx.fj.getBranch(ctx.owner, ctx.repo, branch);
  if (!branchExists) return badRequestPage(ctx.user, "Branch does not exist.");
  const labelId = await ensureChatLabel(ctx.fj, ctx.owner, ctx.repo);
  const issue = await ctx.fj.createIssue(ctx.owner, ctx.repo, {
    title: chatTitleFrom(message),
    body: chatIssueBody(message, branch),
    labels: [labelId],
  });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number: issue.number, action: "opened" });
  runCoverifyChatReply(c.get("config"), { workspace: ctx.repo, issue: issue.number });
  return redirect(repoHref(ctx.owner, ctx.repo, `/chat/${issue.number}`));
});

web.get("/:owner/:repo/chat/:number", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Chat not found");
  const [issue, comments, chats] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return null;
      throw err;
    }),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
    listChats(ctx),
  ]);
  if (!issue || issue.pull_request || !isChatIssue(issue)) {
    return notFoundPage(ctx.user, "Chat not found");
  }
  const chatBranch = chatBranchFromBody(issue.body ?? "") ?? "main";
  const turns = chatTurns(issue, comments, c.get("config").coverifyBotLogin);
  const renderedTurns = await Promise.all(
    turns.map(async (turn) => renderChatTurn(turn, await renderMarkdownSurface(ctx, turn.body, { surface: "thread" }))),
  );
  return htmlResponse(
    repoPage({
      title: `${issue.title} - Chat`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "chat",
      user: ctx.user,
      ws: ctx.ws,
      readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
      body: `
        <div class="chat-app">
          ${chatSidebar(ctx.owner, ctx.repo, chats, number, ctx.ws.role)}
          <section class="chat-main">
            <div class="chat-main-head"><p class="eyebrow">Branch ${escapeHtml(chatBranch)}</p><h1>${escapeHtml(issue.title)}</h1></div>
            <div class="chat-thread">
              ${renderedTurns.join("")}
              ${chatReplyPending(turns) ? chatPendingTurn() : ""}
            </div>
            ${chatReplyPending(turns) ? chatLiveScript(ctx.repo, number) : ""}
            ${
              ctx.ws.role === "read"
                ? ""
                : `<form class="chat-composer" method="post" action="${repoHref(ctx.owner, ctx.repo, `/chat/${number}/send`)}">
                     <textarea name="message" placeholder="Message Coverify" required></textarea>
                     <button class="button primary" type="submit">Send</button>
                   </form>`
            }
          </section>
        </div>
      `,
    }),
  );
});

web.post("/:owner/:repo/chat/:number/send", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Chat not found");
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch(() => null);
  if (!issue || !isChatIssue(issue)) {
    return notFoundPage(ctx.user, "Chat not found");
  }
  const message = stringField((await c.req.parseBody()).message);
  if (message) {
    await ctx.fj.createIssueComment(ctx.owner, ctx.repo, number, message);
    c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "commented" });
    runCoverifyChatReply(c.get("config"), { workspace: ctx.repo, issue: number });
  }
  return redirect(repoHref(ctx.owner, ctx.repo, `/chat/${number}`));
});

web.get("/:owner/:repo/pulls", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const filters = parsePullListFilters(c);
  const [pulls, labels, milestones] = await Promise.all([
    ctx.fj.listPulls(ctx.owner, ctx.repo, {
      state: filters.state,
      labels: filters.labels.length > 0 ? filters.labels : undefined,
      milestone: filters.milestone,
      poster: filters.author || undefined,
      sort: filters.sort || undefined,
    }),
    ctx.fj.listLabels(ctx.owner, ctx.repo),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all"),
  ]);
  return htmlResponse(
    repoPage({
      title: `Pull requests - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="page-title compact">
          <div><p class="eyebrow">${filters.state}</p><h1>Pull requests</h1></div>
          ${ctx.ws.role === "read" ? "" : `<a class="button primary" href="${repoHref(ctx.owner, ctx.repo, "/pulls/new")}">New pull request</a>`}
        </div>
        ${pullFilterForm(ctx.owner, ctx.repo, filters, labels, milestones)}
        ${pullList(ctx.owner, ctx.repo, pulls, "No matching pull requests.")}
      `,
    }),
  );
});

web.get("/:owner/:repo/pulls/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const branches = await ctx.fj.listBranches(ctx.owner, ctx.repo);
  const head = stringField(c.req.query("head"));
  const base = stringField(c.req.query("base")) ?? "main";
  return htmlResponse(
    repoPage({
      title: `New pull request - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      body: pullCreatePage(ctx, branches, { head, base }),
    }),
  );
});

web.post("/:owner/:repo/pulls/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const branches = await ctx.fj.listBranches(ctx.owner, ctx.repo);
  const head = stringField(form.head);
  const base = stringField(form.base) ?? "main";
  const title = stringField(form.title);
  const body = textField(form.body) ?? "";
  const values = { head, base, title: title ?? "", body };
  const branchNames = new Set(branches.map((branch) => branch.name));
  const error =
    !head
      ? "Head branch is required."
      : !title
        ? "Pull request title is required."
        : head === base
          ? "Head and base branches must be different."
          : !branchNames.has(head)
            ? "Head branch does not exist."
            : !branchNames.has(base)
              ? "Base branch does not exist."
              : null;
  if (error) {
    return htmlResponse(
      repoPage({
        title: `New pull request - ${ctx.repo}`,
        owner: ctx.owner,
        repo: ctx.repo,
        active: "pulls",
        user: ctx.user,
        ws: ctx.ws,
        body: pullCreatePage(ctx, branches, { ...values, error }),
      }),
      400,
    );
  }
  if (!head || !title) return badRequestPage(ctx.user, "Pull request head and title are required.");
  try {
    const pull = await ctx.fj.createPull(ctx.owner, ctx.repo, { head, base, title, body });
    c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "opened" });
    return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
  } catch (err) {
    if (err instanceof ForgejoError && (err.status === 409 || err.status === 422)) {
      return htmlResponse(
        repoPage({
          title: `New pull request - ${ctx.repo}`,
          owner: ctx.owner,
          repo: ctx.repo,
          active: "pulls",
          user: ctx.user,
          ws: ctx.ws,
          body: pullCreatePage(ctx, branches, { ...values, error: err.message }),
        }),
        err.status,
      );
    }
    throw err;
  }
});

web.get("/:owner/:repo/pulls/:number", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const [reviews, comments, timeline, commits, allLabels, availableReviewers] = await Promise.all([
    ctx.fj.listReviews(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullCommits(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.fj.listPullReviewers(ctx.owner, ctx.repo).catch(() => []),
  ]);
  const body = await renderMarkdownSurface(ctx, pull.body ?? "", { surface: "thread" });
  const timelineHtml = await renderPullTimeline(ctx, pull.number, reviews, comments, timeline ?? [], commits);
  return htmlResponse(
    repoPage({
      title: `#${pull.number} ${pull.title}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
      body: `
        <article class="thread">
          <header class="thread-header">
            <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : escapeHtml(pull.state)}</span>
            <div class="thread-title-row">
              <h1>${escapeHtml(pull.title)} <span>#${pull.number}</span></h1>
              <div class="toolbar-actions">
                <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>
                ${pullStateForm(ctx, pull)}
              </div>
            </div>
            <p>${escapeHtml(pull.head.ref)} into ${escapeHtml(pull.base.ref)} - by ${escapeHtml(displayLogin(ctx.owner, pull.user?.login))}</p>
            <nav class="subtabs">
              <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
              <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
            </nav>
          </header>
          <div class="comment">
            <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, pull.user?.login))}</div>
            ${body ? body : `<p>No description.</p>`}
          </div>
          ${pullEditForm(ctx, pull)}
          ${labelEditForm({
            testId: "pull-label-form",
            action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/labels`),
            disabled: ctx.ws.role === "read" || pull.state === "closed",
            labels: allLabels,
            currentLabels: pull.labels ?? [],
          })}
          ${reviewRequestPanel(ctx, pull, availableReviewers)}
          ${timelineHtml}
          ${reviewForms(ctx, pull)}
        </article>
      `,
    }),
  );
});

web.post("/:owner/:repo/pulls/:number/edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const body = textField(form.body);
  if (!title || body === null) return badRequestPage(ctx.user, "Pull request title and description are required.");
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, { title, body });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/labels", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const labelIds = positiveIntFields(form.labels);
  const allLabels = await ctx.fj.listLabels(ctx.owner, ctx.repo);
  const validation = validateLabelSelection(labelIds, allLabels, pull.labels ?? []);
  if (!validation.ok) return badRequestPage(ctx.user, validation.message);
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, { labels: labelIds });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/state", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.merged) return forbiddenPage(ctx.user);
  const state = stringField((await c.req.parseBody()).state);
  if (state !== "open" && state !== "closed") return badRequestPage(ctx.user, "State must be open or closed.");
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, { state });
  c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: state === "closed" ? "closed" : "reopened" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/review-requests", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const reviewers = stringFields(form.reviewers);
  if (reviewers.length === 0) return badRequestPage(ctx.user, "At least one reviewer is required.");
  await ctx.fj.createPullReviewRequests(ctx.owner, ctx.repo, pull.number, reviewers);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/review-requests/delete", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const reviewer = stringField((await c.req.parseBody()).reviewer);
  if (!reviewer) return badRequestPage(ctx.user, "Reviewer is required.");
  await ctx.fj.deletePullReviewRequests(ctx.owner, ctx.repo, pull.number, [reviewer]);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/reviews", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.user?.login === ctx.user) return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const event = stringField(form.event);
  const body = stringField(form.body) ?? "";
  if (event === "APPROVED" || event === "REQUEST_CHANGES" || event === "COMMENT") {
    await ctx.fj.createReview(ctx.owner, ctx.repo, pull.number, { event, body });
  }
  const redirectTo = safeWebRedirect(stringField(form.redirect_to));
  return redirect(redirectTo ?? repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/comments/:id/edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!pull || !id) return notFoundPage(ctx.user, "Comment not found");
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  await ctx.fj.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/comments/:id/delete", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const reviewId = positiveInt(stringField((await c.req.parseBody()).review_id) ?? undefined);
  if (!pull || !id || !reviewId) return notFoundPage(ctx.user, "Comment not found");
  await ctx.fj.deleteReviewComment(ctx.owner, ctx.repo, pull.number, reviewId, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/comments", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.user?.login === ctx.user || pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const path = safeRel(stringField(form.path) ?? "");
  const side = stringField(form.side);
  const line = positiveInt(stringField(form.line) ?? undefined);
  const body = (stringField(form.body) ?? "").trim();
  if (!path || (side !== "base" && side !== "head") || !line || !body) {
    return badRequestPage(ctx.user, "Line comment requires path, side, line, and body.");
  }
  const patch = splitDiffByFile(await ctx.fj.getPullDiff(ctx.owner, ctx.repo, pull.number)).get(path);
  if (!patch) return badRequestPage(ctx.user, "File is not part of this pull request.");
  const pos = fileLineToWritePosition(patch, line, side);
  if (!pos) return badRequestPage(ctx.user, "Line is not part of the pull request diff.");
  await ctx.fj.createReview(ctx.owner, ctx.repo, pull.number, {
    event: "COMMENT",
    body: "",
    comments: [{ path, body, ...pos }],
  });
  const mode = parseDiffMode(stringField(form.mode) ?? undefined);
  const shape = parseDiffShape(stringField(form.shape) ?? undefined, mode);
  return redirect(
    `${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}?file=${encodeURIComponent(path)}&mode=${mode}&shape=${shape}`,
  );
});

web.post("/:owner/:repo/pulls/:number/merge", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  await mergePullWithRetry(() =>
    ctx.fj.mergePull(ctx.owner, ctx.repo, pull.number, { Do: "squash" }),
  );
  if (pull.head.ref && pull.head.ref !== "main") {
    await deleteBranchQuietly(ctx.fj, ctx.owner, ctx.repo, pull.head.ref);
  }
  invalidateRepoTrees(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.get("/:owner/:repo/pulls/:number/files", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const [files, allComments] = await Promise.all([
    pullFiles(ctx, pull.number),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number).catch(() => []),
  ]);
  const selected = c.req.query("file") ?? files[0]?.path ?? "";
  const file = files.find((f) => f.path === selected) ?? files[0] ?? null;
  const mode = parseDiffMode(c.req.query("mode"));
  const shape = parseDiffShape(c.req.query("shape"), mode);
  const versions = file && shape !== "unified" ? await prFileVersions(ctx, pull, file.path) : null;
  const fileComments = file ? mapLineComments(ctx, file, allComments) : [];
  return htmlResponse(
    repoPage({
      title: `Files #${pull.number} - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID && mode === "rich",
      body: `
        <header class="thread-header">
          <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : escapeHtml(pull.state)}</span>
          <div class="thread-title-row">
            <h1>${escapeHtml(pull.title)} <span>#${pull.number}</span></h1>
            <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>
          </div>
          <nav class="subtabs">
            <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
            <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
          </nav>
        </header>
        <script src="/cosheaf-pr-diff-defaults.js"></script>
        <div class="review-page">
          <main class="review-main">
            <nav class="changed-files" aria-label="Changed files">
              ${files
                .map(
                  (f) => `
                    <a class="${f.path === file?.path ? "active" : ""}" href="${prFilesHref(ctx, pull.number, f.path, mode, shape)}">
                      <span>${escapeHtml(f.path)}</span>
                      <small>+${f.additions} -${f.deletions}</small>
                    </a>
                  `,
                )
                .join("")}
            </nav>
            <section class="diff-panel">
              ${
                file
                  ? `<div class="diff-title"><strong>${escapeHtml(file.path)}</strong><span>+${file.additions} -${file.deletions}</span></div>
                    ${diffModeControls(ctx, pull.number, file.path, mode, shape)}
                    ${await renderPrFileView(ctx, pull, file, mode, shape, versions, fileComments)}`
                  : `<div class="empty">No changed files.</div>`
              }
            </section>
          </main>
          <section class="review-bottom">
            <section class="review-card">
              <h2>Review</h2>
              ${renderFileCommentSummary(fileComments)}
              ${reviewForms(ctx, pull, repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`))}
            </section>
          </section>
        </div>
      `,
    }),
  );
});

web.get("/:owner/:repo/branches", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const [branches, pulls] = await Promise.all([
    ctx.fj.listBranches(ctx.owner, ctx.repo),
    ctx.fj.listPulls(ctx.owner, ctx.repo, "open").catch(() => []),
  ]);
  const openHeads = new Set(pulls.map((pull) => pull.head.ref));
  return htmlResponse(
    repoPage({
      title: `Branches - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "files",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="page-title compact"><h1>Branches</h1></div>
        ${branchCreatePanel(ctx, branches)}
        ${branchList(ctx, branches, openHeads)}
      `,
    }),
  );
});

web.post("/:owner/:repo/branches/new", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
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
});

web.post("/:owner/:repo/branches/delete", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const name = stringField((await c.req.parseBody()).name);
  if (!validBranchName(name) || name === "main") return badRequestPage(ctx.user, "Valid non-main branch name is required.");
  await deleteBranchQuietly(ctx.fj, ctx.owner, ctx.repo, name);
  invalidateRepoTrees(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, "/branches"));
});

web.get("/:owner/:repo/notifications", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const threads = await ctx.fj.listRepoNotifications(ctx.owner, ctx.repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  }).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Notifications - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "notifications",
      user: ctx.user,
      ws: ctx.ws,
      body: notificationsPage(ctx, threads),
    }),
  );
});

web.post("/:owner/:repo/notifications/:id/read", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const id = positiveInt(c.req.param("id"));
  if (!id) return notFoundPage(ctx.user, "Notification not found");
  const thread = await ctx.fj.getNotificationThread(id);
  if (thread.repository.full_name !== `${ctx.owner}/${ctx.repo}`) return notFoundPage(ctx.user, "Notification not found");
  await ctx.fj.markNotificationRead(id);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
});

web.post("/:owner/:repo/notifications/read-all", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  await ctx.fj.markRepoNotificationsRead(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
});

web.get("/:owner/:repo/activity", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const activities = await ctx.fj.listRepoActivities(ctx.owner, ctx.repo, { limit: 50 }).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Activity - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "activity",
      user: ctx.user,
      ws: ctx.ws,
      body: `<div class="page-title compact"><h1>Activity</h1></div>
        ${activityList(ctx, activities)}`,
    }),
  );
});

web.get("/:owner/:repo/commits/:sha", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const sha = c.req.param("sha");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return notFoundPage(ctx.user, "Commit not found");
  const commit = await ctx.fj.getCommit(ctx.owner, ctx.repo, sha).catch((err) => {
    if (err instanceof ForgejoError && err.status === 404) return null;
    throw err;
  });
  if (!commit) return notFoundPage(ctx.user, "Commit not found");
  return htmlResponse(
    repoPage({
      title: `${commit.sha.slice(0, 10)} - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "activity",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="page-title compact">
          <div>
            <p class="eyebrow">Commit</p>
            <h1>${escapeHtml(commit.sha.slice(0, 10))}</h1>
          </div>
        </div>
        <div class="commit-card">
          <pre>${escapeHtml(commit.commit.message.trim() || "(no commit message)")}</pre>
          <p>${escapeHtml(displayLogin(ctx.owner, commit.commit.author?.name ?? commit.author?.login))} - ${formatDate(commit.commit.author?.date)}</p>
          <code>${escapeHtml(commit.sha)}</code>
        </div>
      `,
    }),
  );
});

web.get("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const [protection, labels, milestones] = await Promise.all([
    ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null),
    ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all").catch(() => []),
  ]);
  const accessUpdated = c.req.query("access");
  return htmlResponse(
    repoPage({
      title: `Settings - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "settings",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="settings-page">
          <div class="page-title compact">
            <div>
              <p class="eyebrow">Project</p>
              <h1>Settings</h1>
            </div>
          </div>
          <section class="settings-section">
            <div class="settings-section-header">
              <h2>Review policy</h2>
              <p>Main branch protection used before pull requests are merged.</p>
            </div>
            <form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings")}">
              <label class="settings-row">
                <span>Required approvals</span>
                <input name="required_approvals" type="number" min="0" value="${protection?.required_approvals ?? 1}" ${ctx.ws.role === "admin" ? "" : "disabled"}>
              </label>
              <div class="settings-row">
                <span>Document format</span>
                <strong>${escapeHtml(ctx.ws.defaultMdFormat)}</strong>
              </div>
              ${ctx.ws.role === "admin" ? `<div class="settings-actions"><button class="button primary" type="submit">Save settings</button></div>` : ""}
            </form>
          </section>
          ${labelSettingsSection(ctx, labels)}
          ${milestoneSettingsSection(ctx, milestones)}
          <section class="settings-section">
            <div class="settings-section-header">
              <h2>Access</h2>
              <p>Grant repository access to users and agents.</p>
            </div>
            ${
              ctx.ws.role === "admin"
                ? `<form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/access")}" data-testid="settings-access">
                    <label class="settings-row">
                      <span>Username</span>
                      <input name="username" data-testid="settings-access-username" required>
                    </label>
                    <label class="settings-row">
                      <span>Role</span>
                      <select name="role" data-testid="settings-access-role">
                        <option value="write">Write</option>
                        <option value="read">Read</option>
                        <option value="admin">Admin</option>
                      </select>
                    </label>
                    <div class="settings-actions">
                      <button class="button primary" type="submit" data-testid="settings-access-submit">Grant access</button>
                      ${accessUpdated ? `<p class="muted" data-testid="settings-access-saved">${escapeHtml(accessUpdated)}</p>` : ""}
                    </div>
                  </form>`
                : `<p class="muted">Only project admins can grant access.</p>`
            }
          </section>
        </div>
      `,
    }),
  );
});

web.post("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const approvals = Number(stringField((await c.req.parseBody()).required_approvals) ?? "1");
  const current = await ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main");
  if (current) await ctx.fj.updateBranchProtection(ctx.owner, ctx.repo, "main", { required_approvals: approvals });
  else await ctx.fj.createBranchProtection(ctx.owner, ctx.repo, { branch_name: "main", required_approvals: approvals });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/labels", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const name = stringField(form.name);
  const color = (stringField(form.color) ?? "").replace(/^#/, "");
  const description = textField(form.description) ?? "";
  const exclusive = stringField(form.exclusive) === "on";
  if (!name) return badRequestPage(ctx.user, "Label name is required.");
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return badRequestPage(ctx.user, "Label color must be six hex digits.");
  await ctx.fj.createLabel(ctx.owner, ctx.repo, { name, color, description, exclusive });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/milestones", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const description = textField(form.description) ?? "";
  if (!title) return badRequestPage(ctx.user, "Milestone title is required.");
  await ctx.fj.createMilestone(ctx.owner, ctx.repo, { title, description });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/access", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);

  const body = await c.req.parseBody();
  const username = stringField(body.username)?.trim();
  const role = stringField(body.role)?.trim();
  if (!username || !role || !(ROLES as readonly string[]).includes(role)) {
    return htmlResponse(pageShell({ title: "Bad request", body: `<main class="auth-page"><p>Invalid access update.</p></main>` }), 400);
  }

  await setWorkspaceMember({
    forgejo: c.get("fjAdmin"),
    owner: ctx.owner,
    repo: ctx.repo,
    username,
    role: role as Role,
  });
  invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`${username} · ${role}`)}`);
});

interface WebCtx {
  owner: string;
  repo: string;
  user: string;
  fj: Forgejo;
  ws: WorkspaceContext;
  db: Database.Database;
}

type WebRepoResult = { ok: true } & WebCtx | { ok: false; response: Response };

async function resolveWebAuth(c: Context<AppEnv>) {
  const auth = await resolveAuth(c);
  if (!auth) return null;
  c.set("user", auth.user);
  c.set("forgejoToken", auth.forgejoToken);
  c.set("fjUser", new Forgejo({ baseUrl: c.get("config").forgejoUrl, token: auth.forgejoToken }));
  return auth;
}

async function resolveWebRepo(c: Context<AppEnv>): Promise<WebRepoResult> {
  const auth = await resolveWebAuth(c);
  if (!auth) return { ok: false, response: redirect("/login") };
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const config = c.get("config");
  if (!owner || !repo) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  if (owner !== config.forgejoOwner) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const fj = new Forgejo({ baseUrl: config.forgejoUrl, token: auth.forgejoToken });
  const role = await fj.getRepoPermission(owner, repo, auth.user.username);
  if (role === "none") {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const topics = await fj.listRepoTopics(owner, repo);
  if (!topics.some(isFormatTopic)) {
    return { ok: false, response: await notFoundPage(auth.user.username, "Repository not found") };
  }
  const defaultMdFormat = documentFormatFromTopics(topics);
  const ws: WorkspaceContext = { slug: repo, role, defaultMdFormat };
  c.set("workspace", ws);
  c.set("repoCtx", { fj, owner, repo });
  return { ok: true, owner, repo, user: auth.user.username, fj, ws, db: c.get("db") };
}

async function configReposForUser(c: Context<AppEnv>) {
  const config = c.get("config");
  const userFj = c.get("fjUser");
  const repos = await userFj.listUserRepos(config.forgejoOwner, { limit: 100 });
  return repos
    .filter((repo) => (repo.topics ?? []).some(isFormatTopic))
    .map((repo) => ({
      name: repo.name,
      description: repo.description ?? "",
      role: roleFromPermissions(repo.permissions),
    }))
    .filter((repo) => repo.role !== "none");
}

function roleFromPermissions(p: { admin?: boolean; push?: boolean; pull?: boolean } | undefined): Role | "none" {
  if (!p) return "none";
  if (p.admin) return "admin";
  if (p.push) return "write";
  if (p.pull) return "read";
  return "none";
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

function filePreview(ctx: WebCtx, branch: string, rel: string, kind: FileKind, content: string | null): string {
  const rawHref = rawFileHref(ctx.owner, ctx.repo, branch, rel);
  if (kind === "markdown") {
    return `<article class="document cf-theme-scope" data-testid="file-preview-markdown">
      ${markdownSurface(ctx, content ?? "")}
    </article>`;
  }
  if (kind === "text") {
    return `<article class="file-preview file-preview-embed" data-testid="file-preview-text">
      <object data-testid="file-preview-text-raw" data="${escapeAttr(rawHref)}" type="text/plain">
        <p>Text preview is not available in this browser. <a class="inline-link" href="${escapeAttr(rawHref)}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "pdf") {
    return `<article class="file-preview file-preview-embed">
      <object data-testid="file-preview-pdf" data="${escapeAttr(rawHref)}" type="application/pdf">
        <p>PDF preview is not available in this browser. <a class="inline-link" href="${escapeAttr(rawHref)}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "image") {
    return `<article class="file-preview file-preview-image">
      <img data-testid="file-preview-image" src="${escapeAttr(rawHref)}" alt="${escapeAttr(rel)}">
    </article>`;
  }
  return `<article class="file-preview file-preview-fallback" data-testid="file-preview-raw">
    <p>No inline preview is available for this file type.</p>
    <a class="button" href="${escapeAttr(rawHref)}">Open raw file</a>
  </article>`;
}

function textEditPage(ctx: WebCtx, branch: string, rel: string, content: string): string {
  return `<section class="edit-page text-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><p class="eyebrow">Edit text on branch</p><h1>${escapeHtml(rel)}</h1></div>
      <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}">Cancel</a>
    </div>
    <form class="compose-form" data-testid="text-edit-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/_edit")}">
      <input type="hidden" name="old_path" value="${escapeAttr(rel)}">
      <label>Branch <input name="branch" value="${escapeAttr(branch)}" required></label>
      <label>Path <input name="path" value="${escapeAttr(rel)}" required></label>
      <textarea class="text-file-editor" name="content" spellcheck="false">${escapeHtml(content)}</textarea>
      <div class="form-actions">
        <button class="button primary" type="submit">Save</button>
      </div>
    </form>
  </section>`;
}

type MarkdownSurface = "document" | "thread" | "diff";

function coflatSurfaceClass(surface: MarkdownSurface): string {
  if (surface === "thread") return "cf-reader-compact";
  if (surface === "diff") return "cf-rich-diff cf-reader-compact";
  return "";
}

async function renderMarkdown(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface } = {},
): Promise<string> {
  const { body } = parseFrontmatterYaml(source);
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) {
    return coflatReaderIsland(ctx, source, opts);
  }
  return ctx.fj.renderMarkdown(ctx.owner, ctx.repo, body);
}

async function renderMarkdownSurface(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface } = {},
): Promise<string> {
  const rendered = await renderMarkdown(ctx, source, opts);
  return markdownSurface(ctx, rendered, opts.surface ?? "document");
}

function coflatReaderIsland(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface },
): string {
  const payload = {
    source,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: opts.branch ?? "main",
    path: opts.documentPath ?? "",
  };
  const className = ["cf-reader", "cf-doc-surface", "cf-doc-flow", "coflat-reader-island", coflatSurfaceClass(opts.surface ?? "document")]
    .filter(Boolean)
    .join(" ");
  return `<div class="${escapeAttr(className)}" data-reader-branch="${escapeAttr(payload.branch)}"><script type="application/json">${jsonScript(payload)}</script></div>`;
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

async function pullForParam(ctx: WebCtx, raw: string | undefined): Promise<ForgejoPull | null> {
  const number = positiveInt(raw);
  if (!number) return null;
  return ctx.fj.getPull(ctx.owner, ctx.repo, number);
}

async function pullFiles(ctx: WebCtx, number: number) {
  const [metas, unified] = await Promise.all([
    ctx.fj.listPullFiles(ctx.owner, ctx.repo, number),
    ctx.fj.getPullDiff(ctx.owner, ctx.repo, number),
  ]);
  const sections = splitDiffByFile(unified);
  return metas.map((meta) => ({
    path: meta.filename,
    status: meta.status,
    additions: meta.additions,
    deletions: meta.deletions,
    patch: sections.get(meta.filename) ?? "",
  }));
}

type DiffMode = "source" | "rich";
type DiffShape = "unified" | "split" | "after";

interface PrFileView {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

interface PrFileVersions {
  base: string;
  head: string;
}

interface WebLineComment {
  id: number;
  line: number | null;
  side: Side;
  body: string;
  author: string;
  createdAt: number;
  outdated: boolean;
}

function parseDiffMode(value: string | undefined): DiffMode {
  return value === "source" ? "source" : "rich";
}

function parseDiffShape(value: string | undefined, mode: DiffMode): DiffShape {
  const shape = value === "unified" || value === "split" || value === "after" ? value : "after";
  return mode === "rich" && shape === "unified" ? "after" : shape;
}

async function prFileVersions(ctx: WebCtx, pull: ForgejoPull, filePath: string): Promise<PrFileVersions> {
  const read = (ref: string) =>
    ctx.fj.getRawFile(ctx.owner, ctx.repo, ref, filePath).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return "";
      throw err;
    });
  const [base, head] = await Promise.all([read(pull.base.ref), read(pull.head.ref)]);
  return { base, head };
}

async function renderPrFileView(
  ctx: WebCtx,
  pull: ForgejoPull,
  file: PrFileView,
  mode: DiffMode,
  shape: DiffShape,
  versions: PrFileVersions | null,
  comments: readonly WebLineComment[],
): Promise<string> {
  if (mode === "source" && shape === "unified") {
    return `<div data-testid="diff-pane-unified">${renderPatch(file.patch)}</div>`;
  }
  const nextVersions = versions ?? (await prFileVersions(ctx, pull, file.path));
  const changed = changedLines(file.patch);
  const commentable = commentableLines(file.patch);
  const commentForm = commentFormOptions(ctx, pull, file.path, mode, shape);
  if (mode === "source" && shape === "split") {
    return `<div data-testid="diff-pane-split" class="source-split">
      ${sourcePane("Base", nextVersions.base, "base", changed.deleted, commentable.base, comments, commentForm)}
      ${sourcePane("Head", nextVersions.head, "head", changed.added, commentable.head, comments, commentForm)}
    </div>`;
  }
  if (mode === "source") {
    return `<div data-testid="diff-pane-after" class="source-after">${sourcePane("After", nextVersions.head, "head", changed.added, commentable.head, comments, commentForm)}</div>`;
  }
  if (shape === "split") {
    const [base, head] = await Promise.all([
      renderMarkdownSurface(ctx, nextVersions.base, {
        branch: pull.base.ref,
        documentPath: file.path,
        surface: "diff",
      }),
      renderMarkdownSurface(ctx, nextVersions.head, {
        branch: pull.head.ref,
        documentPath: file.path,
        surface: "diff",
      }),
    ]);
    return `<div data-testid="diff-pane-split" class="rich-split cf-theme-scope">
      <section><h3>Base</h3>${base}</section>
      <section><h3>Head</h3>${head}</section>
    </div>`;
  }
  const head = await renderMarkdownSurface(ctx, nextVersions.head, {
    branch: pull.head.ref,
    documentPath: file.path,
    surface: "diff",
  });
  return `<div data-testid="diff-pane-after" class="rich-after cf-theme-scope">${head}</div>`;
}

function markdownSurface(ctx: WebCtx, rendered: string, surface: MarkdownSurface = "document"): string {
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) return rendered;
  const className = ["markdown-body", "cf-reader", "cf-doc-surface", "cf-doc-flow", coflatSurfaceClass(surface)]
    .filter(Boolean)
    .join(" ");
  return `<div class="${className}">${rendered}</div>`;
}

function diffModeControls(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape): string {
  const href = (nextMode: DiffMode, nextShape: DiffShape) => prFilesHref(ctx, prNumber, filePath, nextMode, nextShape);
  const modeLink = (id: DiffMode, label: string) =>
    `<a data-testid="view-mode-${id}" class="${mode === id ? "active" : ""}" href="${href(id, parseDiffShape(shape, id))}">${label}</a>`;
  const shapeLink = (id: DiffShape, label: string) => {
    if (mode === "rich" && id === "unified") return `<span data-testid="view-shape-unified" class="disabled">Unified</span>`;
    return `<a data-testid="view-shape-${id}" class="${shape === id ? "active" : ""}" href="${href(mode, id)}">${label}</a>`;
  };
  return `<div class="diff-controls">
    <div><span>View:</span>${modeLink("source", "Source")}${modeLink("rich", "Rich")}</div>
    <div><span>Shape:</span>${shapeLink("unified", "Unified")}${shapeLink("split", "Side-by-side")}${shapeLink("after", "After only")}</div>
  </div>`;
}

function prFilesHref(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape): string {
  return `${repoHref(ctx.owner, ctx.repo, `/pulls/${prNumber}/files`)}?file=${encodeURIComponent(filePath)}&mode=${mode}&shape=${shape}`;
}

function sourcePane(
  title: string,
  source: string,
  side: Side,
  marked: ReadonlySet<number>,
  commentable: ReadonlySet<number>,
  comments: readonly WebLineComment[],
  form: LineCommentFormOptions | null,
): string {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `<section><h3>${escapeHtml(title)}</h3><table class="source-lines"><tbody>${lines
    .map((line, index) => {
      const lineNo = index + 1;
      const lineComments = comments.filter((comment) => comment.side === side && comment.line === lineNo);
      const composer = form && commentable.has(lineNo) ? lineCommentComposer(form, side, lineNo) : "";
      return `<tr class="${marked.has(lineNo) ? "marked" : ""}" data-testid="source-line-${side}-${lineNo}">
        <td class="line-action">${composer}</td>
        <td>${lineNo}</td>
        <td><pre>${escapeHtml(line)}</pre></td>
      </tr>${lineComments.map(renderInlineComment).join("")}`;
    })
    .join("")}</tbody></table></section>`;
}

interface LineCommentFormOptions {
  action: string;
  path: string;
  mode: DiffMode;
  shape: DiffShape;
}

function commentFormOptions(
  ctx: WebCtx,
  pull: ForgejoPull,
  filePath: string,
  mode: DiffMode,
  shape: DiffShape,
): LineCommentFormOptions | null {
  if (ctx.ws.role === "read" || pull.user?.login === ctx.user || pull.state === "closed") return null;
  return {
    action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/comments`),
    path: filePath,
    mode,
    shape,
  };
}

function lineCommentComposer(form: LineCommentFormOptions, side: Side, line: number): string {
  return `<details class="line-composer">
    <summary aria-label="Comment on line ${line}">+</summary>
    <form method="post" action="${form.action}">
      <input type="hidden" name="path" value="${escapeAttr(form.path)}">
      <input type="hidden" name="side" value="${side}">
      <input type="hidden" name="line" value="${line}">
      <input type="hidden" name="mode" value="${form.mode}">
      <input type="hidden" name="shape" value="${form.shape}">
      <textarea name="body" required></textarea>
      <button type="submit">Comment</button>
    </form>
  </details>`;
}

function renderInlineComment(comment: WebLineComment): string {
  return `<tr class="line-comment-row" data-testid="line-comment-${comment.id}">
    <td></td>
    <td colspan="2">
      <div class="line-comment ${comment.outdated ? "outdated" : ""}">
        <strong>${escapeHtml(comment.author)}</strong>
        <span>${comment.outdated ? "outdated" : formatDate(comment.createdAt)}</span>
        <p>${escapeHtml(comment.body)}</p>
      </div>
    </td>
  </tr>`;
}

function mapLineComments(ctx: WebCtx, file: PrFileView, comments: readonly ForgejoPullReviewComment[]): WebLineComment[] {
  return comments
    .filter((comment) => comment.path === file.path)
    .map((comment) => {
      const pos = comment.position ?? comment.original_position;
      const mapped = pos === null ? null : positionToFileLine(file.patch, pos);
      return {
        id: comment.id,
        line: mapped?.line ?? null,
        side: mapped?.side ?? (file.status === "deleted" ? "base" : "head"),
        body: comment.body,
        author: displayLogin(ctx.owner, comment.user?.login),
        createdAt: Date.parse(comment.created_at) || 0,
        outdated: comment.position === null,
      };
    });
}

function renderFileCommentSummary(comments: readonly WebLineComment[]): string {
  if (comments.length === 0) return `<div class="file-comments empty">No line comments.</div>`;
  return `<div class="file-comments">${comments
    .map(
      (comment) => `<div class="file-comment ${comment.outdated ? "outdated" : ""}">
        <div><strong>${escapeHtml(comment.author)}</strong><span>${comment.side}:${comment.line ?? "outdated"}</span></div>
        <p>${escapeHtml(comment.body)}</p>
      </div>`,
    )
    .join("")}</div>`;
}

function pullStateForm(ctx: WebCtx, pull: ForgejoPull): string {
  if (ctx.ws.role === "read" || pull.merged) return "";
  const nextState = pull.state === "open" ? "closed" : "open";
  const label = pull.state === "open" ? "Close pull request" : "Reopen pull request";
  return `<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/state`)}">
    <input type="hidden" name="state" value="${nextState}">
    <button class="button" type="submit" data-testid="pull-toggle-state">${label}</button>
  </form>`;
}

function issueEditForm(ctx: WebCtx, issue: ForgejoIssue): string {
  if (ctx.ws.role === "read") return "";
  return `<details class="comment-form" data-testid="issue-edit-form">
    <summary>Edit issue title and description</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/edit`)}">
      <label>Title <input name="title" value="${escapeAttr(issue.title)}" required></label>
      <label>Description <textarea name="body">${escapeHtml(issue.body ?? "")}</textarea></label>
      <button class="button primary" type="submit">Save issue</button>
    </form>
  </details>`;
}

function issueRelationsPanel(
  ctx: WebCtx,
  issue: ForgejoIssue,
  dependencies: readonly ForgejoIssue[],
  blocks: readonly ForgejoIssue[],
): string {
  return `<section class="relation-panel" data-testid="issue-relations">
    <h2>Issue relations</h2>
    <div class="relation-grid">
      ${issueRelationList(ctx, issue, "depends_on", "Depends on", dependencies)}
      ${issueRelationList(ctx, issue, "blocks", "Blocks", blocks)}
    </div>
  </section>`;
}

function issueRelationList(
  ctx: WebCtx,
  issue: ForgejoIssue,
  relation: "depends_on" | "blocks",
  title: string,
  issues: readonly ForgejoIssue[],
): string {
  const rows = issues
    .map(
      (item) => `<div class="relation-row">
        <a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/issues/${item.number}`)}">#${item.number} ${escapeHtml(item.title)}</a>
        <span class="state ${item.state}">${escapeHtml(item.state)}</span>
        ${
          ctx.ws.role === "read"
            ? ""
            : `<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/dependencies/delete`)}">
                <input type="hidden" name="relation" value="${relation}">
                <input type="hidden" name="index" value="${item.number}">
                <button class="button" type="submit">Remove</button>
              </form>`
        }
      </div>`,
    )
    .join("");
  const form =
    ctx.ws.role === "read"
      ? ""
      : `<form class="inline-add-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/dependencies`)}">
          <input type="hidden" name="relation" value="${relation}">
          <input name="index" inputmode="numeric" pattern="[0-9]+" placeholder="Issue #" aria-label="${escapeAttr(title)} issue number">
          <button class="button" type="submit">Add</button>
        </form>`;
  return `<section class="relation-card">
    <h3>${escapeHtml(title)}</h3>
    ${rows || `<div class="empty compact-empty">None.</div>`}
    ${form}
  </section>`;
}

function pullEditForm(ctx: WebCtx, pull: ForgejoPull): string {
  if (ctx.ws.role === "read" || pull.state === "closed") return "";
  return `<details class="comment-form" data-testid="pull-edit-form">
    <summary>Edit pull request title and description</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/edit`)}">
      <label>Title <input name="title" value="${escapeAttr(pull.title)}" required></label>
      <label>Description <textarea name="body">${escapeHtml(pull.body ?? "")}</textarea></label>
      <button class="button primary" type="submit">Save pull request</button>
    </form>
  </details>`;
}

function labelEditForm(opts: {
  testId: string;
  action: string;
  disabled: boolean;
  labels: readonly ForgejoLabel[];
  currentLabels: readonly ForgejoLabel[];
}): string {
  if (opts.disabled) return "";
  const currentIds = new Set(opts.currentLabels.map((label) => label.id));
  const rows = opts.labels.map((label) => {
    const checked = currentIds.has(label.id) ? " checked" : "";
    const disabled = label.is_archived && !currentIds.has(label.id) ? " disabled" : "";
    const scope = labelScope(label);
    const flags = [
      scope ? `scope:${scope}` : "",
      label.is_archived ? "archived" : "",
    ].filter(Boolean).join(" ");
    return `<label class="checkbox-row">
      <input type="checkbox" name="labels" value="${label.id}"${checked}${disabled}>
      <span>${escapeHtml(label.name)}${flags ? ` <small>${escapeHtml(flags)}</small>` : ""}</span>
    </label>`;
  });
  return `<details class="comment-form" data-testid="${opts.testId}">
    <summary>Edit labels</summary>
    <form method="post" action="${opts.action}">
      <div class="checkbox-list">${rows.join("") || `<div class="empty">No labels.</div>`}</div>
      <button class="button primary" type="submit">Save labels</button>
    </form>
  </details>`;
}

function reviewRequestPanel(ctx: WebCtx, pull: ForgejoPull, availableReviewers: readonly { login: string }[]): string {
  const requested = pull.requested_reviewers ?? [];
  const requestedTeams = pull.requested_reviewers_teams ?? [];
  const requestedLogins = new Set(requested.map((reviewer) => reviewer.login));
  const available = availableReviewers.filter((reviewer) => !requestedLogins.has(reviewer.login));
  const requestedHtml =
    requested.length === 0 && requestedTeams.length === 0
      ? `<div class="empty">No requested reviewers.</div>`
      : `<div class="label-chips">
          ${requested.map((reviewer) => reviewerRequestChip(ctx, pull, reviewer.login)).join("")}
          ${requestedTeams.map((team) => `<span class="meta-pill">${escapeHtml(team.username ?? team.name)}</span>`).join("")}
        </div>`;
  const requestForm =
    ctx.ws.role === "read" || pull.state === "closed"
      ? ""
      : `<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests`)}">
          <label>Request reviewers
            <select name="reviewers" multiple size="${Math.min(Math.max(available.length, 2), 6)}">
              ${available.map((reviewer) => `<option value="${escapeAttr(reviewer.login)}">${escapeHtml(displayLogin(ctx.owner, reviewer.login))}</option>`).join("")}
            </select>
          </label>
          <button class="button" type="submit">Request review</button>
        </form>`;
  return `<section class="comment-form" data-testid="pull-review-requests">
    <h2>Requested reviewers</h2>
    ${requestedHtml}
    ${requestForm}
  </section>`;
}

function reviewerRequestChip(ctx: WebCtx, pull: ForgejoPull, reviewer: string): string {
  const remove =
    ctx.ws.role === "read" || pull.state === "closed"
      ? ""
      : `<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests/delete`)}">
          <input type="hidden" name="reviewer" value="${escapeAttr(reviewer)}">
          <button class="button" type="submit">Remove</button>
        </form>`;
  return `<span class="meta-pill">${escapeHtml(displayLogin(ctx.owner, reviewer))}${remove}</span>`;
}

function labelScope(label: ForgejoLabel): string | null {
  if (!label.exclusive) return null;
  const slash = label.name.lastIndexOf("/");
  return slash > 0 ? label.name.slice(0, slash) : null;
}

type WebTimelineItem =
  | { kind: "comment"; ts: number; number: number; comment: ForgejoIssueComment }
  | { kind: "event"; ts: number; event: ForgejoTimelineEvent }
  | { kind: "review"; ts: number; review: ForgejoReview }
  | { kind: "line-comment"; ts: number; number: number; comment: ForgejoPullReviewComment }
  | { kind: "commit"; ts: number; commit: ForgejoCommit };

async function renderIssueTimeline(
  ctx: WebCtx,
  number: number,
  comments: readonly ForgejoIssueComment[],
  timeline: readonly ForgejoTimelineEvent[],
): Promise<string> {
  const items: WebTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, ts: parseDateMs(comment.created_at), number, comment })),
    ...timeline
      .filter((event) => event.type !== "comment")
      .map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event })),
  ].sort(compareTimelineItems);
  return (await Promise.all(items.map((item) => renderTimelineItem(ctx, item)))).join("");
}

async function renderPullTimeline(
  ctx: WebCtx,
  number: number,
  reviews: readonly ForgejoReview[],
  comments: readonly ForgejoPullReviewComment[],
  timeline: readonly ForgejoTimelineEvent[],
  commits: readonly ForgejoCommit[],
): Promise<string> {
  const items: WebTimelineItem[] = [
    ...timeline
      .filter((event) => event.type !== "comment" && event.type !== "pull_push" && event.type !== "review")
      .map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event })),
    ...reviews
      .filter((review) => review.state !== "PENDING" && (review.state !== "COMMENT" || Boolean(review.body?.trim())))
      .map((review) => ({ kind: "review" as const, ts: parseDateMs(review.submitted_at), review })),
    ...comments.map((comment) => ({
      kind: "line-comment" as const,
      ts: parseDateMs(comment.created_at),
      number,
      comment,
    })),
    ...commits.map((commit) => ({ kind: "commit" as const, ts: commitDateMs(commit), commit })),
  ].sort(compareTimelineItems);
  return (await Promise.all(items.map((item) => renderTimelineItem(ctx, item)))).join("");
}

function issueCommentActions(ctx: WebCtx, number: number, comment: ForgejoIssueComment): string {
  if (ctx.ws.role === "read") return "";
  return `<details class="comment-actions" data-testid="issue-comment-actions">
    <summary>Comment actions</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/edit`)}">
      <textarea name="body" required>${escapeHtml(comment.body)}</textarea>
      <button class="button primary" type="submit">Save comment</button>
    </form>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/delete`)}">
      <button class="button danger" type="submit">Delete comment</button>
    </form>
  </details>`;
}

function pullCommentActions(ctx: WebCtx, number: number, comment: ForgejoPullReviewComment): string {
  if (ctx.ws.role === "read") return "";
  return `<details class="comment-actions" data-testid="pull-comment-actions">
    <summary>Comment actions</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/edit`)}">
      <textarea name="body" required>${escapeHtml(comment.body)}</textarea>
      <button class="button primary" type="submit">Save comment</button>
    </form>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/delete`)}">
      <input type="hidden" name="review_id" value="${comment.pull_request_review_id}">
      <button class="button danger" type="submit">Delete comment</button>
    </form>
  </details>`;
}

async function renderTimelineItem(ctx: WebCtx, item: WebTimelineItem): Promise<string> {
  if (item.kind === "comment") {
    const body = await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" });
    return `<div class="comment">
      <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, item.comment.user?.login))} - ${formatDate(item.comment.created_at)}</div>
      ${body}
      ${issueCommentActions(ctx, item.number, item.comment)}
    </div>`;
  }
  if (item.kind === "line-comment") {
    const body = await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" });
    return `<div class="comment">
      <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, item.comment.user?.login))} commented on ${escapeHtml(item.comment.path)} - ${formatDate(item.comment.created_at)}</div>
      ${body}
      ${pullCommentActions(ctx, item.number, item.comment)}
    </div>`;
  }
  if (item.kind === "review") {
    const label = reviewStateLabel(item.review.state);
    const body = item.review.body ? await renderMarkdownSurface(ctx, item.review.body, { surface: "thread" }) : "";
    return `<div class="timeline-event">
      <strong>${escapeHtml(displayLogin(ctx.owner, item.review.user?.login))}</strong>
      <span>${escapeHtml(label)}</span>
      <small>${formatDate(item.review.submitted_at)}</small>
      ${body}
    </div>`;
  }
  if (item.kind === "commit") {
    return `<div class="timeline-event">
      <strong>${escapeHtml(displayLogin(ctx.owner, item.commit.author?.login ?? item.commit.commit.author?.name))}</strong>
      <span>pushed commit <code>${escapeHtml(item.commit.sha.slice(0, 10))}</code></span>
      <small>${formatDate(commitDateMs(item.commit))}</small>
      <p>${escapeHtml(firstCommitLine(item.commit.commit.message))}</p>
    </div>`;
  }
  const description = webTimelineDescriptionHtml(item.event);
  if (!description) return "";
  return `<div class="timeline-event">
    ${item.event.user?.login ? `<strong>${escapeHtml(displayLogin(ctx.owner, item.event.user.login))}</strong>` : ""}
    <span>${description}</span>
    <small>${formatDate(item.event.created_at)}</small>
  </div>`;
}

function compareTimelineItems(a: WebTimelineItem, b: WebTimelineItem): number {
  return compareWebTimelineItems(a, b);
}

function parseDateMs(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  return Date.parse(value) || 0;
}

function commitDateMs(commit: ForgejoCommit): number {
  return parseDateMs(commit.commit.author?.date ?? commit.commit.committer?.date);
}

function firstCommitLine(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

function reviewStateLabel(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved these changes";
    case "REQUEST_CHANGES":
      return "requested changes";
    case "COMMENT":
      return "reviewed";
    default:
      return state.toLowerCase().replaceAll("_", " ");
  }
}

function splitDiffByFile(diff: string): Map<string, string> {
  return new Map(splitUnifiedDiff(diff).map((file) => [file.path, file.patch]));
}

function reviewForms(ctx: WebCtx, pull: ForgejoPull, redirectTo?: string): string {
  if (ctx.ws.role === "read" || pull.user?.login === ctx.user || pull.state === "closed") return "";
  return `
    <form class="review-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/reviews`)}">
      ${redirectTo ? `<input type="hidden" name="redirect_to" value="${escapeAttr(redirectTo)}">` : ""}
      <textarea name="body" placeholder="Leave a review comment"></textarea>
      <div class="toolbar-actions">
        <button class="button" name="event" value="COMMENT" type="submit">Comment</button>
        <button class="button" name="event" value="REQUEST_CHANGES" type="submit">Request changes</button>
        <button class="button primary" name="event" value="APPROVED" type="submit">Approve</button>
      </div>
    </form>
    ${
      ctx.ws.role === "admin"
        ? `<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/merge`)}"><button class="button primary" type="submit">Merge pull request</button></form>`
        : ""
    }
  `;
}

function renderPatch(patch: string): string {
  if (!patch) return `<pre class="patch empty">No textual diff.</pre>`;
  const rows = patchRows(patch)
    .map((row) => `<tr class="${row.kind}"><td class="sign">${escapeHtml(row.sign)}</td><td><pre>${escapeHtml(row.text)}</pre></td></tr>`)
    .join("");
  return `<table class="patch"><tbody>${rows}</tbody></table>`;
}

function repoPage(opts: {
  title: string;
  owner: string;
  repo: string;
  active: "files" | "issues" | "pulls" | "chat" | "notifications" | "activity" | "settings";
  user: string;
  ws: WorkspaceContext;
  body: string;
  readerAssets?: boolean;
}): string {
  return pageShell({
    title: opts.title,
    user: opts.user,
    readerAssets: opts.readerAssets,
    body: `
      ${globalHeader(opts.user)}
      <main class="repo-page">
        <header class="repo-header">
          <div>
            <h1><a href="${repoHref(opts.owner, opts.repo)}">${escapeHtml(opts.repo)}</a></h1>
          </div>
          <span class="role">${escapeHtml(opts.ws.role)}</span>
        </header>
        <nav class="repo-tabs">
          ${tab(opts, "files", "Files", "")}
          ${tab(opts, "issues", "Issues", "/issues")}
          ${tab(opts, "pulls", "Pull Requests", "/pulls")}
          ${tab(opts, "chat", "Chat", "/chat")}
          ${tab(opts, "notifications", "Notifications", "/notifications")}
          ${tab(opts, "activity", "Activity", "/activity")}
          ${tab(opts, "settings", "Settings", "/settings")}
        </nav>
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

function userPreferencesSection(user: string): string {
  return `<section class="settings-section" data-testid="settings-user-preferences">
    <div class="settings-section-header">
      <h2>User preferences</h2>
      <p>These settings follow your browser session and apply across projects.</p>
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

function userPreferencesScript(): string {
  return `<script src="/cosheaf-preferences.js" defer></script>`;
}

type WebListState = "open" | "closed" | "all";
type IssueListSort = "relevance" | "latest" | "oldest" | "recentupdate" | "leastupdate" | "mostcomment" | "leastcomment" | "nearduedate" | "farduedate";
type PullListSort = "oldest" | "recentupdate" | "recentclose" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";

interface IssueListFilters {
  state: WebListState;
  q: string;
  labels: string;
  milestones: string;
  createdBy: string;
  assignedBy: string;
  mentionedBy: string;
  sort: IssueListSort | "";
}

interface PullListFilters {
  state: WebListState;
  labels: number[];
  labelValue: string;
  milestone?: number;
  milestoneValue: string;
  author: string;
  sort: PullListSort | "";
}

const ISSUE_SORT_OPTIONS: Array<{ value: IssueListSort; label: string }> = [
  { value: "latest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "recentupdate", label: "Recently updated" },
  { value: "leastupdate", label: "Least recently updated" },
  { value: "mostcomment", label: "Most commented" },
  { value: "leastcomment", label: "Least commented" },
  { value: "nearduedate", label: "Nearest due date" },
  { value: "farduedate", label: "Farthest due date" },
];

const PULL_SORT_OPTIONS: Array<{ value: PullListSort; label: string }> = [
  { value: "recentupdate", label: "Recently updated" },
  { value: "oldest", label: "Oldest" },
  { value: "recentclose", label: "Recently closed" },
  { value: "leastupdate", label: "Least recently updated" },
  { value: "mostcomment", label: "Most commented" },
  { value: "leastcomment", label: "Least commented" },
  { value: "priority", label: "Priority" },
];

function parseIssueListFilters(c: Context<AppEnv>): IssueListFilters {
  const sort = queryText(c, "sort");
  return {
    state: parseListState(c.req.query("state")),
    q: queryText(c, "q"),
    labels: queryText(c, "labels"),
    milestones: queryText(c, "milestones"),
    createdBy: queryText(c, "created_by"),
    assignedBy: queryText(c, "assigned_by"),
    mentionedBy: queryText(c, "mentioned_by"),
    sort: ISSUE_SORT_OPTIONS.some((option) => option.value === sort) ? sort as IssueListSort : "",
  };
}

function parsePullListFilters(c: Context<AppEnv>): PullListFilters {
  const labelValue = queryText(c, "labels");
  const milestoneValue = queryText(c, "milestone");
  const sort = queryText(c, "sort");
  return {
    state: parseListState(c.req.query("state")),
    labels: parsePositiveIntList(labelValue),
    labelValue,
    milestone: parsePositiveInt(milestoneValue),
    milestoneValue,
    author: queryText(c, "author"),
    sort: PULL_SORT_OPTIONS.some((option) => option.value === sort) ? sort as PullListSort : "",
  };
}

function parseListState(value: string | undefined): WebListState {
  return value === "closed" || value === "all" ? value : "open";
}

function queryText(c: Context<AppEnv>, name: string): string {
  return c.req.query(name)?.trim() ?? "";
}

function parsePositiveInt(value: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parsePositiveIntList(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function issueCreatePage(
  ctx: WebCtx,
  labels: readonly ForgejoLabel[],
  values: { title?: string; body?: string; labelIds?: number[]; error?: string } = {},
): string {
  const selectedIds = new Set(values.labelIds ?? []);
  return `
    <div class="form-page">
      <div class="page-title compact">
        <div>
          <p class="eyebrow">Issues</p>
          <h1>New issue</h1>
        </div>
        <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/issues")}">Cancel</a>
      </div>
      ${values.error ? `<div class="form-error" role="alert">${escapeHtml(values.error)}</div>` : ""}
      <form class="compose-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/issues/new")}" data-testid="issue-create-form">
        <label>Title
          <input name="title" value="${escapeAttr(values.title ?? "")}" required autofocus data-testid="issue-create-title">
        </label>
        <label>Description
          <textarea name="body" data-testid="issue-create-body">${escapeHtml(values.body ?? "")}</textarea>
        </label>
        ${labelCheckboxes(labels, selectedIds)}
        <div class="form-actions">
          <button class="button primary" type="submit" data-testid="issue-create-submit">Create issue</button>
        </div>
      </form>
    </div>
  `;
}

function pullCreatePage(
  ctx: WebCtx,
  branches: readonly ForgejoBranch[],
  values: { head?: string | null; base?: string | null; title?: string; body?: string; error?: string } = {},
): string {
  const base = values.base ?? "main";
  const head = values.head ?? branchAfter(branches, base);
  return `
    <div class="form-page">
      <div class="page-title compact">
        <div>
          <p class="eyebrow">Pull requests</p>
          <h1>New pull request</h1>
        </div>
        <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/pulls")}">Cancel</a>
      </div>
      ${values.error ? `<div class="form-error" role="alert">${escapeHtml(values.error)}</div>` : ""}
      <form class="compose-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/pulls/new")}" data-testid="pull-create-form">
        <div class="branch-compare">
          <label>Base
            <select name="base" required data-testid="pull-create-base">
              ${branchOptions(branches, base)}
            </select>
          </label>
          <label>Head
            <select name="head" required data-testid="pull-create-head">
              ${branchOptions(branches, head)}
            </select>
          </label>
        </div>
        <label>Title
          <input name="title" value="${escapeAttr(values.title ?? "")}" required data-testid="pull-create-title">
        </label>
        <label>Description
          <textarea name="body" data-testid="pull-create-body">${escapeHtml(values.body ?? "")}</textarea>
        </label>
        <div class="form-actions">
          <button class="button primary" type="submit" data-testid="pull-create-submit">Create pull request</button>
        </div>
      </form>
    </div>
  `;
}

function labelCheckboxes(labels: readonly ForgejoLabel[], selectedIds: ReadonlySet<number>): string {
  if (labels.length === 0) return "";
  return `<fieldset class="checkbox-list">
    <legend>Labels</legend>
    ${labels
      .map(
        (label) => `<label>
          <input type="checkbox" name="labels" value="${label.id}"${selectedIds.has(label.id) ? " checked" : ""}>
          ${labelChip(label)}
        </label>`,
      )
      .join("")}
  </fieldset>`;
}

function branchOptions(branches: readonly ForgejoBranch[], selectedBranch: string | null | undefined): string {
  return branches
    .map((branch) => `<option value="${escapeAttr(branch.name)}"${selected(selectedBranch ?? "", branch.name)}>${escapeHtml(branch.name)}</option>`)
    .join("");
}

function branchAfter(branches: readonly ForgejoBranch[], base: string): string {
  return branches.find((branch) => branch.name !== base)?.name ?? branches[0]?.name ?? "";
}

function branchCreatePanel(ctx: WebCtx, branches: readonly ForgejoBranch[]): string {
  if (ctx.ws.role === "read") return "";
  return `<form class="filter-panel" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/new")}" data-testid="branch-create-form">
    <label>New branch
      <input name="name" placeholder="user/${escapeAttr(ctx.user)}/work" required data-testid="branch-create-name">
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

function branchList(ctx: WebCtx, branches: readonly ForgejoBranch[], openHeads: ReadonlySet<string>): string {
  return `<div class="list">${branches
    .map((branch) => {
      const hasOpenPr = openHeads.has(branch.name);
      return `<div class="list-row branch-row">
        <a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch.name)}"><strong>${escapeHtml(branch.name)}</strong></a>
        <span>${escapeHtml(branch.commit.id.slice(0, 10))}${hasOpenPr ? ` <span class="meta-pill">open PR</span>` : ""}</span>
        ${
          ctx.ws.role === "read" || branch.name === "main" || hasOpenPr
            ? "<span></span>"
            : `<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/delete")}">
                <input type="hidden" name="name" value="${escapeAttr(branch.name)}">
                <button class="button danger" type="submit" data-testid="branch-delete">Delete</button>
              </form>`
        }
      </div>`;
    })
    .join("") || `<div class="empty">No branches.</div>`}</div>`;
}

function notificationsPage(ctx: WebCtx, threads: readonly ForgejoNotificationThread[]): string {
  return `
    <div class="page-title compact">
      <div><p class="eyebrow">Unread</p><h1>Notifications</h1></div>
      ${
        threads.length === 0
          ? ""
          : `<form method="post" action="${repoHref(ctx.owner, ctx.repo, "/notifications/read-all")}">
              <button class="button" type="submit" data-testid="notifications-read-all">Mark all read</button>
            </form>`
      }
    </div>
    <div class="list" data-testid="notification-list">
      ${threads.map((thread) => notificationRow(ctx, thread)).join("") || `<div class="empty">No unread notifications.</div>`}
    </div>
  `;
}

function notificationRow(ctx: WebCtx, thread: ForgejoNotificationThread): string {
  const href = notificationHref(ctx, thread);
  const kind = thread.subject.type === "Pull" ? "Pull request" : thread.subject.type;
  return `<div class="list-row">
    <a class="inline-link" href="${href}"><strong>${escapeHtml(thread.subject.title)}</strong></a>
    <span>${escapeHtml(kind)} - ${formatDate(thread.updated_at)}</span>
    <form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/notifications/${thread.id}/read`)}">
      <button class="button" type="submit">Mark read</button>
    </form>
  </div>`;
}

function notificationHref(ctx: WebCtx, thread: ForgejoNotificationThread): string {
  const match = thread.subject.url.match(/\/(?:issues|pulls)\/(\d+)(?:$|[?#])/);
  const number = match ? Number(match[1]) : null;
  if (!number) return repoHref(ctx.owner, ctx.repo, "/notifications");
  return thread.subject.type === "Pull"
    ? repoHref(ctx.owner, ctx.repo, `/pulls/${number}`)
    : repoHref(ctx.owner, ctx.repo, `/issues/${number}`);
}

function labelSettingsSection(ctx: WebCtx, labels: readonly ForgejoLabel[]): string {
  return `<section class="settings-section" data-testid="settings-labels">
    <div class="settings-section-header">
      <h2>Labels</h2>
      <p>Labels are repository labels from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="label-chips">${labels.map(labelChip).join("") || `<span class="muted">No labels.</span>`}</div>
      ${
        ctx.ws.role === "admin"
          ? `<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/labels")}">
              <label class="settings-row"><span>Name</span><input name="name" required data-testid="settings-label-name"></label>
              <label class="settings-row"><span>Color</span><input name="color" value="71717a" pattern="[0-9a-fA-F]{6}" required data-testid="settings-label-color"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <label class="settings-row"><span>Exclusive</span><input name="exclusive" type="checkbox" value="on"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-label-submit">Create label</button></div>
            </form>`
          : `<p class="muted">Only project admins can create labels.</p>`
      }
    </div>
  </section>`;
}

function milestoneSettingsSection(ctx: WebCtx, milestones: readonly ForgejoMilestone[]): string {
  return `<section class="settings-section" data-testid="settings-milestones">
    <div class="settings-section-header">
      <h2>Milestones</h2>
      <p>Milestones are repository milestones from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="list mini-list">
        ${milestones
          .map((milestone) => `<div class="list-row"><strong>${escapeHtml(milestone.title)}</strong><span>${escapeHtml(milestone.state)} - ${milestone.open_issues} open, ${milestone.closed_issues} closed</span></div>`)
          .join("") || `<div class="empty">No milestones.</div>`}
      </div>
      ${
        ctx.ws.role === "admin"
          ? `<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/milestones")}">
              <label class="settings-row"><span>Title</span><input name="title" required data-testid="settings-milestone-title"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-milestone-submit">Create milestone</button></div>
            </form>`
          : `<p class="muted">Only project admins can create milestones.</p>`
      }
    </div>
  </section>`;
}

function issueFilterForm(
  owner: string,
  repo: string,
  filters: IssueListFilters,
  labels: readonly ForgejoLabel[],
  milestones: readonly ForgejoMilestone[],
): string {
  const action = repoHref(owner, repo, "/issues");
  return `<form class="filter-panel" method="get" action="${action}" data-testid="issue-filters">
    ${stateField(filters.state)}
    <label>Label
      <select name="labels" aria-label="Label filter">
        <option value="">Any label</option>
        ${labels.map((label) => `<option value="${escapeAttr(label.name)}"${selected(filters.labels, label.name)}>${escapeHtml(label.name)}</option>`).join("")}
      </select>
    </label>
    <label>Milestone
      <select name="milestones" aria-label="Milestone filter">
        <option value="">Any milestone</option>
        ${milestones.map((milestone) => `<option value="${milestone.id}"${selected(filters.milestones, String(milestone.id))}>${escapeHtml(milestone.title)}</option>`).join("")}
      </select>
    </label>
    <label>Author <input name="created_by" value="${escapeAttr(filters.createdBy)}" placeholder="username" aria-label="Author filter"></label>
    <label>Assignee <input name="assigned_by" value="${escapeAttr(filters.assignedBy)}" placeholder="username" aria-label="Assignee filter"></label>
    <label>Mentioned <input name="mentioned_by" value="${escapeAttr(filters.mentionedBy)}" placeholder="username" aria-label="Mentioned filter"></label>
    <label>Search <input name="q" value="${escapeAttr(filters.q)}" placeholder="title text" aria-label="Search issues"></label>
    ${sortField(filters.sort, ISSUE_SORT_OPTIONS)}
    <div class="filter-actions">
      <button class="button primary" type="submit">Apply filters</button>
      <a class="button" href="${action}">Reset</a>
    </div>
  </form>`;
}

function pullFilterForm(
  owner: string,
  repo: string,
  filters: PullListFilters,
  labels: readonly ForgejoLabel[],
  milestones: readonly ForgejoMilestone[],
): string {
  const action = repoHref(owner, repo, "/pulls");
  return `<form class="filter-panel" method="get" action="${action}" data-testid="pull-filters">
    ${stateField(filters.state)}
    <label>Label
      <select name="labels" aria-label="Label filter">
        <option value="">Any label</option>
        ${labels.map((label) => `<option value="${label.id}"${selected(filters.labelValue, String(label.id))}>${escapeHtml(label.name)}</option>`).join("")}
      </select>
    </label>
    <label>Milestone
      <select name="milestone" aria-label="Milestone filter">
        <option value="">Any milestone</option>
        ${milestones.map((milestone) => `<option value="${milestone.id}"${selected(filters.milestoneValue, String(milestone.id))}>${escapeHtml(milestone.title)}</option>`).join("")}
      </select>
    </label>
    <label>Author <input name="author" value="${escapeAttr(filters.author)}" placeholder="username" aria-label="Author filter"></label>
    ${sortField(filters.sort, PULL_SORT_OPTIONS)}
    <div class="filter-actions">
      <button class="button primary" type="submit">Apply filters</button>
      <a class="button" href="${action}">Reset</a>
    </div>
  </form>`;
}

function stateField(value: WebListState): string {
  return `<label>State
    <select name="state" aria-label="State filter">
      <option value="open"${selected(value, "open")}>Open</option>
      <option value="closed"${selected(value, "closed")}>Closed</option>
      <option value="all"${selected(value, "all")}>All states</option>
    </select>
  </label>`;
}

function sortField<T extends string>(value: T | "", options: Array<{ value: T; label: string }>): string {
  return `<label>Sort
    <select name="sort" aria-label="Sort filter">
      <option value="">Default</option>
      ${options.map((option) => `<option value="${option.value}"${selected(value, option.value)}>${escapeHtml(option.label)}</option>`).join("")}
    </select>
  </label>`;
}

function selected(current: string, value: string): string {
  return current === value ? " selected" : "";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fileList(owner: string, repo: string, branch: string, files: ForgejoTreeEntry[]): string {
  return `<div class="list">${files
    .map((file) => {
      const kind = fileKindForPath(file.path);
      return `<a class="list-row" href="${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}">
        <strong>${escapeHtml(file.path)}</strong>
        <span>${escapeHtml(fileKindLabel(kind))}</span>
        <small>${formatBytes(file.size ?? 0)}</small>
      </a>`;
    })
    .join("") || `<div class="empty">No files.</div>`}</div>`;
}

function issueList(owner: string, repo: string, issues: ForgejoIssue[], emptyText = "No issues."): string {
  return `<div class="list">${issues
    .map((issue) => `<a class="list-row" href="${repoHref(owner, repo, `/issues/${issue.number}`)}">
      <strong>#${issue.number} ${escapeHtml(issue.title)}</strong>
      <span class="list-meta">
        ${escapeHtml(displayLogin(owner, issue.user?.login))} - ${formatDate(issue.created_at)}
        ${issue.milestone ? `<span class="meta-pill">${escapeHtml(issue.milestone.title)}</span>` : ""}
        ${labelChips(issue.labels)}
      </span>
      <small>${escapeHtml(issue.state)}</small>
    </a>`)
    .join("") || `<div class="empty">${escapeHtml(emptyText)}</div>`}</div>`;
}

function pullList(owner: string, repo: string, pulls: ForgejoPull[], emptyText = "No pull requests."): string {
  return `<div class="list">${pulls
    .map((pull) => `<a class="list-row" href="${repoHref(owner, repo, `/pulls/${pull.number}`)}">
      <strong>#${pull.number} ${escapeHtml(pull.title)}</strong>
      <span class="list-meta">
        ${escapeHtml(pull.head.ref)} -&gt; ${escapeHtml(pull.base.ref)}
        ${pull.milestone ? `<span class="meta-pill">${escapeHtml(pull.milestone.title)}</span>` : ""}
        ${labelChips(pull.labels ?? [])}
      </span>
      <small>${pull.merged ? "merged" : escapeHtml(pull.state)}</small>
    </a>`)
    .join("") || `<div class="empty">${escapeHtml(emptyText)}</div>`}</div>`;
}

function labelChips(labels: readonly ForgejoLabel[]): string {
  if (labels.length === 0) return "";
  return `<span class="label-chips">${labels.map(labelChip).join("")}</span>`;
}

function labelChip(label: ForgejoLabel): string {
  const color = safeLabelColor(label.color);
  return `<span class="label-chip" style="background-color:#${color}22;color:#${color}">${escapeHtml(label.name)}</span>`;
}

function safeLabelColor(value: string): string {
  const color = value.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(color) ? color : "71717a";
}

function activityList(ctx: WebCtx, activities: ForgejoActivity[]): string {
  const items = collapseNoisyEditBranchCommits(activities);
  return `<div class="list">${items.map((item) => activityRow(ctx, item)).join("") || `<div class="empty">No activity.</div>`}</div>`;
}

function activityRow(ctx: WebCtx, item: ActivityFeedItem): string {
  const rendered = renderActivity(ctx, item);
  const count = item.repeatCount > 1 ? `<small class="activity-count">${item.repeatCount} commits</small>` : "";
  return `<div class="list-row activity-row" data-testid="activity-row">
    <strong>${escapeHtml(displayLogin(ctx.owner, item.activity.act_user?.login))}</strong>
    <span>${rendered.summary}${count}</span>
    <small>${formatDate(item.activity.created)}</small>
  </div>`;
}

function renderActivity(ctx: WebCtx, item: ActivityFeedItem): { summary: string } {
  const activity = item.activity;
  const branch = branchFromRef(activity.ref_name);
  const content = parseActivityContent(activity.content);
  const pr = activityPullRef(content);
  const issue = activityIssueRef(content, activity.comment?.issue_url);
  const commit = item.commit ?? activityCommitRef(content);
  const branchHtml = branch ? activityBranchHtml(ctx, branch) : "";
  const commitHtml = commit ? activityCommitHtml(ctx, commit.sha) : "";
  switch (activity.op_type) {
    case "commit_repo": {
      const message = commit?.message ? `: ${escapeHtml(firstLine(commit.message))}` : "";
      const target = commitHtml || branchHtml;
      if (item.repeatCount > 1) {
        return { summary: `saved edits${message}${target ? ` ${target}` : ""}${branchHtml && commitHtml ? ` on ${branchHtml}` : ""}` };
      }
      return { summary: `committed${message}${target ? ` ${target}` : ""}${branchHtml && commitHtml ? ` on ${branchHtml}` : ""}` };
    }
    case "create_pull_request":
      if (pr) return { summary: `opened ${activityPullHtml(ctx, pr.number)}${pr.label ? `: ${escapeHtml(pr.label)}` : ""}` };
      return { summary: "opened a pull request" };
    case "merge_pull_request":
      if (pr) return { summary: `merged ${activityPullHtml(ctx, pr.number)}${pr.label ? ` from ${escapeHtml(pr.label)}` : ""}` };
      return { summary: "merged a pull request" };
    case "comment_pull":
      if (pr) return { summary: `commented on ${activityPullHtml(ctx, pr.number)}` };
      return { summary: "commented on a pull request" };
    case "close_issue":
      if (issue) return { summary: `closed ${activityIssueHtml(ctx, issue)}` };
      return { summary: "closed an issue" };
    case "reopen_issue":
      if (issue) return { summary: `reopened ${activityIssueHtml(ctx, issue)}` };
      return { summary: "reopened an issue" };
    case "comment_issue":
      if (issue) return { summary: `commented on ${activityIssueHtml(ctx, issue)}` };
      return { summary: "commented on an issue" };
    case "delete_branch":
      return { summary: `deleted branch ${branch ? escapeHtml(branch) : ""}` };
    default:
      return { summary: `${escapeHtml(activity.op_type)}${branchHtml ? ` on ${branchHtml}` : ""}` };
  }
}

function activityCommitHtml(ctx: WebCtx, sha: string): string {
  return `<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/commits/${encodeURIComponent(sha)}`)}">${escapeHtml(sha.slice(0, 10))}</a>`;
}

function activityPullHtml(ctx: WebCtx, number: number): string {
  return `<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}`)}">pull request #${number}</a>`;
}

function activityIssueHtml(ctx: WebCtx, number: number): string {
  return `<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/issues/${number}`)}">issue #${number}</a>`;
}

function activityBranchHtml(ctx: WebCtx, branch: string): string {
  return `<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}">${escapeHtml(branch)}</a>`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function activityPullRef(value: unknown): { number: number; label: string } | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[1] !== "string") return null;
  const number = Number(value[0]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { number, label: value[1] };
}

function activityIssueRef(value: unknown, issueUrl: string | undefined): number | null {
  if (Array.isArray(value)) {
    const number = Number(value[0]);
    if (Number.isInteger(number) && number > 0) return number;
  }
  const match = issueUrl?.match(/\/issues\/(\d+)(?:$|[#?])/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

async function notFoundPage(user: string, message: string): Promise<Response> {
  return htmlResponse(pageShell({ title: "Not found", user, body: `${globalHeader(user)}<main class="page"><div class="empty">${escapeHtml(message)}</div></main>` }), 404);
}

function badRequestPage(user: string, message: string): Response {
  return htmlResponse(pageShell({ title: "Bad request", user, body: `${globalHeader(user)}<main class="page"><div class="empty">${escapeHtml(message)}</div></main>` }), 400);
}

function forbiddenPage(user: string): Response {
  return htmlResponse(pageShell({ title: "Forbidden", user, body: `${globalHeader(user)}<main class="page"><div class="empty">Forbidden</div></main>` }), 403);
}

function safeWebRedirect(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

function positiveInt(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function textField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringFields(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function positiveIntFields(value: unknown): number[] {
  return stringFields(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function validBranchName(value: string | null | undefined): value is string {
  return Boolean(
    value &&
      /^[A-Za-z0-9._/-]+$/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("/") &&
      !value.endsWith("/"),
  );
}

function editBranchFor(username: string, requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== "main" ? trimmed : `user/${username}/web-edit`;
}

function repoHref(_owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(repo)}${suffix}`;
}

function routeRest(c: Context<AppEnv>, owner: string, repo: string, suffix: string): string {
  const path = c.req.path;
  const canonicalPrefix = repoHref(owner, repo, suffix);
  if (path.startsWith(canonicalPrefix)) return decodePathPart(path.slice(canonicalPrefix.length));
  const internalPrefix = `/${encodeURIComponent(owner)}${canonicalPrefix}`;
  return path.startsWith(internalPrefix) ? decodePathPart(path.slice(internalPrefix.length)) : "";
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return "";
  }
}

function urlPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function displayLogin(owner: string, login: string | null | undefined): string {
  if (!login) return DELETED_USER_LOGIN;
  return login === owner ? "project" : login;
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function formatDate(value: string | number | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
