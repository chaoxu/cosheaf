import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { fileLineToWritePosition } from "../diff-position.js";
import { ForgejoError, type ForgejoPull, mergePullWithRetry } from "../forgejo.js";
import type { ForgejoBranch, ForgejoLabel, ForgejoMilestone, ForgejoPullReviewComment, ForgejoUser } from "../forgejo-types.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { safeRel } from "./files.js";
import {
  badRequestPage,
  forbiddenPage,
  htmlResponse,
  notFoundPage,
  parseListState,
  positiveInt,
  queryText,
  redirect,
  repoHref,
  safeWebRedirect,
  stringField,
  stringFields,
  textField,
  urlPath,
  userLink,
  webRoute,
  webRouteForAdmin,
  webRouteForWrite,
  type WebCtx,
  type WebListState,
} from "./web-context.js";
import { emptyHtml, html, type Html } from "./web-html.js";
import { branchIcon } from "./icons.js";
import { parsePositiveInt, parsePositiveIntList } from "./query-params.js";
import { composeField } from "./web-markdown.js";
import { webCommentEditorAssets } from "./web-shell.js";
import {
  diffModeControls,
  mapLineComments,
  parseDiffMode,
  parseDiffShape,
  prFileVersions,
  prFilesHref,
  renderFileCommentSummary,
  renderPrFileView,
  splitDiffByFile,
} from "./web-pulls-diff.js";
import { USERNAME_DATALIST_ID, branchOptions, labelChips, repoPageShell, selected, sortField, stateToggle, usernameDatalist } from "./web-page.js";
import {
  isVisibleReview,
  labelSelectionPatch,
  labelsPanel,
  listRowSide,
  milestoneFormValue,
  pullEditPage,
  pullStateForm,
  renderPullTimeline,
  reviewForms,
  reviewersPanel,
  threadDescription,
  threadLayout,
  threadParticipantsBar,
} from "./web-thread.js";

async function pullCommentFor(
  ctx: WebCtx,
  pullNumber: number,
  commentId: number,
): Promise<ForgejoPullReviewComment | null> {
  const comments = await ctx.fj.listPullComments(ctx.owner, ctx.repo, pullNumber);
  return comments.find((comment) => comment.id === commentId) ?? null;
}

export function registerPullRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/pulls", webRoute(async (c, ctx) => {
  const filters = parsePullListFilters(c);
  const [pulls, labels, milestones, collaborators] = await Promise.all([
    ctx.fj.listPulls(ctx.owner, ctx.repo, {
      state: filters.state,
      labels: filters.labels.length > 0 ? filters.labels : undefined,
      milestone: filters.milestone,
      poster: filters.author || undefined,
      sort: filters.sort || undefined,
    }),
    ctx.fj.listLabels(ctx.owner, ctx.repo),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all"),
    ctx.fj.listCollaborators(ctx.owner, ctx.repo).catch(() => []),
  ]);
  // Forgejo's /pulls has no title-search param, so filter the fetched page in
  // memory (a thin pass-through, not a SQLite mirror).
  const needle = filters.q.toLowerCase();
  const visible = needle ? pulls.filter((p) => p.title.toLowerCase().includes(needle)) : pulls;
  return htmlResponse(
    repoPageShell(
      ctx,
      "pulls",
      `PRs - ${ctx.repo}`,
      html`
        <div class="page-title compact">
          <div><h1>PRs</h1></div>
          ${ctx.ws.role === "read" ? "" : html`<a class="button primary" href="${repoHref(ctx.owner, ctx.repo, "/pulls/new")}">New PR</a>`}
        </div>
        ${pullFilterForm(ctx.owner, ctx.repo, filters, labels, milestones, collaborators)}
        ${pullList(ctx.owner, ctx.repo, visible, "No matching pull requests.")}
        <script src="/cosheaf-user-autocomplete.js" defer></script>
      `,
    ),
  );
}));

web.get("/:owner/:repo/pulls/new", webRouteForWrite(async (c, ctx) => {
  const branches = await ctx.fj.listBranches(ctx.owner, ctx.repo);
  const head = stringField(c.req.query("head"));
  const base = stringField(c.req.query("base")) ?? "main";
  return htmlResponse(
    repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, branches, { head, base })),
  );
}));

web.post("/:owner/:repo/pulls/new", webRouteForWrite(async (c, ctx) => {
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
      repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, branches, { ...values, error })),
      400,
    );
  }
  if (!head || !title) return badRequestPage(ctx.user, "Pull request head and title are required.");
  try {
    const pull = await ctx.fj.createPull(ctx.owner, ctx.repo, { head, base, title, body });
    c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "opened" });
    return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
  } catch (err) {
    if (!(err instanceof ForgejoError) || !(err.status === 409 || err.status === 422)) throw err;
    // Never echo Forgejo's body into the form — it leaks the internal forge URL.
    console.error(`[${c.get("requestId") ?? ""}] create PR ${ctx.owner}/${ctx.repo} ${head}->${base} failed (${err.status})`);
    // A 409 usually means a PR already exists for this head->base (open OR closed-
    // unmerged); navigate to it instead of erroring (#181). Other 409/422 get a
    // clean canned message.
    const existing = (await ctx.fj.listPulls(ctx.owner, ctx.repo, "all").catch(() => []))
      .find((p) => p.head.ref === head && p.base.ref === base && !p.merged);
    if (existing) return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${existing.number}`));
    return htmlResponse(
      repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, branches, {
        ...values,
        error: "Couldn't open a pull request — there may be no changes to propose between these branches, or the request was invalid.",
      })),
      err.status,
    );
  }
}));

web.get("/:owner/:repo/pulls/:number", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const [reviews, comments, timeline, commits, availableReviewers, allLabels] = await Promise.all([
    ctx.fj.listReviews(ctx.owner, ctx.repo, pull.number),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, pull.number),
    ctx.fj.listPullCommits(ctx.owner, ctx.repo, pull.number),
    ctx.fj.listPullReviewers(ctx.owner, ctx.repo).catch(() => []),
    ctx.ws.role === "read" ? Promise.resolve([]) : ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
  ]);
  const timelineHtml = await renderPullTimeline(ctx, pull.number, reviews, comments, timeline, commits);
  // The participants bar must reflect the conversation the timeline shows —
  // submitted reviews + inline review comments — not just the line comments, so
  // its count, "last reply", and chips (incl. reviewers) match what's rendered
  // below. Same review filter as renderPullTimeline; sorted so "last" is latest.
  const conversation = [
    ...reviews
      .filter(isVisibleReview)
      .map((r) => ({ user: r.user, created_at: r.submitted_at })),
    ...comments.map((c) => ({ user: c.user, created_at: c.created_at })),
  ].sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
  return htmlResponse(
    repoPageShell(
      ctx,
      "pulls",
      `#${pull.number} ${pull.title}`,
      html`
        <article class="thread">
          <header class="thread-header">
            <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : pull.state}</span>
            <div class="thread-title-row">
              <h1>${pull.title} <span>#${pull.number}</span></h1>
              <div class="toolbar-actions">
                ${
                  ctx.ws.role === "read" || pull.state === "closed"
                    ? ""
                    : html`<a class="button" data-testid="pull-edit-link" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/edit`)}">Edit PR</a>`
                }
                ${pull.merged ? "" : html`<a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>`}
                ${pullStateForm(ctx, pull)}
              </div>
            </div>
            <p>by ${userLink(pull.user?.login)}${pull.base.ref !== "main" ? html` · into <code class="branch-ref">${branchIcon({ size: 12 })}${pull.base.ref}</code>` : ""}</p>
            <nav class="subtabs">
              <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
              <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
            </nav>
          </header>
          ${threadLayout(
            html`${threadParticipantsBar(pull.user, conversation)}
              ${await threadDescription(ctx, pull.body ?? "")}
              ${timelineHtml}
              ${reviewForms(ctx, pull)}
              <span id="thread-bottom"></span>
              ${ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID ? webCommentEditorAssets() : emptyHtml}`,
            [
              labelsPanel({ ctx, current: pull.labels ?? [], allLabels, action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/labels`) }),
              reviewersPanel(ctx, pull, availableReviewers),
            ],
          )}
        </article>
      `,
    ),
  );
}));

web.get("/:owner/:repo/pulls/:number/edit", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const [allLabels, milestones] = await Promise.all([
    ctx.fj.listLabels(ctx.owner, ctx.repo),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all"),
  ]);
  return htmlResponse(
    repoPageShell(ctx, "pulls", `Edit #${pull.number} - ${ctx.repo}`, pullEditPage(ctx, pull, allLabels, milestones)),
  );
}));

web.post("/:owner/:repo/pulls/:number/edit", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const title = stringField(form.title);
  const body = textField(form.body);
  if (!title || body === null) return badRequestPage(ctx.user, "Pull request title and description are required.");
  const labelPatch = await labelSelectionPatch(ctx, form, pull.labels ?? []);
  if (!labelPatch.ok) return badRequestPage(ctx.user, labelPatch.message);
  const milestonePatch = milestoneFormValue(form.milestone);
  if (!milestonePatch.ok) return badRequestPage(ctx.user, milestonePatch.message);
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, {
    title,
    body,
    labels: labelPatch.labels,
    ...(milestonePatch.milestone !== undefined ? { milestone: milestonePatch.milestone } : {}),
  });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/labels", webRouteForWrite(async (c, ctx) => {
  // Inline label editing from the rail Labels panel (#110): set the selected
  // label ids via Forgejo and return to the PR thread.
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const labelPatch = await labelSelectionPatch(ctx, await c.req.parseBody({ all: true }), pull.labels ?? []);
  if (!labelPatch.ok) return badRequestPage(ctx.user, labelPatch.message);
  if (labelPatch.labels) await ctx.fj.setIssueLabels(ctx.owner, ctx.repo, pull.number, labelPatch.labels);
  c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/state", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.merged) return forbiddenPage(ctx.user);
  const state = stringField((await c.req.parseBody()).state);
  if (state !== "open" && state !== "closed") return badRequestPage(ctx.user, "State must be open or closed.");
  await ctx.fj.editPull(ctx.owner, ctx.repo, pull.number, { state });
  c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: state === "closed" ? "closed" : "reopened" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/review-requests", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody({ all: true });
  const reviewers = stringFields(form.reviewers);
  if (reviewers.length === 0) return badRequestPage(ctx.user, "At least one reviewer is required.");
  await ctx.fj.createPullReviewRequests(ctx.owner, ctx.repo, pull.number, reviewers);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/review-requests/delete", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const reviewer = stringField((await c.req.parseBody()).reviewer);
  if (!reviewer) return badRequestPage(ctx.user, "Reviewer is required.");
  await ctx.fj.deletePullReviewRequests(ctx.owner, ctx.repo, pull.number, [reviewer]);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/reviews", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const event = stringField(form.event);
  const body = stringField(form.body) ?? "";
  if (event !== "APPROVED" && event !== "REQUEST_CHANGES" && event !== "COMMENT")
    return badRequestPage(ctx.user, "Review event is required.");
  if (event !== "COMMENT" && pull.user?.login === ctx.user) return forbiddenPage(ctx.user);
  await ctx.fj.createReview(ctx.owner, ctx.repo, pull.number, { event, body });
  const redirectTo = safeWebRedirect(stringField(form.redirect_to));
  return redirect(redirectTo ?? repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/comments/:id/edit", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!pull || !id) return notFoundPage(ctx.user, "Comment not found");
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  const comment = await pullCommentFor(ctx, pull.number, id);
  if (!comment) return notFoundPage(ctx.user, "Comment not found");
  await ctx.fj.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/comments/:id/delete", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const reviewId = positiveInt(stringField((await c.req.parseBody()).review_id) ?? undefined);
  if (!pull || !id || !reviewId) return notFoundPage(ctx.user, "Comment not found");
  const comment = await pullCommentFor(ctx, pull.number, id);
  if (!comment) return notFoundPage(ctx.user, "Comment not found");
  if (comment.pull_request_review_id !== reviewId) return badRequestPage(ctx.user, "Review id does not match comment.");
  await ctx.fj.deleteReviewComment(ctx.owner, ctx.repo, pull.number, reviewId, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/comments", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
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
  // Mirror the files-page gate: a non-markdown file's redirect stays in source.
  const richOk = ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID && fileKindForPath(path) === "markdown";
  const mode = parseDiffMode(stringField(form.mode) ?? undefined, richOk);
  const shape = parseDiffShape(stringField(form.shape) ?? undefined, mode);
  return redirect(
    `${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}?file=${encodeURIComponent(path)}&mode=${mode}&shape=${shape}`,
  );
}));

web.post("/:owner/:repo/pulls/:number/merge", webRouteForAdmin(async (c, ctx) => {
  // Merge is irreversible: re-check admin against Forgejo (bypassing the 30s role
  // cache), mirroring requireAdminFresh on the typed route and the repo-delete
  // route — so a just-demoted admin can't merge in the stale window.
  const fresh = await ctx.fj.getRepoPermission(ctx.owner, ctx.repo, ctx.user);
  if (fresh !== "admin") return notFoundPage(ctx.user, "Repository not found");
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const prHref = repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`);
  // "Merge anyway" submits force=true: an explicit, admin-only bypass of the
  // required-approvals branch protection. #180 keeps the implicit/editor path
  // honest (no silent force); this is a deliberate click. force does NOT bypass
  // a real content conflict.
  const force = (await c.req.parseBody()).force === "true";
  try {
    await mergePullWithRetry(() => ctx.fj.mergePull(ctx.owner, ctx.repo, pull.number, { Do: "squash", force }));
  } catch (err) {
    if (!(err instanceof ForgejoError)) throw err;
    // Never surface Forgejo's raw body — it carries the internal backend URL.
    console.error(`[${c.get("requestId") ?? ""}] web merge ${ctx.owner}/${ctx.repo}#${pull.number} failed (${err.status})`);
    const blocked = err.status === 405 || err.status === 409;
    // Re-read the PR — the pre-merge snapshot's mergeable can be stale/null. A real
    // content conflict (mergeable === false) isn't an approvals problem and "Merge
    // anyway" won't fix it; a still-null mergeable is transient, not approvals (#7).
    const fresh2 = blocked ? await ctx.fj.getPull(ctx.owner, ctx.repo, pull.number).catch(() => null) : null;
    const msg = !blocked
      ? "The merge service is unavailable — try again in a moment."
      : fresh2?.mergeable === false
        ? "This pull request has conflicts with main that must be resolved before it can merge."
        : fresh2?.mergeable == null
          ? "Mergeability is still being computed — try again in a moment."
          : force
            ? "Merge still failed — try again in a moment."
            : "This pull request needs its required approvals. Use “Merge anyway” to bypass them.";
    return redirect(`${prHref}?toast=${encodeURIComponent(msg)}&toastKind=error`);
  }
  if (pull.head.ref && pull.head.ref !== "main") {
    await deleteBranchQuietly(ctx.fj, ctx.owner, ctx.repo, pull.head.ref);
  }
  invalidateRepoTrees(ctx.owner, ctx.repo);
  c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "merged" });
  return redirect(`${prHref}?toast=${encodeURIComponent("Merged to main")}&toastKind=success`);
}));

web.get("/:owner/:repo/pulls/:number/files", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  const [files, allComments] = await Promise.all([
    pullFiles(ctx, pull.number),
    ctx.fj.listPullComments(ctx.owner, ctx.repo, pull.number),
  ]);
  const selected = c.req.query("file") ?? files[0]?.path ?? "";
  const file = files.find((f) => f.path === selected) ?? files[0] ?? null;
  // Rich rendering is only meaningful for markdown; a .bib/.json/.png/binary file
  // fed through the Coflat reader renders as garbage (#2). Gate rich on the
  // selected file's kind so those default to (and are pinned to) source.
  const richOk = ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID && file !== null && fileKindForPath(file.path) === "markdown";
  const mode = parseDiffMode(c.req.query("mode"), richOk);
  const shape = parseDiffShape(c.req.query("shape"), mode);
  const versions = file && shape !== "unified" ? await prFileVersions(ctx, pull, file) : null;
  const fileComments = file ? await mapLineComments(ctx, file, allComments) : [];
  return htmlResponse(
    repoPageShell(
      ctx,
      "pulls",
      `Files #${pull.number} - ${ctx.repo}`,
      html`
        <header class="thread-header">
          <span class="state ${pull.merged ? "merged" : pull.state}">${pull.merged ? "merged" : pull.state}</span>
          <div class="thread-title-row">
            <h1>${pull.title} <span>#${pull.number}</span></h1>
            ${pull.merged ? "" : html`<a class="button" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(pull.head.ref)}">View branch output</a>`}
          </div>
          <nav class="subtabs">
            <a href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`)}">Conversation</a>
            <a class="active" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/files`)}">Files changed</a>
          </nav>
        </header>
        <script src="/cosheaf-pr-diff-defaults.js" data-rich-diff="${richOk ? "1" : ""}"></script>
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
                    ${diffModeControls(ctx, pull.number, file.path, mode, shape, richOk)}
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
          ${ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID ? webCommentEditorAssets() : emptyHtml}
        </div>
      `,
      // Load the reader island on coflat in BOTH modes: rich diffs need it, and
      // so do the now-markdown-rendered line comments (which are reader islands)
      // even in source mode.
      { readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID },
    ),
  );
}));
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
    previous_path: meta.previous_filename,
    status: meta.status,
    additions: meta.additions,
    deletions: meta.deletions,
    patch: sections.get(meta.filename) ?? "",
  }));
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
  q: string;
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
    q: queryText(c, "q"),
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
          <h1>New PR</h1>
        </div>
        <a class="button subtle" href="${repoHref(ctx.owner, ctx.repo, "/pulls")}">Cancel</a>
      </div>
      ${values.error ? html`<div class="form-error" role="alert">${values.error}</div>` : ""}
      <form class="compose-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/pulls/new")}" data-testid="pull-create-form">
        <div class="branch-compare">
          <label>Base
            <select name="base" required data-testid="pull-create-base" data-option-icon="branch">
              ${branchOptions(branches, base)}
            </select>
          </label>
          <label>Head
            <select name="head" required data-testid="pull-create-head" data-option-icon="branch">
              ${branchOptions(branches, head)}
            </select>
          </label>
        </div>
        <label>Title
          <input name="title" value="${values.title ?? ""}" required data-testid="pull-create-title">
        </label>
        <label>Description
          ${composeField(ctx, { value: values.body ?? "", testId: "pull-create-body" })}
        </label>
        <div class="form-actions">
          <button class="button primary" type="submit" data-testid="pull-create-submit">Create PR</button>
        </div>
      </form>
      ${ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID ? webCommentEditorAssets() : emptyHtml}
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
  collaborators: readonly ForgejoUser[],
): Html {
  const action = repoHref(owner, repo, "/pulls");
  return html`<form class="filter-panel filter-panel--compact" method="get" action="${action}" data-testid="pull-filters" data-list-prefs="pulls">
    ${usernameDatalist(collaborators)}
    <div class="filter-basic">
      ${stateToggle(filters.state)}
      <label class="filter-search">Search <input name="q" value="${filters.q}" placeholder="title text" aria-label="Search pull requests"></label>
      ${sortField(filters.sort, PULL_SORT_OPTIONS)}
      <div class="filter-actions">
        <button class="link-button" type="submit">apply</button>
        <a class="link-button" href="${action}">reset</a>
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
        <label>Author <input name="author" value="${filters.author}" autocomplete="off" list="${USERNAME_DATALIST_ID}" data-user-autocomplete="${repoHref(owner, repo, "/user-suggestions")}" placeholder="username" aria-label="Author filter"></label>
      </div>
    </details>
  </form>`;
}

function pullList(owner: string, repo: string, pulls: ForgejoPull[], emptyText = "No pull requests."): Html {
  const rows = pulls.map((pull) => {
    const state = pull.merged ? "merged" : pull.state;
    // The head branch name is noise; the base only matters when it isn't main.
    const basesNonMain = pull.base.ref !== "main";
    const labels = pull.labels ?? [];
    const hasMeta = basesNonMain || Boolean(pull.milestone) || labels.length > 0;
    const href = repoHref(owner, repo, `/pulls/${pull.number}`);
    return html`<div class="list-row pull-row">
      <span class="list-row-main">
        <span class="list-row-title"><span class="state ${state}">${state}</span><a class="list-row-title-link" href="${href}"><strong>${pull.title}</strong><span class="muted">#${pull.number}</span></a></span>
        ${hasMeta ? html`<span class="list-meta">${basesNonMain ? html`<span class="meta-pill branch-ref">${branchIcon({ size: 11 })}${pull.base.ref}</span>` : ""}${pull.milestone ? html`<span class="meta-pill">${pull.milestone.title}</span>` : ""}${labelChips(labels)}</span>` : ""}
      </span>
      ${listRowSide(pull.user, pull.created_at, pull.comments)}
    </div>`;
  });
  return html`<div class="list">${rows.length ? rows : html`<div class="empty">${emptyText}</div>`}</div>`;
}
