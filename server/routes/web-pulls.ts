import type { Context, Hono } from "hono";
import { buildPdfImagePreviewPaths } from "../../shared/asset-previews.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { fileLineToWritePosition } from "../diff-position.js";
import { ForgejoError, type ForgejoPull, mergePullWithRetry } from "../forgejo.js";
import type { ForgejoBranch, ForgejoIssueComment, ForgejoLabel, ForgejoMilestone, ForgejoPullReviewComment } from "../forgejo-types.js";
import { resolveLocalWorkspace } from "../local/local-mode.js";
import { openLocalPull } from "../local/local-pulls.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteBranchQuietly } from "../workspace-cleanup.js";
import { safeRel } from "./files.js";
import { branchIcon } from "./icons.js";
import { parsePositiveInt, parsePositiveIntList } from "./query-params.js";
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
  type WebCtx,
  type WebListState,
  webRoute,
  webRouteForAdmin,
  webRouteForWrite,
} from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { composeField } from "./web-markdown.js";
import { branchOptions, labelChips, repoPageShell, selected, sortField, stateToggle, USERNAME_DATALIST_ID } from "./web-page.js";
import {
  diffModeControls,
  mapLineComments,
  type PrFileAssetPreviewPaths,
  parseDiffMode,
  parseDiffShape,
  prFilesHref,
  prFileVersions,
  renderFileCommentSummary,
  renderPrFileView,
  splitDiffByFile,
} from "./web-pulls-diff.js";
import { webCommentEditorAssets } from "./web-shell.js";
import {
  isVisibleReview,
  labelSelectionPatch,
  labelsPanel,
  listRowSide,
  milestoneFormValue,
  pullEditPage,
  pullStateForm,
  renderPullTimeline,
  reviewersPanel,
  reviewForms,
  threadDescription,
  threadLayout,
  threadParticipantsBar,
} from "./web-thread.js";

async function pullCommentFor(
  ctx: WebCtx,
  pullNumber: number,
  commentId: number,
): Promise<ForgejoPullReviewComment | null> {
  const comments = await ctx.collab.listPullComments(ctx.owner, ctx.repo, pullNumber);
  return comments.find((comment) => comment.id === commentId) ?? null;
}

async function pullIssueCommentFor(
  ctx: WebCtx,
  pullNumber: number,
  commentId: number,
): Promise<ForgejoIssueComment | null> {
  const comments = await ctx.collab.listIssueComments(ctx.owner, ctx.repo, pullNumber);
  return comments.find((comment) => comment.id === commentId) ?? null;
}

export function registerPullRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/pulls", webRoute(async (c, ctx) => {
  const filters = parsePullListFilters(c);
  const [pulls, labels, milestones] = await Promise.all([
    ctx.collab.listPulls(ctx.owner, ctx.repo, {
      state: filters.state,
      labels: filters.labels.length > 0 ? filters.labels : undefined,
      milestone: filters.milestone,
      poster: filters.author || undefined,
      sort: filters.sort || undefined,
    }),
    ctx.collab.listLabels(ctx.owner, ctx.repo),
    ctx.collab.listMilestones(ctx.owner, ctx.repo, "all"),
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
        ${pullFilterForm(ctx.owner, ctx.repo, filters, labels, milestones)}
        ${pullList(ctx.owner, ctx.repo, visible, "No matching pull requests.")}
        <script src="/cosheaf-user-autocomplete.js" defer></script>
      `,
    ),
  );
}));

web.get("/:owner/:repo/pulls/new", webRouteForWrite(async (c, ctx) => {
  const head = stringField(c.req.query("head"));
  const base = stringField(c.req.query("base")) ?? "main";
  // Local Workbench: head is the user's actual working-tree branch (from the
  // local backend), not a core branch — the working branch usually isn't pushed
  // yet. The base lives on the core, so its options come from ctx.collab; a
  // disconnected workspace degrades to no base options (the New PR flow can't
  // reach the core anyway). See docs/workbench-origin-split.md.
  if (ctx.writeMode === "direct") {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return notFoundPage(ctx.user, "Repository not found");
    const [baseBranches, headBranches, currentBranch] = await Promise.all([
      ctx.collab.listBranches(ctx.owner, ctx.repo).catch(() => [] as ForgejoBranch[]),
      entry.backend.listBranches(ctx.owner, ctx.repo),
      entry.backend.currentBranch(),
    ]);
    return htmlResponse(
      repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, baseBranches, { head, base }, { headBranches, currentBranch })),
    );
  }
  const branches = await ctx.collab.listBranches(ctx.owner, ctx.repo);
  return htmlResponse(
    repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, branches, { head, base })),
  );
}));

web.post("/:owner/:repo/pulls/new", webRouteForWrite(async (c, ctx) => {
  const form = await c.req.parseBody();
  const head = stringField(form.head);
  const base = stringField(form.base) ?? "main";
  const title = stringField(form.title);
  const body = textField(form.body) ?? "";
  const values = { head, base, title: title ?? "", body };
  // Local Workbench: a PR can't be created from ctx.collab.createPull (no push
  // step) — the head branch lives only in the working tree until it's pushed.
  // Route through the shared commit→push→openPull flow (local-pulls.ts), the
  // same path the editor island's typed POST uses, and re-render the compare
  // page with its friendly error on failure.
  if (ctx.writeMode === "direct") {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return notFoundPage(ctx.user, "Repository not found");
    const result = await openLocalPull(entry, ctx.owner, ctx.repo, { head: head ?? undefined, base, title: title ?? undefined, body });
    if (result.ok) {
      c.get("sse").publish(ctx.ws.slug, { type: "pull", number: result.number, action: "opened" });
      return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${result.number}`));
    }
    const [baseBranches, headBranches, currentBranch] = await Promise.all([
      ctx.collab.listBranches(ctx.owner, ctx.repo).catch(() => [] as ForgejoBranch[]),
      entry.backend.listBranches(ctx.owner, ctx.repo),
      entry.backend.currentBranch(),
    ]);
    return htmlResponse(
      repoPageShell(ctx, "pulls", `New PR - ${ctx.repo}`, pullCreatePage(ctx, baseBranches, { ...values, error: result.message }, { headBranches, currentBranch })),
      result.status,
    );
  }
  const branches = await ctx.collab.listBranches(ctx.owner, ctx.repo);
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
    const pull = await ctx.collab.createPull(ctx.owner, ctx.repo, { head, base, title, body });
    c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "opened" });
    return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
  } catch (err) {
    if (!(err instanceof ForgejoError) || !(err.status === 409 || err.status === 422)) throw err;
    // Never echo Forgejo's body into the form — it leaks the internal forge URL.
    console.error(`[${c.get("requestId") ?? ""}] create PR ${ctx.owner}/${ctx.repo} ${head}->${base} failed (${err.status})`);
    // A 409 usually means a PR already exists for this head->base (open OR closed-
    // unmerged); navigate to it instead of erroring (#181). Other 409/422 get a
    // clean canned message.
    const existing = (await ctx.collab.listPulls(ctx.owner, ctx.repo, "all").catch(() => []))
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
  const canRequestReview = ctx.ws.role !== "read" && pull.state !== "closed";
  const [issueComments, reviews, comments, timeline, commits, availableReviewers, allLabels] = await Promise.all([
    ctx.collab.listIssueComments(ctx.owner, ctx.repo, pull.number),
    ctx.collab.listReviews(ctx.owner, ctx.repo, pull.number),
    ctx.collab.listPullComments(ctx.owner, ctx.repo, pull.number),
    ctx.collab.listIssueTimeline(ctx.owner, ctx.repo, pull.number),
    ctx.collab.listPullCommits(ctx.owner, ctx.repo, pull.number),
    canRequestReview ? ctx.collab.listPullReviewers(ctx.owner, ctx.repo).catch(() => []) : Promise.resolve([]),
    ctx.ws.role === "read" ? Promise.resolve([]) : ctx.collab.listLabels(ctx.owner, ctx.repo).catch(() => []),
  ]);
  const timelineHtml = await renderPullTimeline(ctx, pull.number, issueComments, reviews, comments, timeline, commits);
  // The participants bar must reflect the conversation the timeline shows —
  // issue-style PR replies, submitted reviews, and inline review comments — so
  // its count, "last reply", and chips match what's rendered below. Same review
  // filter as renderPullTimeline; sorted so "last" is latest.
  const conversation = [
    ...issueComments.map((c) => ({ user: c.user, created_at: c.created_at })),
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
      { readerAssets: ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID },
    ),
  );
}));

web.get("/:owner/:repo/pulls/:number/edit", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const [allLabels, milestones] = await Promise.all([
    ctx.collab.listLabels(ctx.owner, ctx.repo),
    ctx.collab.listMilestones(ctx.owner, ctx.repo, "all"),
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
  await ctx.collab.editPull(ctx.owner, ctx.repo, pull.number, {
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
  if (labelPatch.labels) await ctx.collab.setIssueLabels(ctx.owner, ctx.repo, pull.number, labelPatch.labels);
  c.get("sse").publish(ctx.ws.slug, { type: "pull", number: pull.number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/state", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.merged) return forbiddenPage(ctx.user);
  const state = stringField((await c.req.parseBody()).state);
  if (state !== "open" && state !== "closed") return badRequestPage(ctx.user, "State must be open or closed.");
  await ctx.collab.editPull(ctx.owner, ctx.repo, pull.number, { state });
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
  await ctx.collab.createPullReviewRequests(ctx.owner, ctx.repo, pull.number, reviewers);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/review-requests/delete", webRouteForWrite(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  if (!pull) return notFoundPage(ctx.user, "Pull request not found");
  if (pull.state === "closed") return forbiddenPage(ctx.user);
  const reviewer = stringField((await c.req.parseBody()).reviewer);
  if (!reviewer) return badRequestPage(ctx.user, "Reviewer is required.");
  await ctx.collab.deletePullReviewRequests(ctx.owner, ctx.repo, pull.number, [reviewer]);
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
  await ctx.collab.createReview(ctx.owner, ctx.repo, pull.number, { event, body });
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
  await ctx.collab.editIssueComment(ctx.owner, ctx.repo, id, body);
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
  await ctx.collab.deleteReviewComment(ctx.owner, ctx.repo, pull.number, reviewId, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/issue-comments/:id/edit", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!pull || !id) return notFoundPage(ctx.user, "Comment not found");
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  const comment = await pullIssueCommentFor(ctx, pull.number, id);
  if (!comment) return notFoundPage(ctx.user, "Comment not found");
  await ctx.collab.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`));
}));

web.post("/:owner/:repo/pulls/:number/issue-comments/:id/delete", webRoute(async (c, ctx) => {
  const pull = await pullForParam(ctx, c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  if (!pull || !id) return notFoundPage(ctx.user, "Comment not found");
  const comment = await pullIssueCommentFor(ctx, pull.number, id);
  if (!comment) return notFoundPage(ctx.user, "Comment not found");
  await ctx.collab.deleteIssueComment(ctx.owner, ctx.repo, id);
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
  const patch = splitDiffByFile(await ctx.collab.getPullDiff(ctx.owner, ctx.repo, pull.number)).get(path);
  if (!patch) return badRequestPage(ctx.user, "File is not part of this pull request.");
  const pos = fileLineToWritePosition(patch, line, side);
  if (!pos) return badRequestPage(ctx.user, "Line is not part of the pull request diff.");
  await ctx.collab.createReview(ctx.owner, ctx.repo, pull.number, {
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
  // Local Workbench (writeMode "direct") has no forge client; the local user is
  // the workspace admin and the core enforces admin on the proxied merge.
  const fresh = ctx.writeMode === "direct" ? ctx.ws.role : await ctx.fj.getRepoPermission(ctx.owner, ctx.repo, ctx.user);
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
    await mergePullWithRetry(() => ctx.collab.mergePull(ctx.owner, ctx.repo, pull.number, { Do: "squash", force }));
  } catch (err) {
    if (!(err instanceof ForgejoError)) throw err;
    // Never surface Forgejo's raw body — it carries the internal backend URL.
    console.error(`[${c.get("requestId") ?? ""}] web merge ${ctx.owner}/${ctx.repo}#${pull.number} failed (${err.status})`);
    const blocked = err.status === 405 || err.status === 409;
    // Re-read the PR — the pre-merge snapshot's mergeable can be stale/null. A real
    // content conflict (mergeable === false) isn't an approvals problem and "Merge
    // anyway" won't fix it; a still-null mergeable is transient, not approvals (#7).
    const fresh2 = blocked ? await ctx.collab.getPull(ctx.owner, ctx.repo, pull.number).catch(() => null) : null;
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
  // In local mode the head branch lives on the remote core; the proxied merge
  // owns its cleanup, and there is no local forge client to delete it.
  if (ctx.writeMode !== "direct" && pull.head.ref && pull.head.ref !== "main") {
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
    ctx.collab.listPullComments(ctx.owner, ctx.repo, pull.number),
  ]);
  const selected = c.req.query("file") ?? files[0]?.path ?? "";
  const file = files.find((f) => f.path === selected) ?? files[0] ?? null;
  // Rich rendering is only meaningful for markdown; a .bib/.json/.png/binary file
  // fed through the Coflat reader renders as garbage (#2). Gate rich on the
  // selected file's kind so those default to (and are pinned to) source.
  // Local Workbench: the PR's per-side file content lives on the core, not the
  // opened folder, so the rich/split/after views (which read getRawFile at the
  // PR's base+head SHAs) can't be sourced. Fall back to the unified source patch
  // — the same documented behavior as a passthrough workspace's rich diff.
  const richOk =
    ctx.writeMode !== "direct" &&
    ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID &&
    file !== null &&
    fileKindForPath(file.path) === "markdown";
  const mode = ctx.writeMode === "direct" ? "source" : parseDiffMode(c.req.query("mode"), richOk);
  const shape = ctx.writeMode === "direct" ? "unified" : parseDiffShape(c.req.query("shape"), mode);
  const versions = file && shape !== "unified" ? await prFileVersions(ctx, pull, file) : null;
  const fileComments = file ? await mapLineComments(ctx, file, allComments) : [];
  const assetPreviewPaths = file && mode === "rich" ? await prAssetPreviewPaths(ctx, pull) : {};
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
                    ${await renderPrFileView(ctx, pull, file, mode, shape, versions, fileComments, assetPreviewPaths)}`
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
  return ctx.collab.getPull(ctx.owner, ctx.repo, number);
}

async function pullFiles(ctx: WebCtx, number: number) {
  const [metas, unified] = await Promise.all([
    ctx.collab.listPullFiles(ctx.owner, ctx.repo, number),
    ctx.collab.getPullDiff(ctx.owner, ctx.repo, number),
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

async function prAssetPreviewPaths(ctx: WebCtx, pull: ForgejoPull): Promise<PrFileAssetPreviewPaths> {
  // Inline PDF/image previews need the base+head file trees. In the local
  // Workbench the content backend is the opened folder, which does not hold the
  // PR's core-side commits, so the tree lookup can't resolve those SHAs —
  // degrade to no previews (the diff itself still renders from the core).
  if (ctx.writeMode === "direct") return { base: {}, head: {} };
  const [baseTree, headTree] = await Promise.all([
    ctx.backend.getTree(ctx.owner, ctx.repo, pull.base.sha, true),
    ctx.backend.getTree(ctx.owner, ctx.repo, pull.head.sha, true),
  ]);
  return {
    base: buildPdfImagePreviewPaths(baseTree.filter((entry) => entry.type === "blob").map((entry) => entry.path)),
    head: buildPdfImagePreviewPaths(headTree.filter((entry) => entry.type === "blob").map((entry) => entry.path)),
  };
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
  // Local Workbench only: head branches come from the working tree (not the core)
  // and head defaults to the checked-out branch. Hosted leaves this undefined and
  // keeps the original compare form byte-for-byte.
  local?: { headBranches: readonly ForgejoBranch[]; currentBranch: string | null },
): Html {
  const base = values.base ?? "main";
  const headBranches = local ? local.headBranches : branches;
  const head = values.head ?? (local ? local.currentBranch ?? "" : branchAfter(branches, base));
  // Local: the user is on the base branch itself (e.g. `main`), so there is
  // nothing to propose. Show a friendly "create a feature branch" state instead
  // of a form that could only produce a self-PR.
  if (local && (!head || head === base)) {
    return pullCreateLocalNoBranch(ctx, head || base);
  }
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
              ${branchOptions(headBranches, head)}
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

// Local Workbench compare page when the working tree is on the base branch:
// there is no feature branch to open a pull request from yet.
function pullCreateLocalNoBranch(ctx: WebCtx, branch: string): Html {
  return html`
    <div class="form-page">
      <div class="page-title compact">
        <div>
          <h1>New PR</h1>
        </div>
        <a class="button subtle" href="${repoHref(ctx.owner, ctx.repo, "/pulls")}">Cancel</a>
      </div>
      <div class="empty" data-testid="pull-create-no-branch">
        You're on branch <code>${branch}</code>. Switch to or create a feature branch in your working tree to open a pull request.
      </div>
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
  return html`<form class="filter-panel filter-panel--compact" method="get" action="${action}" data-testid="pull-filters" data-list-prefs="pulls">
    <datalist id="${USERNAME_DATALIST_ID}"></datalist>
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
