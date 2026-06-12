import { ForgejoError, type ForgejoPull } from "../forgejo.js";
import type {
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoPullReviewComment,
  ForgejoReview,
  ForgejoTimelineEvent,
} from "../forgejo-types.js";
import { escapeAttr, escapeHtml } from "./html-escape.js";
import { validateLabelSelection } from "./label-utils.js";
import { isChatIssue } from "./web-chat.js";
import {
  badRequestPage,
  displayLogin,
  formatDate,
  notFoundPage,
  positiveIntFields,
  repoHref,
  stringField,
  type WebCtx,
} from "./web-context.js";
import { renderMarkdownSurface } from "./web-markdown.js";
import { labelChip, labelChips } from "./web-page.js";
import { compareWebTimelineItems, webTimelineDescriptionHtml } from "./web-timeline.js";

export function issueEditPage(ctx: WebCtx, issue: ForgejoIssue, allLabels: readonly ForgejoLabel[]): string {
  return threadEditPage({
    ctx,
    kind: "issue",
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    allLabels,
    currentLabels: issue.labels,
    backHref: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}`),
    action: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/edit`),
    testId: "issue-edit-form",
  });
}

export function pullStateForm(ctx: WebCtx, pull: ForgejoPull): string {
  if (ctx.ws.role === "read" || pull.merged) return "";
  const nextState = pull.state === "open" ? "closed" : "open";
  const label = pull.state === "open" ? "Close pull request" : "Reopen pull request";
  return `<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/state`)}">
    <input type="hidden" name="state" value="${nextState}">
    <button class="button" type="submit" data-testid="pull-toggle-state">${label}</button>
  </form>`;
}

export async function rejectChatIssueMutation(ctx: WebCtx, number: number): Promise<Response | null> {
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
    if (err instanceof ForgejoError && err.status === 404) return null;
    throw err;
  });
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  return isChatIssue(issue) ? chatIssueReadOnlyPage(ctx.user) : null;
}

export function chatIssueReadOnlyPage(user: string): Response {
  return badRequestPage(user, "Chat-backed issues are read-only from the issue UI. Continue the transcript from the Chat tab.");
}

export function issueRelationsPanel(
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

// Shared thread (issue + pull request) building blocks. Both thread kinds
// must render through these so layout and editing stay uniform.

export function threadLayout(main: string, rail: string): string {
  return `<div class="thread-layout">
    <div class="thread-main">${main}</div>
    <aside class="thread-rail">${rail}</aside>
  </div>`;
}

export function labelsRailPanel(labels: readonly ForgejoLabel[]): string {
  return `<section class="rail-panel" data-testid="thread-labels">
    <h2>Labels</h2>
    ${labels.length ? labelChips(labels) : `<span class="muted">None.</span>`}
  </section>`;
}

function threadEditPage(opts: {
  ctx: WebCtx;
  kind: "issue" | "pull request";
  number: number;
  title: string;
  body: string;
  allLabels: readonly ForgejoLabel[];
  currentLabels: readonly ForgejoLabel[];
  backHref: string;
  action: string;
  testId: string;
}): string {
  const currentIds = new Set(opts.currentLabels.map((label) => label.id));
  const labelRows = opts.allLabels.map((label) => {
    const checked = currentIds.has(label.id) ? " checked" : "";
    const disabled = label.is_archived && !currentIds.has(label.id) ? " disabled" : "";
    return `<label class="checkbox-row">
      <input type="checkbox" name="labels" value="${label.id}"${checked}${disabled}>
      ${labelChip(label)}
    </label>`;
  });
  const labelFieldset = opts.allLabels.length
    ? `<fieldset class="checkbox-list">
        <legend>Labels</legend>
        ${labelRows.join("")}
      </fieldset>
      <input type="hidden" name="labels_present" value="1">`
    : "";
  return `<section class="edit-page issue-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><p class="eyebrow">Edit ${opts.kind}</p><h1>#${opts.number}</h1></div>
      <a class="button" href="${opts.backHref}">Cancel</a>
    </div>
    <form class="compose-form" data-testid="${opts.testId}" method="post" action="${opts.action}">
      <label>Title <input name="title" value="${escapeAttr(opts.title)}" required></label>
      <label>Description
        <textarea class="text-file-editor issue-body-editor" name="body" spellcheck="true">${escapeHtml(opts.body)}</textarea>
      </label>
      ${labelFieldset}
      <div class="form-actions">
        <button class="button primary" type="submit">Save ${opts.kind}</button>
      </div>
    </form>
  </section>`;
}

export async function labelSelectionPatch(
  ctx: WebCtx,
  form: Record<string, unknown>,
  current: readonly ForgejoLabel[],
): Promise<{ ok: true; labels?: number[] } | { ok: false; message: string }> {
  if (!stringField(form.labels_present)) return { ok: true };
  const labelIds = positiveIntFields(form.labels);
  const allLabels = await ctx.fj.listLabels(ctx.owner, ctx.repo);
  const validation = validateLabelSelection(labelIds, allLabels, [...current]);
  if (!validation.ok) return { ok: false, message: validation.message };
  return { ok: true, labels: labelIds };
}

export function pullEditPage(ctx: WebCtx, pull: ForgejoPull, allLabels: readonly ForgejoLabel[]): string {
  return threadEditPage({
    ctx,
    kind: "pull request",
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    allLabels,
    currentLabels: pull.labels ?? [],
    backHref: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`),
    action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/edit`),
    testId: "pull-edit-form",
  });
}

export function reviewRequestPanel(ctx: WebCtx, pull: ForgejoPull, availableReviewers: readonly { login: string }[]): string {
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
  return `<section class="rail-panel" data-testid="pull-review-requests">
    <h2>Reviewers</h2>
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

type WebTimelineItem =
  | { kind: "comment"; ts: number; number: number; comment: ForgejoIssueComment }
  | { kind: "event"; ts: number; event: ForgejoTimelineEvent }
  | { kind: "review"; ts: number; review: ForgejoReview }
  | { kind: "line-comment"; ts: number; number: number; comment: ForgejoPullReviewComment }
  | { kind: "commit"; ts: number; commit: ForgejoCommit };

export async function renderIssueTimeline(
  ctx: WebCtx,
  number: number,
  comments: readonly ForgejoIssueComment[],
  timeline: readonly ForgejoTimelineEvent[],
): Promise<string> {
  const referenceEvents = timeline.filter((event) => event.type !== "comment" && isReferenceTimelineEvent(event.type));
  const visibleEvents = timeline.filter((event) => event.type !== "comment" && !isReferenceTimelineEvent(event.type));
  const items: WebTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, ts: parseDateMs(comment.created_at), number, comment })),
    ...visibleEvents.map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event })),
  ].sort(compareTimelineItems);
  const visibleHtml = (await Promise.all(items.map((item) => renderTimelineItem(ctx, item)))).join("");
  if (referenceEvents.length === 0) return visibleHtml;
  const referenceItems = referenceEvents
    .map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event }))
    .sort(compareTimelineItems);
  const referenceHtml = (await Promise.all(referenceItems.map((item) => renderTimelineItem(ctx, item)))).join("");
  return `${visibleHtml}<details class="timeline-collapsed"><summary>References (${referenceEvents.length})</summary>${referenceHtml}</details>`;
}

function isReferenceTimelineEvent(type: string): boolean {
  return type === "commit_ref" || type === "issue_ref" || type === "comment_ref" || type === "pull_ref";
}

export async function renderPullTimeline(
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

export function reviewForms(ctx: WebCtx, pull: ForgejoPull, redirectTo?: string): string {
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
