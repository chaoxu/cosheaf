import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type Database from "better-sqlite3";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { COFLAT_FORMAT_ID, documentFormatFromTopics, isFormatTopic } from "../../shared/document-format.js";
import { ROLES, type Role } from "../../shared/roles.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { AUTH_COOKIE, invalidateWorkspacePermissionCache, resolveAuth } from "../middleware.js";
import { Forgejo, ForgejoError, mergePullWithRetry, type ForgejoPull } from "../forgejo.js";
import {
  activityCommitRef,
  branchFromRef,
  collapseNoisyEditBranchCommits,
  parseActivityContent,
  type ActivityFeedItem,
} from "../activity-feed.js";
import { fileLineToWritePosition, positionToFileLine, type Side } from "../diff-position.js";
import type {
  ForgejoActivity,
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoPullReviewComment,
  ForgejoReview,
  ForgejoTimelineEvent,
  ForgejoTreeEntry,
} from "../forgejo-types.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { invalidateBranchTree, invalidateRepoTrees } from "../tree-cache.js";
import { setWorkspaceMember } from "../workspace-members.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { safeRel } from "./files.js";
import { escapeAttr, escapeHtml } from "./html-escape.js";
import { globalHeader, pageShell, webEditorAssets } from "./web-shell.js";
import { splitUnifiedDiff } from "../diff-splitter.js";

export const web = new Hono<AppEnv>();

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
  const outcome = await exchangeForgejoCredsForPat(c.get("config").forgejoUrl, username, password);
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
  const files = await markdownFiles(fj, owner, repo, "main").catch(() => []);
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
          <a class="button" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, "main"))}">New file</a>
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
  const files = await markdownFiles(fj, owner, repo, resolved.branch);
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
            <a class="button" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}">New file</a>
          </div>
          ${fileList(owner, repo, resolved.branch, files)}
        `,
      }),
    );
  }
  const rel = safeRel(resolved.path);
  if (!rel) return notFoundPage(user, "File not found");
  const content = await fj.getRawFile(owner, repo, resolved.branch, rel).catch((err) => {
    if (err instanceof ForgejoError && err.status === 404) return null;
    throw err;
  });
  if (content === null) return notFoundPage(user, "File not found");
  if (!rel.endsWith(".md")) {
    return new Response(content, { headers: { "content-type": contentTypeForPath(rel) } });
  }
  const rendered = await renderMarkdown(ctx, content, { branch: resolved.branch, documentPath: rel });
  return htmlResponse(
    repoPage({
      title: `${rel} - ${repo}`,
      owner,
      repo,
      active: "files",
      user,
      ws,
      readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID,
      body: `
        <div class="file-toolbar">
          <div>
            <p class="eyebrow">${escapeHtml(resolved.branch)}</p>
            <h1>${escapeHtml(rel)}</h1>
          </div>
          <div class="toolbar-actions">
            <a class="button" href="${repoHref(owner, repo, "/raw/branch")}/${urlPath(resolved.branch)}/${urlPath(rel)}">Raw</a>
            ${
              ws.role === "read"
                ? ""
                : `<a class="button primary" href="${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, resolved.branch))}&path=${encodeURIComponent(rel)}">Edit</a>`
            }
          </div>
        </div>
        <article class="document cf-theme-scope">
          ${markdownSurface(ctx, rendered)}
        </article>
      `,
    }),
  );
});

web.get("/:owner/:repo/raw/branch/*", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const resolved = await resolveBranchPath(ctx.fj, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/raw/branch/"));
  if (!resolved?.path) return new Response("not found", { status: 404 });
  const rel = safeRel(resolved.path);
  if (!rel) return new Response("not found", { status: 404 });
  const content = await ctx.fj.getRawFile(ctx.owner, ctx.repo, resolved.branch, rel);
  return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
});

web.get("/:owner/:repo/_edit", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const branch = editBranchFor(ctx.user, c.req.query("branch"));
  const rel = safeRel(c.req.query("path") || "new.md") ?? "new.md";
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
      body: `
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
      `,
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
  await writeMarkdownFile(ctx, branch, rel, content, oldRel ?? undefined);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`);
});

web.get("/:owner/:repo/issues", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const state = c.req.query("state") === "closed" ? "closed" : "open";
  const issues = await ctx.fj.listIssues(ctx.owner, ctx.repo, { state, limit: 50 });
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
          <div><p class="eyebrow">${state}</p><h1>Issues</h1></div>
        </div>
        ${issueList(ctx.owner, ctx.repo, issues)}
      `,
    }),
  );
});

web.get("/:owner/:repo/issues/:number", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const [issue, comments, timeline] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return null;
      throw err;
    }),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, number).catch(() => []),
  ]);
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  const body = await renderMarkdown(ctx, issue.body ?? "");
  const timelineHtml = await renderIssueTimeline(ctx, comments, timeline ?? []);
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
                  : `<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/state`)}">
                       <input type="hidden" name="state" value="${nextIssueState}">
                       <button class="button" type="submit" data-testid="issue-toggle-state">${stateActionLabel}</button>
                     </form>`
              }
            </div>
            <p>by ${escapeHtml(displayLogin(ctx.owner, issue.user?.login))} - ${formatDate(issue.created_at)}</p>
          </header>
          <div class="issue-document">
            ${markdownSurface(ctx, body)}
          </div>
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

web.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role === "read") return forbiddenPage(ctx.user);
  const number = positiveInt(c.req.param("number"));
  const body = stringField((await c.req.parseBody()).body);
  if (number && body) await ctx.fj.createIssueComment(ctx.owner, ctx.repo, number, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number ?? ""}`));
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

web.get("/:owner/:repo/pulls", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const state = c.req.query("state") === "closed" ? "closed" : "open";
  const pulls = await ctx.fj.listPulls(ctx.owner, ctx.repo, state);
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
          <div><p class="eyebrow">${state}</p><h1>Pull requests</h1></div>
        </div>
        ${pullList(ctx.owner, ctx.repo, pulls)}
      `,
    }),
  );
});

web.get("/:owner/:repo/pulls/:number", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const [reviews, comments, timeline, commits] = await Promise.all([
    ctx.fj.listReviews(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullCommits(ctx.owner, ctx.repo, pull.number).catch(() => []),
  ]);
  const body = await renderMarkdown(ctx, pull.body ?? "");
  const timelineHtml = await renderPullTimeline(ctx, reviews, comments, timeline ?? [], commits);
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
              <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>
            </div>
            <p>${escapeHtml(pull.head.ref)} into ${escapeHtml(pull.base.ref)} - by ${escapeHtml(displayLogin(ctx.owner, pull.user?.login))}</p>
            <nav class="subtabs">
              <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
              <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
            </nav>
          </header>
          <div class="comment">
            <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, pull.user?.login))}</div>
            ${body ? markdownSurface(ctx, body) : `<p>No description.</p>`}
          </div>
          ${timelineHtml}
          ${reviewForms(ctx, pull)}
        </article>
      `,
    }),
  );
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
                    <a class="${f.path === file?.path ? "active" : ""}" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}?file=${encodeURIComponent(f.path)}">
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
  const branches = await ctx.fj.listBranches(ctx.owner, ctx.repo);
  return htmlResponse(
    repoPage({
      title: `Branches - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "files",
      user: ctx.user,
      ws: ctx.ws,
      body: `<div class="page-title compact"><h1>Branches</h1></div>
        <div class="list">${branches
          .map((b) => `<a class="list-row" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(b.name)}"><strong>${escapeHtml(b.name)}</strong><span>${escapeHtml(b.commit.id.slice(0, 10))}</span></a>`)
          .join("")}</div>`,
    }),
  );
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
  const protection = await ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null);
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

async function markdownFiles(fj: Forgejo, owner: string, repo: string, ref: string) {
  const tree = await fj.getTree(owner, repo, ref, true);
  return tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".md"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveBranchPath(
  fj: Forgejo,
  owner: string,
  repo: string,
  rest: string,
): Promise<{ branch: string; path: string } | null> {
  const clean = rest.replace(/^\/+/, "");
  const branches = await fj.listBranches(owner, repo);
  const sorted = branches.map((b) => b.name).sort((a, b) => b.length - a.length);
  for (const branch of sorted) {
    if (clean === branch) return { branch, path: "" };
    if (clean.startsWith(`${branch}/`)) return { branch, path: clean.slice(branch.length + 1) };
  }
  if (!clean) return { branch: "main", path: "" };
  return null;
}

async function renderMarkdown(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string } = {},
): Promise<string> {
  const { body } = parseFrontmatterYaml(source);
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) {
    return coflatReaderIsland(ctx, source, opts);
  }
  return ctx.fj.renderMarkdown(ctx.owner, ctx.repo, body);
}

function coflatReaderIsland(ctx: WebCtx, source: string, opts: { branch?: string; documentPath?: string }): string {
  const payload = {
    source,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: opts.branch ?? "main",
    path: opts.documentPath ?? "",
  };
  return `<div class="cf-reader cf-doc-surface cf-doc-flow coflat-reader-island" data-reader-branch="${escapeAttr(payload.branch)}"><script type="application/json">${jsonScript(payload)}</script></div>`;
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
      renderMarkdown(ctx, nextVersions.base, { branch: pull.base.ref, documentPath: file.path }),
      renderMarkdown(ctx, nextVersions.head, { branch: pull.head.ref, documentPath: file.path }),
    ]);
    return `<div data-testid="diff-pane-split" class="rich-split cf-theme-scope">
      <section><h3>Base</h3>${markdownSurface(ctx, base, "cf-rich-diff")}</section>
      <section><h3>Head</h3>${markdownSurface(ctx, head, "cf-rich-diff")}</section>
    </div>`;
  }
  const head = await renderMarkdown(ctx, nextVersions.head, { branch: pull.head.ref, documentPath: file.path });
  return `<div data-testid="diff-pane-after" class="rich-after cf-theme-scope">${markdownSurface(ctx, head, "cf-rich-diff")}</div>`;
}

function markdownSurface(ctx: WebCtx, rendered: string, extraClass = ""): string {
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) return rendered;
  const className = ["markdown-body", "cf-reader", "cf-doc-surface", "cf-doc-flow", extraClass].filter(Boolean).join(" ");
  return `<div class="${className}">${rendered}</div>`;
}

function diffModeControls(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape): string {
  const href = (nextMode: DiffMode, nextShape: DiffShape) =>
    `${repoHref(ctx.owner, ctx.repo, `/pulls/${prNumber}/files`)}?file=${encodeURIComponent(filePath)}&mode=${nextMode}&shape=${nextShape}`;
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

function changedLines(patch: string): { added: Set<number>; deleted: Set<number> } {
  const added = new Set<number>();
  const deleted = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deleted.add(oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { added, deleted };
}

function commentableLines(patch: string): { head: Set<number>; base: Set<number> } {
  const head = new Set<number>();
  const base = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      head.add(newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      base.add(oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      base.add(oldLine);
      head.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { head, base };
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

type WebTimelineItem =
  | { kind: "comment"; ts: number; comment: ForgejoIssueComment }
  | { kind: "event"; ts: number; event: ForgejoTimelineEvent }
  | { kind: "review"; ts: number; review: ForgejoReview }
  | { kind: "line-comment"; ts: number; comment: ForgejoPullReviewComment }
  | { kind: "commit"; ts: number; commit: ForgejoCommit };

async function renderIssueTimeline(
  ctx: WebCtx,
  comments: readonly ForgejoIssueComment[],
  timeline: readonly ForgejoTimelineEvent[],
): Promise<string> {
  const items: WebTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, ts: parseDateMs(comment.created_at), comment })),
    ...timeline
      .filter((event) => event.type !== "comment")
      .map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event })),
  ].sort(compareTimelineItems);
  return (await Promise.all(items.map((item) => renderTimelineItem(ctx, item)))).join("");
}

async function renderPullTimeline(
  ctx: WebCtx,
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
      comment,
    })),
    ...commits.map((commit) => ({ kind: "commit" as const, ts: commitDateMs(commit), commit })),
  ].sort(compareTimelineItems);
  return (await Promise.all(items.map((item) => renderTimelineItem(ctx, item)))).join("");
}

async function renderTimelineItem(ctx: WebCtx, item: WebTimelineItem): Promise<string> {
  if (item.kind === "comment") {
    const body = await renderMarkdown(ctx, item.comment.body);
    return `<div class="comment">
      <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, item.comment.user?.login))} - ${formatDate(item.comment.created_at)}</div>
      ${markdownSurface(ctx, body)}
    </div>`;
  }
  if (item.kind === "line-comment") {
    const body = await renderMarkdown(ctx, item.comment.body);
    return `<div class="comment">
      <div class="comment-meta">${escapeHtml(displayLogin(ctx.owner, item.comment.user?.login))} commented on ${escapeHtml(item.comment.path)} - ${formatDate(item.comment.created_at)}</div>
      ${markdownSurface(ctx, body)}
    </div>`;
  }
  if (item.kind === "review") {
    const label = reviewStateLabel(item.review.state);
    const body = item.review.body ? await renderMarkdown(ctx, item.review.body) : "";
    return `<div class="timeline-event">
      <strong>${escapeHtml(displayLogin(ctx.owner, item.review.user?.login))}</strong>
      <span>${escapeHtml(label)}</span>
      <small>${formatDate(item.review.submitted_at)}</small>
      ${body ? markdownSurface(ctx, body) : ""}
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
  const description = describeWebTimelineEvent(item.event);
  if (!description) return "";
  return `<div class="timeline-event">
    ${item.event.user?.login ? `<strong>${escapeHtml(displayLogin(ctx.owner, item.event.user.login))}</strong>` : ""}
    <span>${description}</span>
    <small>${formatDate(item.event.created_at)}</small>
  </div>`;
}

function describeWebTimelineEvent(event: ForgejoTimelineEvent): string {
  switch (event.type) {
    case "close":
      return "closed this";
    case "reopen":
      return "reopened this";
    case "merge":
      return "merged this";
    case "label":
      return event.label ? `added the ${event.label.name} label` : "changed labels";
    case "unlabel":
      return event.label ? `removed the ${event.label.name} label` : "changed labels";
    case "assignees":
      return event.assignee
        ? `${event.removed_assignee ? "unassigned" : "assigned"} ${event.assignee.login}`
        : "changed assignees";
    case "change_title":
      return `renamed from "${event.old_title ?? ""}" to "${event.new_title ?? ""}"`;
    case "milestone":
      return event.milestone ? `added this to milestone ${event.milestone.title}` : "changed milestone";
    case "demilestone":
      return event.milestone ? `removed this from milestone ${event.milestone.title}` : "changed milestone";
    case "commit_ref":
      return event.ref_commit_sha ? `referenced this in commit ${event.ref_commit_sha.slice(0, 10)}` : "referenced this";
    case "issue_ref":
    case "comment_ref":
      return refIssueNumber(event) ? `referenced this in #${refIssueNumber(event)}` : "referenced this";
    case "pull_ref":
      return refIssueNumber(event) ? `referenced this in pull request #${refIssueNumber(event)}` : "referenced this in a pull request";
    case "dependency_added":
      return event.dependent_issue ? `added dependency #${event.dependent_issue.number}` : "added dependency";
    case "dependency_removed":
      return event.dependent_issue ? `removed dependency #${event.dependent_issue.number}` : "removed dependency";
    case "pin":
      return "pinned this";
    case "unpin":
      return "unpinned this";
    default:
      return event.type.replaceAll("_", " ");
  }
}

function refIssueNumber(event: ForgejoTimelineEvent): number | null {
  const ref = event.ref_issue as unknown;
  if (typeof ref === "number") return ref;
  if (ref && typeof ref === "object" && "number" in ref) {
    const number = (ref as { number?: unknown }).number;
    return typeof number === "number" ? number : null;
  }
  return null;
}

function compareTimelineItems(a: WebTimelineItem, b: WebTimelineItem): number {
  return a.ts - b.ts;
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
  const rows = patch
    .split("\n")
    .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((line) => {
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
      return `<tr class="${kind}"><td class="sign">${escapeHtml(line[0] ?? "")}</td><td><pre>${escapeHtml(line.slice(kind === "ctx" ? 0 : 1))}</pre></td></tr>`;
    })
    .join("");
  return `<table class="patch"><tbody>${rows}</tbody></table>`;
}

function repoPage(opts: {
  title: string;
  owner: string;
  repo: string;
  active: "files" | "issues" | "pulls" | "activity" | "settings";
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

function fileList(owner: string, repo: string, branch: string, files: ForgejoTreeEntry[]): string {
  return `<div class="list">${files
    .map((file) => `<a class="list-row" href="${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}"><strong>${escapeHtml(file.path)}</strong><span>${file.size ?? 0} bytes</span></a>`)
    .join("") || `<div class="empty">No Markdown files.</div>`}</div>`;
}

function issueList(owner: string, repo: string, issues: ForgejoIssue[]): string {
  return `<div class="list">${issues
    .map((issue) => `<a class="list-row" href="${repoHref(owner, repo, `/issues/${issue.number}`)}"><strong>#${issue.number} ${escapeHtml(issue.title)}</strong><span>${escapeHtml(displayLogin(owner, issue.user?.login))} - ${formatDate(issue.created_at)}</span><small>${escapeHtml(issue.state)}</small></a>`)
    .join("") || `<div class="empty">No issues.</div>`}</div>`;
}

function pullList(owner: string, repo: string, pulls: ForgejoPull[]): string {
  return `<div class="list">${pulls
    .map((pull) => `<a class="list-row" href="${repoHref(owner, repo, `/pulls/${pull.number}`)}"><strong>#${pull.number} ${escapeHtml(pull.title)}</strong><span>${escapeHtml(pull.head.ref)} -> ${escapeHtml(pull.base.ref)}</span><small>${pull.merged ? "merged" : escapeHtml(pull.state)}</small></a>`)
    .join("") || `<div class="empty">No pull requests.</div>`}</div>`;
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

function contentTypeForPath(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
      return "text/javascript; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}
