import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { changedLines, commentableLines, patchRows } from "../diff-lines.js";
import { fileLineToWritePosition, positionToFileLine, type Side } from "../diff-position.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { ForgejoError, type ForgejoPull, mergePullWithRetry } from "../forgejo.js";
import type { ForgejoBranch, ForgejoLabel, ForgejoMilestone, ForgejoPullReviewComment } from "../forgejo-types.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { safeRel } from "./files.js";
import {
  badRequestPage,
  displayLogin,
  forbiddenPage,
  formatDate,
  htmlResponse,
  notFoundPage,
  parseListState,
  positiveInt,
  queryText,
  redirect,
  repoHref,
  resolveWebRepo,
  resolveWebRepoForWrite,
  safeWebRedirect,
  stringField,
  stringFields,
  textField,
  urlPath,
  type WebCtx,
  type WebListState,
} from "./web-context.js";
import { html, type Html } from "./web-html.js";
import { parsePositiveInt, parsePositiveIntList } from "./query-params.js";
import { renderMarkdownSurface } from "./web-markdown.js";
import { branchOptions, labelChips, repoPage, selected, sortField, stateField } from "./web-page.js";
import {
  labelSelectionPatch,
  labelsRailPanel,
  pullEditPage,
  pullStateForm,
  renderPullTimeline,
  reviewForms,
  reviewRequestPanel,
  threadLayout,
} from "./web-thread.js";

export function registerPullRoutes(web: Hono<AppEnv>): void {
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
      body: html`
        <div class="page-title compact">
          <div><p class="eyebrow">${filters.state}</p><h1>Pull requests</h1></div>
          ${ctx.ws.role === "read" ? "" : html`<a class="button primary" href="${repoHref(ctx.owner, ctx.repo, "/pulls/new")}">New pull request</a>`}
        </div>
        ${pullFilterForm(ctx.owner, ctx.repo, filters, labels, milestones)}
        ${pullList(ctx.owner, ctx.repo, pulls, "No matching pull requests.")}
      `,
    }),
  );
});

web.get("/:owner/:repo/pulls/new", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const [reviews, comments, timeline, commits, availableReviewers] = await Promise.all([
    ctx.fj.listReviews(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, pull.number).catch(() => []),
    ctx.fj.listPullCommits(ctx.owner, ctx.repo, pull.number).catch(() => []),
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
      body: html`
        <article class="thread">
          <header class="thread-header">
            <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : pull.state}</span>
            <div class="thread-title-row">
              <h1>${pull.title} <span>#${pull.number}</span></h1>
              <div class="toolbar-actions">
                ${
                  ctx.ws.role === "read" || pull.state === "closed"
                    ? ""
                    : html`<a class="button" data-testid="pull-edit-link" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/edit`)}">Edit pull request</a>`
                }
                <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>
                ${pullStateForm(ctx, pull)}
              </div>
            </div>
            <p>${pull.head.ref} into ${pull.base.ref} - by ${displayLogin(ctx.owner, pull.user?.login)}</p>
            <nav class="subtabs">
              <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
              <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
            </nav>
          </header>
          ${threadLayout(
            html`<div class="comment">
                <div class="comment-meta">${displayLogin(ctx.owner, pull.user?.login)}</div>
                ${body.length ? body : html`<p>No description.</p>`}
              </div>
              ${timelineHtml}
              ${reviewForms(ctx, pull)}`,
            html`${labelsRailPanel(pull.labels ?? [])}
              ${reviewRequestPanel(ctx, pull, availableReviewers)}`,
          )}
        </article>
      `,
    }),
  );
});

web.get("/:owner/:repo/pulls/:number/edit", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const allLabels = await ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Edit #${pull.number} - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "pulls",
      user: ctx.user,
      ws: ctx.ws,
      body: pullEditPage(ctx, pull, allLabels),
    }),
  );
});

web.post("/:owner/:repo/pulls/:number/edit", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const title = stringField(form.title);
  const body = textField(form.body);
  if (!title || body === null) return badRequestPage(ctx.user, "Pull request title and description are required.");
  const labelPatch = await labelSelectionPatch(ctx, form, pull.labels ?? []);
  if (!labelPatch.ok) return badRequestPage(ctx.user, labelPatch.message);
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, { title, body, labels: labelPatch.labels });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/labels", async (c) => {
  // Label editing moved into the pull request edit page; keep redirecting old form posts.
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Pull request not found");
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${number}/edit`));
});

web.post("/:owner/:repo/pulls/:number/state", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const reviewer = stringField((await c.req.parseBody()).reviewer);
  if (!reviewer) return badRequestPage(ctx.user, "Reviewer is required.");
  await ctx.fj.deletePullReviewRequests(ctx.owner, ctx.repo, pull.number, [reviewer]);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/reviews", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!pull || !id) return notFoundPage(ctx.user, "Comment not found");
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  await ctx.fj.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/comments/:id/delete", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const reviewId = positiveInt(stringField((await c.req.parseBody()).review_id) ?? undefined);
  if (!pull || !id || !reviewId) return notFoundPage(ctx.user, "Comment not found");
  await ctx.fj.deleteReviewComment(ctx.owner, ctx.repo, pull.number, reviewId, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
});

web.post("/:owner/:repo/pulls/:number/comments", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
      body: html`
        <header class="thread-header">
          <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : pull.state}</span>
          <div class="thread-title-row">
            <h1>${pull.title} <span>#${pull.number}</span></h1>
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
              ${files.map(
                (f) => html`
                    <a class="${f.path === file?.path ? "active" : ""}" href="${prFilesHref(ctx, pull.number, f.path, mode, shape)}">
                      <span>${f.path}</span>
                    </a>
                  `,
              )}
            </nav>
            <section class="diff-panel">
              ${
                file
                  ? html`<div class="diff-title"><strong>${file.path}</strong><span>+${file.additions} -${file.deletions}</span></div>
                    ${diffModeControls(ctx, pull.number, file.path, mode, shape)}
                    ${await renderPrFileView(ctx, pull, file, mode, shape, versions, fileComments)}`
                  : html`<div class="empty">No changed files.</div>`
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
): Promise<Html> {
  if (mode === "source" && shape === "unified") {
    return html`<div data-testid="diff-pane-unified">${renderPatch(file.patch)}</div>`;
  }
  const nextVersions = versions ?? (await prFileVersions(ctx, pull, file.path));
  const changed = changedLines(file.patch);
  const commentable = commentableLines(file.patch);
  const commentForm = commentFormOptions(ctx, pull, file.path, mode, shape);
  if (mode === "source" && shape === "split") {
    return html`<div data-testid="diff-pane-split" class="source-split">
      ${sourcePane("Base", nextVersions.base, "base", changed.deleted, commentable.base, comments, commentForm)}
      ${sourcePane("Head", nextVersions.head, "head", changed.added, commentable.head, comments, commentForm)}
    </div>`;
  }
  if (mode === "source") {
    return html`<div data-testid="diff-pane-after" class="source-after">${sourcePane("After", nextVersions.head, "head", changed.added, commentable.head, comments, commentForm)}</div>`;
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
    return html`<div data-testid="diff-pane-split" class="rich-split cf-theme-scope">
      <section><h3>Base</h3>${base}</section>
      <section><h3>Head</h3>${head}</section>
    </div>`;
  }
  const head = await renderMarkdownSurface(ctx, nextVersions.head, {
    branch: pull.head.ref,
    documentPath: file.path,
    surface: "document",
  });
  return html`<div data-testid="diff-pane-after" class="rich-after cosheaf-document-reader cf-theme-scope">${head}</div>`;
}

function diffModeControls(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape): Html {
  const href = (nextMode: DiffMode, nextShape: DiffShape) => prFilesHref(ctx, prNumber, filePath, nextMode, nextShape);
  const modeLink = (id: DiffMode, label: string) =>
    html`<a data-testid="view-mode-${id}" class="${mode === id ? "active" : ""}" href="${href(id, parseDiffShape(shape, id))}">${label}</a>`;
  const shapeLink = (id: DiffShape, label: string) => {
    if (mode === "rich" && id === "unified") return html`<span data-testid="view-shape-unified" class="disabled">Unified</span>`;
    return html`<a data-testid="view-shape-${id}" class="${shape === id ? "active" : ""}" href="${href(mode, id)}">${label}</a>`;
  };
  return html`<div class="diff-controls">
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
): Html {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return html`<section><h3>${title}</h3><table class="source-lines"><tbody>${lines.map((line, index) => {
    const lineNo = index + 1;
    const lineComments = comments.filter((comment) => comment.side === side && comment.line === lineNo);
    const composer = form && commentable.has(lineNo) ? lineCommentComposer(form, side, lineNo) : "";
    return html`<tr class="${marked.has(lineNo) ? "marked" : ""}" data-testid="source-line-${side}-${lineNo}">
        <td class="line-action">${composer}</td>
        <td>${lineNo}</td>
        <td><pre>${line}</pre></td>
      </tr>${lineComments.map(renderInlineComment)}`;
  })}</tbody></table></section>`;
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

function lineCommentComposer(form: LineCommentFormOptions, side: Side, line: number): Html {
  return html`<details class="line-composer">
    <summary aria-label="Comment on line ${line}">+</summary>
    <form method="post" action="${form.action}">
      <input type="hidden" name="path" value="${form.path}">
      <input type="hidden" name="side" value="${side}">
      <input type="hidden" name="line" value="${line}">
      <input type="hidden" name="mode" value="${form.mode}">
      <input type="hidden" name="shape" value="${form.shape}">
      <textarea name="body" required></textarea>
      <button type="submit">Comment</button>
    </form>
  </details>`;
}

function renderInlineComment(comment: WebLineComment): Html {
  return html`<tr class="line-comment-row" data-testid="line-comment-${comment.id}">
    <td></td>
    <td colspan="2">
      <div class="line-comment ${comment.outdated ? "outdated" : ""}">
        <strong>${comment.author}</strong>
        <span>${comment.outdated ? "outdated" : formatDate(comment.createdAt)}</span>
        <p>${comment.body}</p>
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

function renderFileCommentSummary(comments: readonly WebLineComment[]): Html {
  if (comments.length === 0) return html`<div class="file-comments empty">No line comments.</div>`;
  return html`<div class="file-comments">${comments.map(
    (comment) => html`<div class="file-comment ${comment.outdated ? "outdated" : ""}">
        <div><strong>${comment.author}</strong><span>${comment.side}:${comment.line ?? "outdated"}</span></div>
        <p>${comment.body}</p>
      </div>`,
  )}</div>`;
}

function splitDiffByFile(diff: string): Map<string, string> {
  return new Map(splitUnifiedDiff(diff).map((file) => [file.path, file.patch]));
}

function renderPatch(patch: string): Html {
  if (!patch) return html`<pre class="patch empty">No textual diff.</pre>`;
  const rows = patchRows(patch).map(
    (row) => html`<tr class="${row.kind}"><td class="sign">${row.sign}</td><td><pre>${row.text}</pre></td></tr>`,
  );
  return html`<table class="patch"><tbody>${rows}</tbody></table>`;
}

type PullListSort = "oldest" | "recentupdate" | "recentclose" | "leastupdate" | "mostcomment" | "leastcomment" | "priority";

interface PullListFilters {
  state: WebListState;
  labels: number[];
  labelValue: string;
  milestone?: number;
  milestoneValue: string;
  author: string;
  sort: PullListSort | "";
}

const PULL_SORT_OPTIONS: Array<{ value: PullListSort; label: string }> = [
  { value: "recentupdate", label: "Recently updated" },
  { value: "oldest", label: "Oldest" },
  { value: "recentclose", label: "Recently closed" },
  { value: "leastupdate", label: "Least recently updated" },
  { value: "mostcomment", label: "Most commented" },
  { value: "leastcomment", label: "Least commented" },
  { value: "priority", label: "Priority" },
];

function parsePullListFilters(c: Context<AppEnv>): PullListFilters {
  const labelValue = queryText(c, "labels");
  const milestoneValue = queryText(c, "milestone");
  const sort = queryText(c, "sort");
  return {
    state: parseListState(c.req.query("state")),
    labels: parsePositiveIntList(labelValue) ?? [],
    labelValue,
    milestone: parsePositiveInt(milestoneValue),
    milestoneValue,
    author: queryText(c, "author"),
    sort: PULL_SORT_OPTIONS.some((option) => option.value === sort) ? sort as PullListSort : "",
  };
}

function pullCreatePage(
  ctx: WebCtx,
  branches: readonly ForgejoBranch[],
  values: { head?: string | null; base?: string | null; title?: string; body?: string; error?: string } = {},
): Html {
  const base = values.base ?? "main";
  const head = values.head ?? branchAfter(branches, base);
  return html`
    <div class="form-page">
      <div class="page-title compact">
        <div>
          <p class="eyebrow">Pull requests</p>
          <h1>New pull request</h1>
        </div>
        <a class="button" href="${repoHref(ctx.owner, ctx.repo, "/pulls")}">Cancel</a>
      </div>
      ${values.error ? html`<div class="form-error" role="alert">${values.error}</div>` : ""}
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
          <input name="title" value="${values.title ?? ""}" required data-testid="pull-create-title">
        </label>
        <label>Description
          <textarea name="body" data-testid="pull-create-body">${values.body ?? ""}</textarea>
        </label>
        <div class="form-actions">
          <button class="button primary" type="submit" data-testid="pull-create-submit">Create pull request</button>
        </div>
      </form>
    </div>
  `;
}

function branchAfter(branches: readonly ForgejoBranch[], base: string): string {
  return branches.find((branch) => branch.name !== base)?.name ?? branches[0]?.name ?? "";
}

function pullFilterForm(
  owner: string,
  repo: string,
  filters: PullListFilters,
  labels: readonly ForgejoLabel[],
  milestones: readonly ForgejoMilestone[],
): Html {
  const action = repoHref(owner, repo, "/pulls");
  return html`<form class="filter-panel filter-panel--compact" method="get" action="${action}" data-testid="pull-filters">
    <div class="filter-basic">
      ${stateField(filters.state)}
      ${sortField(filters.sort, PULL_SORT_OPTIONS)}
      <div class="filter-actions">
        <button class="button primary" type="submit">Apply</button>
        <a class="button" href="${action}">Reset</a>
      </div>
    </div>
    <details class="filter-advanced">
      <summary>Advanced filters</summary>
      <div class="filter-advanced-grid">
        <label>Label
          <select name="labels" aria-label="Label filter">
            <option value="">Any label</option>
            ${labels.map((label) => html`<option value="${label.id}"${selected(filters.labelValue, String(label.id))}>${label.name}</option>`)}
          </select>
        </label>
        <label>Milestone
          <select name="milestone" aria-label="Milestone filter">
            <option value="">Any milestone</option>
            ${milestones.map((milestone) => html`<option value="${milestone.id}"${selected(filters.milestoneValue, String(milestone.id))}>${milestone.title}</option>`)}
          </select>
        </label>
        <label>Author <input name="author" value="${filters.author}" placeholder="username" aria-label="Author filter"></label>
      </div>
    </details>
  </form>`;
}

function pullList(owner: string, repo: string, pulls: ForgejoPull[], emptyText = "No pull requests."): Html {
  const rows = pulls.map((pull) => {
    const state = pull.merged ? "merged" : pull.state;
    return html`<a class="list-row pull-row" href="${repoHref(owner, repo, `/pulls/${pull.number}`)}">
      <span class="list-row-main">
        <span class="list-row-title"><span class="state ${state}">${state}</span><strong>${pull.title}</strong><span class="muted">#${pull.number}</span></span>
        <span class="list-meta">
          ${pull.head.ref} -&gt; ${pull.base.ref}
          ${pull.milestone ? html`<span class="meta-pill">${pull.milestone.title}</span>` : ""}
          ${labelChips(pull.labels ?? [])}
        </span>
      </span>
      <small>updated ${formatDate(pull.updated_at)}</small>
    </a>`;
  });
  return html`<div class="list">${rows.length ? rows : html`<div class="empty">${emptyText}</div>`}</div>`;
}
