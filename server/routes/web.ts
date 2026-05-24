import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { COFLAT_FORMAT_ID, documentFormatFromTopics, isFormatTopic } from "../../shared/document-format.js";
import type { Role } from "../../shared/roles.js";
import { planIndexPage } from "../indexer.js";
import { AUTH_COOKIE, resolveAuth } from "../middleware.js";
import { Forgejo, ForgejoError, mergePullWithRetry, type ForgejoPull } from "../forgejo.js";
import type { ForgejoIssue, ForgejoTreeEntry } from "../forgejo-types.js";
import { DELETED_USER_LOGIN } from "../forgejo-types.js";
import type { AppEnv, WorkspaceContext } from "../types.js";
import { invalidateBranchTree, invalidateRepoTrees } from "../tree-cache.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { safeRel } from "./files.js";

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
                  <a class="list-row" href="/${encodeURIComponent(config.forgejoOwner)}/${encodeURIComponent(repo.name)}">
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

web.get("/:owner/:repo", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const { owner, repo, fj, ws, user } = ctx;
  const [pulls, issues, files] = await Promise.all([
    fj.listPulls(owner, repo, "open").catch(() => []),
    fj.listIssues(owner, repo, { state: "open", limit: 10 }).catch(() => []),
    markdownFiles(fj, owner, repo, "main").catch(() => []),
  ]);
  return htmlResponse(
    repoPage({
      title: repo,
      owner,
      repo,
      active: "code",
      user,
      ws,
      body: `
        <section class="repo-summary">
          <div>
            <p class="eyebrow">Repository</p>
            <h1>${escapeHtml(repo)}</h1>
          </div>
          <div class="summary-grid">
            <a href="${repoHref(owner, repo, "/src/branch/main")}"><strong>${files.length}</strong><span>Markdown files</span></a>
            <a href="${repoHref(owner, repo, "/issues")}"><strong>${issues.length}</strong><span>Open issues</span></a>
            <a href="${repoHref(owner, repo, "/pulls")}"><strong>${pulls.length}</strong><span>Open PRs</span></a>
          </div>
        </section>
        <div class="two-col">
          <section>
            <div class="section-title"><h2>Files</h2><a href="${repoHref(owner, repo, "/src/branch/main")}">Browse</a></div>
            ${fileList(owner, repo, "main", files.slice(0, 20))}
          </section>
          <section>
            <div class="section-title"><h2>Pull requests</h2><a href="${repoHref(owner, repo, "/pulls")}">View all</a></div>
            ${pullList(owner, repo, pulls.slice(0, 8))}
          </section>
        </div>
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
        active: "code",
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
      active: "code",
      user,
      ws,
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
      active: "code",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <section class="edit-page">
          <div class="file-toolbar">
            <div><p class="eyebrow">Edit on branch</p><h1>${escapeHtml(rel)}</h1></div>
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
              <input type="hidden" name="path" value="${escapeAttr(rel)}">
              <label>Branch <input name="branch" value="${escapeAttr(branch)}" required></label>
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
  const content = textField(form.content);
  if (!rel || content === null) return redirect(repoHref(ctx.owner, ctx.repo));
  await ensureBranch(ctx.fj, ctx.owner, ctx.repo, branch);
  await writeMarkdownFile(ctx, branch, rel, content);
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
  const [issue, comments] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return null;
      throw err;
    }),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
  ]);
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  const body = await renderMarkdown(ctx, issue.body ?? "");
  const renderedComments = await Promise.all(
    comments.map(async (comment) => ({
      ...comment,
      renderedBody: await renderMarkdown(ctx, comment.body),
    })),
  );
  return htmlResponse(
    repoPage({
      title: `#${issue.number} ${issue.title}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "issues",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <article class="thread">
          <header class="thread-header">
            <span class="state ${issue.state}">${escapeHtml(issue.state)}</span>
            <h1>${escapeHtml(issue.title)} <span>#${issue.number}</span></h1>
            <p>by ${escapeHtml(issue.user?.login ?? DELETED_USER_LOGIN)} - ${formatDate(issue.created_at)}</p>
          </header>
          <div class="issue-document">
            ${markdownSurface(ctx, body)}
          </div>
          ${renderedComments
            .map(
              (comment) => `
                  <div class="comment">
                    <div class="comment-meta">${escapeHtml(comment.user?.login ?? DELETED_USER_LOGIN)} - ${formatDate(comment.created_at)}</div>
                  ${markdownSurface(ctx, comment.renderedBody)}
                  </div>
              `,
            )
            .join("")}
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
  const [reviews, comments] = await Promise.all([
    ctx.fj.listReviews(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number).catch(() => []),
  ]);
  const body = await renderMarkdown(ctx, pull.body ?? "");
  return htmlResponse(
    repoPage({
      title: `#${pull.number} ${pull.title}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <article class="thread">
          <header class="thread-header">
            <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : escapeHtml(pull.state)}</span>
            <h1>${escapeHtml(pull.title)} <span>#${pull.number}</span></h1>
            <p>${escapeHtml(pull.head.ref)} into ${escapeHtml(pull.base.ref)} - by ${escapeHtml(pull.user?.login ?? DELETED_USER_LOGIN)}</p>
            <nav class="subtabs">
              <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
              <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
            </nav>
          </header>
          <div class="comment">
            <div class="comment-meta">${escapeHtml(pull.user?.login ?? DELETED_USER_LOGIN)}</div>
            ${body ? markdownSurface(ctx, body) : `<p>No description.</p>`}
          </div>
          ${reviews
            .filter((r) => r.state !== "PENDING")
            .map((r) => `<div class="event">${escapeHtml(r.user?.login ?? DELETED_USER_LOGIN)} reviewed: <strong>${escapeHtml(r.state)}</strong>${r.body ? ` - ${escapeHtml(r.body)}` : ""}</div>`)
            .join("")}
          ${comments
            .map((comment) => `<div class="event">${escapeHtml(comment.user?.login ?? DELETED_USER_LOGIN)} commented on ${escapeHtml(comment.path)}: ${escapeHtml(comment.body)}</div>`)
            .join("")}
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
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
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
  await deleteBranchQuietly(ctx, pull.head.ref);
  invalidateRepoTrees(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.get("/:owner/:repo/pulls/:number/files", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const files = await pullFiles(ctx, pull.number);
  const selected = c.req.query("file") ?? files[0]?.path ?? "";
  const file = files.find((f) => f.path === selected) ?? files[0] ?? null;
  const mode = parseDiffMode(c.req.query("mode"));
  const shape = parseDiffShape(c.req.query("shape"), mode);
  const versions = file && shape !== "unified" ? await prFileVersions(ctx, pull, file.path) : null;
  return htmlResponse(
    repoPage({
      title: `Files #${pull.number} - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <header class="thread-header">
          <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : escapeHtml(pull.state)}</span>
          <h1>${escapeHtml(pull.title)} <span>#${pull.number}</span></h1>
          <nav class="subtabs">
            <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
            <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
          </nav>
        </header>
        <div class="review-page">
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
                  ${await renderPrFileView(ctx, pull, file, mode, shape, versions)}`
                : `<div class="empty">No changed files.</div>`
            }
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
      active: "code",
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
        <div class="list">${activities
          .map((a) => `<div class="list-row"><strong>${escapeHtml(a.act_user?.login ?? "system")}</strong><span>${escapeHtml(a.op_type)} - ${formatDate(a.created)}</span></div>`)
          .join("") || `<div class="empty">No activity.</div>`}</div>`,
    }),
  );
});

web.get("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const protection = await ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null);
  return htmlResponse(
    repoPage({
      title: `Settings - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "settings",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <form class="settings-page" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings")}">
          <div class="page-title compact"><h1>Settings</h1></div>
          <label>Required approvals <input name="required_approvals" type="number" min="0" value="${protection?.required_approvals ?? 1}" ${ctx.ws.role === "admin" ? "" : "disabled"}></label>
          <p class="muted">Format: ${escapeHtml(ctx.ws.defaultMdFormat)}</p>
          ${ctx.ws.role === "admin" ? `<button class="button primary" type="submit">Save settings</button>` : ""}
        </form>
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

async function writeMarkdownFile(ctx: WebCtx, branch: string, rel: string, content: string): Promise<void> {
  const plan = planIndexPage(ctx.db, {
    workspaceSlug: ctx.ws.slug,
    filePath: rel,
    bodyText: content,
    formatId: ctx.ws.defaultMdFormat,
  });
  const finalContent = plan.rewrittenContent ?? content;
  const existing = await ctx.fj.getFileMeta(ctx.owner, ctx.repo, branch, rel);
  await ctx.fj.putFile(ctx.owner, ctx.repo, {
    branch,
    path: rel,
    content: finalContent,
    sha: existing?.sha,
    message: existing ? `update ${rel}` : `create ${rel}`,
  });
  plan.commit();
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

function parseDiffMode(value: string | undefined): DiffMode {
  return value === "rich" ? "rich" : "source";
}

function parseDiffShape(value: string | undefined, mode: DiffMode): DiffShape {
  const shape = value === "split" || value === "after" ? value : "unified";
  return mode === "rich" && shape === "unified" ? "split" : shape;
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
): Promise<string> {
  if (mode === "source" && shape === "unified") {
    return `<div data-testid="diff-pane-unified">${renderPatch(file.patch)}</div>`;
  }
  const nextVersions = versions ?? (await prFileVersions(ctx, pull, file.path));
  const changed = changedLines(file.patch);
  if (mode === "source" && shape === "split") {
    return `<div data-testid="diff-pane-split" class="source-split">
      ${sourcePane("Base", nextVersions.base, changed.deleted)}
      ${sourcePane("Head", nextVersions.head, changed.added)}
    </div>`;
  }
  if (mode === "source") {
    return `<div data-testid="diff-pane-after" class="source-after">${sourcePane("After", nextVersions.head, changed.added)}</div>`;
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

function sourcePane(title: string, source: string, marked: ReadonlySet<number>): string {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `<section><h3>${escapeHtml(title)}</h3><table class="source-lines"><tbody>${lines
    .map((line, index) => {
      const lineNo = index + 1;
      return `<tr class="${marked.has(lineNo) ? "marked" : ""}"><td>${lineNo}</td><td><pre>${escapeHtml(line)}</pre></td></tr>`;
    })
    .join("")}</tbody></table></section>`;
}

function splitDiffByFile(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const chunks = diff.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const text = `diff --git ${chunk}`;
    const first = text.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(first);
    if (match) sections.set(match[2], text);
  }
  return sections;
}

async function deleteBranchQuietly(ctx: WebCtx, branch: string): Promise<void> {
  if (!branch || branch === "main") return;
  await ctx.fj.deleteBranch(ctx.owner, ctx.repo, branch).catch(() => undefined);
}

function reviewForms(ctx: WebCtx, pull: ForgejoPull): string {
  if (ctx.ws.role === "read" || pull.user?.login === ctx.user || pull.state === "closed") return "";
  return `
    <form class="review-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/reviews`)}">
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
  active: "code" | "issues" | "pulls" | "activity" | "settings";
  user: string;
  ws: WorkspaceContext;
  body: string;
}): string {
  return pageShell({
    title: opts.title,
    user: opts.user,
    body: `
      ${globalHeader(opts.user)}
      <main class="repo-page">
        <header class="repo-header">
          <div>
            <a class="owner" href="/"> ${escapeHtml(opts.owner)}</a>
            <h1><a href="${repoHref(opts.owner, opts.repo)}">${escapeHtml(opts.repo)}</a></h1>
          </div>
          <span class="role">${escapeHtml(opts.ws.role)}</span>
        </header>
        <nav class="repo-tabs">
          ${tab(opts, "code", "Code", "")}
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

function pageShell(opts: { title: string; user?: string; body: string }): string {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(opts.title)} - Cosheaf</title>
        <link rel="stylesheet" href="/vendor/coflat-editor/editor.css">
        <link rel="stylesheet" href="/vendor/coflat-editor/themes/blueprint-book.css">
        ${webReaderAssets()}
        <style>${WEB_CSS}</style>
      </head>
      <body>${opts.body}</body>
    </html>`;
}

type ViteManifestChunk = {
  file: string;
  css?: string[];
  imports?: string[];
};

let manifestCache: Record<string, ViteManifestChunk> | null | undefined;

function webEditorAssets(): string {
  return viteEntryAssets("src/cosheaf/web-editor.tsx");
}

function webReaderAssets(): string {
  return viteEntryAssets("src/cosheaf/web-reader.ts");
}

function viteEntryAssets(entryId: string): string {
  if (process.env.NODE_ENV !== "production") {
    const devOrigin = process.env.COSHEAF_VITE_ORIGIN ?? "http://localhost:5173";
    return `<script type="module" src="${devOrigin}/${entryId}"></script>`;
  }
  const manifest = readViteManifest();
  if (!manifest) {
    return "";
  }
  const entry = manifest[entryId];
  if (!entry) return "";
  const cssLinks = collectCss(manifest, entry, new Set<string>())
    .map((href) => `<link rel="stylesheet" href="/${escapeAttr(href)}">`)
    .join("");
  return `${cssLinks}<script type="module" src="/${escapeAttr(entry.file)}"></script>`;
}

function readViteManifest(): Record<string, ViteManifestChunk> | null {
  if (manifestCache !== undefined) return manifestCache;
  const manifestPath = path.resolve(process.cwd(), "dist/.vite/manifest.json");
  if (!existsSync(manifestPath)) {
    manifestCache = null;
    return manifestCache;
  }
  manifestCache = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ViteManifestChunk>;
  return manifestCache;
}

function collectCss(
  manifest: Record<string, ViteManifestChunk>,
  chunk: ViteManifestChunk,
  seen: Set<string>,
): string[] {
  const css: string[] = [];
  for (const imported of chunk.imports ?? []) {
    const importedChunk = manifest[imported];
    if (importedChunk) css.push(...collectCss(manifest, importedChunk, seen));
  }
  for (const href of chunk.css ?? []) {
    if (seen.has(href)) continue;
    seen.add(href);
    css.push(href);
  }
  return css;
}

function globalHeader(user: string): string {
  return `<header class="global-header">
    <a class="brand" href="/">Cosheaf</a>
    <form method="post" action="/logout"><span>${escapeHtml(user)}</span><button type="submit">Sign out</button></form>
  </header>`;
}

function fileList(owner: string, repo: string, branch: string, files: ForgejoTreeEntry[]): string {
  return `<div class="list">${files
    .map((file) => `<a class="list-row" href="${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(file.path)}"><strong>${escapeHtml(file.path)}</strong><span>${file.size ?? 0} bytes</span></a>`)
    .join("") || `<div class="empty">No Markdown files.</div>`}</div>`;
}

function issueList(owner: string, repo: string, issues: ForgejoIssue[]): string {
  return `<div class="list">${issues
    .map((issue) => `<a class="list-row" href="${repoHref(owner, repo, `/issues/${issue.number}`)}"><strong>#${issue.number} ${escapeHtml(issue.title)}</strong><span>${escapeHtml(issue.user?.login ?? DELETED_USER_LOGIN)} - ${formatDate(issue.created_at)}</span><small>${escapeHtml(issue.state)}</small></a>`)
    .join("") || `<div class="empty">No issues.</div>`}</div>`;
}

function pullList(owner: string, repo: string, pulls: ForgejoPull[]): string {
  return `<div class="list">${pulls
    .map((pull) => `<a class="list-row" href="${repoHref(owner, repo, `/pulls/${pull.number}`)}"><strong>#${pull.number} ${escapeHtml(pull.title)}</strong><span>${escapeHtml(pull.head.ref)} -> ${escapeHtml(pull.base.ref)}</span><small>${pull.merged ? "merged" : escapeHtml(pull.state)}</small></a>`)
    .join("") || `<div class="empty">No pull requests.</div>`}</div>`;
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

function forbiddenPage(user: string): Response {
  return htmlResponse(pageShell({ title: "Forbidden", user, body: `${globalHeader(user)}<main class="page"><div class="empty">Forbidden</div></main>` }), 403);
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

function repoHref(owner: string, repo: string, suffix = ""): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function routeRest(c: Context<AppEnv>, owner: string, repo: string, suffix: string): string {
  const prefix = repoHref(owner, repo, suffix);
  const path = c.req.path;
  return path.startsWith(prefix) ? decodePathPart(path.slice(prefix.length)) : "";
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

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
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

const WEB_CSS = `
:root{--cf-bg:#fff;--cf-fg:#111;--cf-muted:#71717a;--cf-border:#dedede;--cf-hover:#e7e7e7;--cf-accent:#18181b;--cf-accent-fg:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--cf-bg);color:var(--cf-fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}
.global-header{height:36px;border-bottom:1px solid var(--cf-border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:#fafafa;position:sticky;top:0;z-index:2}.brand{font-weight:700}.global-header form{display:flex;align-items:center;gap:10px;color:var(--cf-muted)}button,.button{border:1px solid var(--cf-border);background:#fff;border-radius:5px;padding:5px 9px;cursor:pointer}.button.primary,button.primary{background:var(--cf-accent);border-color:var(--cf-accent);color:var(--cf-accent-fg)}
.page,.repo-page{width:100%;max-width:none;margin:0;padding:8px 16px}.auth-page{min-height:100vh;display:grid;place-items:center}.auth-card{width:min(360px,calc(100vw - 32px));display:grid;gap:12px;border:1px solid var(--cf-border);padding:18px}.auth-card h1{margin:0 0 8px}.auth-card label,.edit-page label,.settings-page label{display:grid;gap:5px;color:var(--cf-muted)}input,textarea{border:1px solid var(--cf-border);border-radius:5px;padding:8px;background:#fff;color:var(--cf-fg)}
.repo-header{display:flex;justify-content:space-between;align-items:end;gap:16px;border-bottom:1px solid var(--cf-border);padding:2px 0 6px}.repo-header h1{font-size:21px;margin:0}.owner,.eyebrow,.muted{color:var(--cf-muted)}.role,.state{border:1px solid var(--cf-border);border-radius:999px;padding:2px 8px;text-transform:uppercase;font-size:11px}.state.open{background:#f6f6f6}.state.closed{background:#eee}.state.merged{background:#e9e7ff}
.repo-tabs,.subtabs{display:flex;gap:4px;border-bottom:1px solid var(--cf-border);margin-bottom:8px}.repo-tabs a,.subtabs a{padding:6px 12px;color:var(--cf-muted)}.repo-tabs a.active,.subtabs a.active{color:var(--cf-fg);border-bottom:2px solid var(--cf-fg);font-weight:600}.repo-body{padding-bottom:20px}
.page-title,.file-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:5px 0}.page-title h1,.file-toolbar h1{margin:0;font-size:21px}.compact h1{font-size:19px}.toolbar-actions{display:flex;gap:8px;align-items:center}.repo-summary{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid var(--cf-border);padding:12px 0 14px}.repo-summary h1{font-size:30px;margin:0}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));border:1px solid var(--cf-border)}.summary-grid a{padding:12px;border-left:1px solid var(--cf-border)}.summary-grid a:first-child{border-left:0}.summary-grid strong{display:block;font-size:22px}.summary-grid span{color:var(--cf-muted)}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:18px}.section-title{display:flex;justify-content:space-between;align-items:center}.section-title h2{font-size:16px}.section-title a{color:var(--cf-muted);font-size:13px}.list{border:1px solid var(--cf-border);border-radius:6px;overflow:hidden}.list-row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:9px 12px;border-top:1px solid var(--cf-border)}.list-row:first-child{border-top:0}.list-row:hover{background:var(--cf-hover)}.list-row span,.list-row small{color:var(--cf-muted)}.empty{padding:18px;color:var(--cf-muted);border:1px solid var(--cf-border);border-radius:6px}
.document{border-top:1px solid var(--cf-border);padding:14px 0}.cf-theme-scope{--cf-content-max-width:100%;--cf-sidenote-width:0px;--cf-doc-content-padding-inline:clamp(20px,4vw,48px)}.cf-reader{max-width:none;width:100%}.cf-doc-flow h1,.markdown-body h1{font-size:30px;line-height:1.15}.cf-doc-flow p,.markdown-body p{max-width:none}.thread{max-width:none}.thread-header{border-bottom:1px solid var(--cf-border);padding:8px 0}.thread-header h1{font-size:24px;margin:8px 0}.thread-header h1 span{color:var(--cf-muted);font-weight:400}.issue-document{border-bottom:1px solid var(--cf-border);padding:14px 0}.comment,.event{border:1px solid var(--cf-border);border-radius:6px;margin:12px 0;padding:12px}.comment-meta{color:var(--cf-muted);font-size:13px;border-bottom:1px solid var(--cf-border);padding-bottom:8px;margin-bottom:10px}.comment-form,.review-form{display:grid;gap:10px;margin:14px 0}.comment-form textarea,.review-form textarea{min-height:92px}
.review-page{display:grid;gap:8px}.changed-files{display:flex;gap:6px;overflow-x:auto;border:1px solid var(--cf-border);border-radius:6px;padding:6px;background:#fafafa}.changed-files a{display:flex;align-items:center;gap:8px;max-width:360px;min-width:0;padding:5px 8px;border:1px solid transparent;border-radius:4px;background:#fff;white-space:nowrap}.changed-files a span{min-width:0;overflow:hidden;text-overflow:ellipsis}.changed-files a.active{border-color:var(--cf-fg);font-weight:600}.changed-files a:hover{background:var(--cf-hover)}.changed-files small{color:var(--cf-muted);flex:0 0 auto}.diff-panel{min-width:0;border:1px solid var(--cf-border);border-radius:6px;overflow:auto}.diff-title{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--cf-border);background:#fafafa}.diff-controls{display:flex;gap:18px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--cf-border);background:#fff}.diff-controls div{display:flex;gap:4px;align-items:center}.diff-controls span{color:var(--cf-muted);font-size:12px}.diff-controls a,.diff-controls .disabled{font-size:12px;padding:4px 7px;border-radius:4px}.diff-controls a:hover,.diff-controls a.active{background:var(--cf-hover);color:var(--cf-fg)}.diff-controls .disabled{opacity:.4}.patch{width:100%;border-collapse:collapse;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.patch td{vertical-align:top;padding:0}.patch pre{margin:0;white-space:pre-wrap;word-break:break-word}.patch .sign{width:28px;text-align:center;color:var(--cf-muted);user-select:none}.patch tr.add{background:rgb(34 197 94 / .09)}.patch tr.del{background:rgb(239 68 68 / .09)}.patch tr.hunk{background:#f3f3f3;color:var(--cf-muted)}.source-split,.rich-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0}.source-split section,.rich-split section{min-width:0;border-left:1px solid var(--cf-border);padding:0 10px 14px}.source-split section:first-child,.rich-split section:first-child{border-left:0}.source-split h3,.rich-split h3,.source-after h3{font-size:12px;color:var(--cf-muted);font-weight:500;margin:0 -10px 8px;padding:8px 10px;border-bottom:1px solid var(--cf-border);background:#fafafa}.source-lines{width:100%;border-collapse:collapse;font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.source-lines td{vertical-align:top;padding:0}.source-lines td:first-child{width:42px;text-align:right;padding-right:10px;color:var(--cf-muted);user-select:none}.source-lines pre{margin:0;white-space:pre-wrap;word-break:break-word}.source-lines tr.marked{background:rgb(34 197 94 / .09)}.source-split section:first-child .source-lines tr.marked{background:rgb(239 68 68 / .09)}.rich-after{padding:12px}.rich-split .cf-reader{max-width:none}
.edit-page{display:grid;gap:8px}.edit-page .file-toolbar{margin:0}.edit-page textarea{min-height:62vh;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.settings-page{display:grid;gap:12px;max-width:560px}
#web-editor-root{height:calc(100vh - 210px);min-height:520px;border:1px solid var(--cf-border);border-radius:6px;overflow:hidden}.web-editor-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--cf-bg);color:var(--cf-fg)}.web-editor-main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) 220px}.web-editor-main .cm-host{min-width:0;min-height:0;display:flex;flex-direction:column}.web-editor-main .cm-editor{height:100%;min-height:0}.web-editor-outline{border-left:1px solid var(--cf-border);background:#fafafa;overflow:auto}.web-editor-outline h2{font-size:13px;margin:0;padding:9px 10px;border-bottom:1px solid var(--cf-border)}.web-editor-outline ol{list-style:none;margin:0;padding:6px 0}.web-editor-outline li button{width:100%;border:0;border-radius:0;background:transparent;text-align:left;padding:4px 10px;font-size:13px}.web-editor-outline li button:hover{background:var(--cf-hover)}.web-editor-outline p{color:var(--cf-muted);font-size:13px;padding:0 10px}.web-editor-loading{padding:16px;color:var(--cf-muted)}.web-editor-statusbar{height:30px;border-top:1px solid var(--cf-border);display:flex;align-items:center;gap:8px;padding:0 8px;font-size:12px;color:var(--cf-muted);background:#fff}.web-editor-statusbar button,.web-editor-statusbar select{font-size:12px;padding:2px 6px}.web-editor-file{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cf-fg)}.web-editor-status{flex:1;text-align:center;min-width:80px}.web-editor-branch{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dirty-dot{color:var(--cf-accent)}
@media(max-width:800px){.two-col,.review-page{grid-template-columns:1fr}.web-editor-main{grid-template-columns:1fr}.web-editor-outline{display:none}.summary-grid{grid-template-columns:1fr}.repo-summary{display:block}.list-row{grid-template-columns:1fr}.global-header{position:static}}
`;
