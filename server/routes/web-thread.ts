import type { ForgejoPull } from "../forgejo.js";
import { onForgejo404 } from "../forgejo-errors.js";
import type {
  ForgejoCommit,
  ForgejoIssue,
  ForgejoIssueComment,
  ForgejoLabel,
  ForgejoPullReviewComment,
  ForgejoReview,
  ForgejoTimelineEvent,
  ForgejoUser,
} from "../forgejo-types.js";
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
import { emptyHtml, html, type Html, joinHtml } from "./web-html.js";
import { renderMarkdownSurface } from "./web-markdown.js";
import { labelChip, labelChips } from "./web-page.js";
import { compareWebTimelineItems, webTimelineDescriptionHtml, webTimelineDescriptionText } from "./web-timeline.js";

export function issueEditPage(
  ctx: WebCtx,
  issue: ForgejoIssue,
  allLabels: readonly ForgejoLabel[],
  collaborators: readonly ForgejoUser[],
): Html {
  const current = new Set((issue.assignees ?? []).map((a) => a.login));
  // Candidate assignees: repo collaborators ∪ anyone currently assigned ∪ the
  // current user (so a write-access owner who isn't in /collaborators can still
  // self-assign). Forgejo's PATCH issue replaces the assignee set wholesale.
  const candidates = [...new Set([...collaborators.map((u) => u.login), ...current, ctx.user])].sort((a, b) =>
    a.localeCompare(b),
  );
  return threadEditPage({
    ctx,
    kind: "issue",
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    allLabels,
    currentLabels: issue.labels,
    assignees: { candidates, current },
    backHref: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}`),
    action: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/edit`),
    testId: "issue-edit-form",
  });
}

export function pullStateForm(ctx: WebCtx, pull: ForgejoPull): Html {
  if (ctx.ws.role === "read" || pull.merged) return emptyHtml;
  const nextState = pull.state === "open" ? "closed" : "open";
  const label = pull.state === "open" ? "Close pull request" : "Reopen pull request";
  return html`<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/state`)}">
    <input type="hidden" name="state" value="${nextState}">
    <button class="button" type="submit" data-testid="pull-toggle-state">${label}</button>
  </form>`;
}

export async function rejectChatIssueMutation(ctx: WebCtx, number: number): Promise<Response | null> {
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch(onForgejo404(null));
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
): Html {
  return html`<section class="relation-panel" data-testid="issue-relations">
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
): Html {
  const rows = issues.map(
    (item) => html`<div class="relation-row">
        <a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/issues/${item.number}`)}">#${item.number} ${item.title}</a>
        <span class="state ${item.state}">${item.state}</span>
        ${
          ctx.ws.role === "read"
            ? ""
            : html`<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/dependencies/delete`)}">
                <input type="hidden" name="relation" value="${relation}">
                <input type="hidden" name="index" value="${item.number}">
                <button class="button" type="submit">Remove</button>
              </form>`
        }
      </div>`,
  );
  const form =
    ctx.ws.role === "read"
      ? ""
      : html`<form class="inline-add-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/dependencies`)}">
          <input type="hidden" name="relation" value="${relation}">
          <input name="index" inputmode="numeric" pattern="[0-9]+" placeholder="Issue #" aria-label="${title} issue number">
          <button class="button" type="submit">Add</button>
        </form>`;
  return html`<section class="relation-card">
    <h3>${title}</h3>
    ${rows.length ? rows : html`<div class="empty compact-empty">None.</div>`}
    ${form}
  </section>`;
}

// Shared thread (issue + pull request) building blocks. Both thread kinds
// must render through these so layout and editing stay uniform.

export function threadLayout(main: Html, rail: Html): Html {
  return html`<div class="thread-layout">
    <div class="thread-main">${main}</div>
    <aside class="thread-rail">${rail}</aside>
  </div>`;
}

export function labelsRailPanel(labels: readonly ForgejoLabel[]): Html {
  return html`<section class="rail-panel" data-testid="thread-labels">
    <h2>Labels</h2>
    ${labels.length ? labelChips(labels) : html`<span class="muted">None.</span>`}
  </section>`;
}

// Shared checkbox-list fieldset for the thread edit form (labels, assignees).
// Emits a hidden `${name}_present` marker so the POST can tell an empty
// selection from an absent fieldset. Renders nothing when there are no rows.
function checkboxFieldset(opts: {
  legend: string;
  name: string;
  testId?: string;
  rows: readonly { value: string; checked: boolean; disabled?: boolean; content: Html | string }[];
}): Html {
  if (!opts.rows.length) return emptyHtml;
  return html`<fieldset class="checkbox-list"${opts.testId ? html` data-testid="${opts.testId}"` : emptyHtml}>
      <legend>${opts.legend}</legend>
      ${opts.rows.map(
        (r) => html`<label class="checkbox-row">
          <input type="checkbox" name="${opts.name}" value="${r.value}"${r.checked ? " checked" : ""}${r.disabled ? " disabled" : ""}>
          ${r.content}
        </label>`,
      )}
    </fieldset>
    <input type="hidden" name="${opts.name}_present" value="1">`;
}

function threadEditPage(opts: {
  ctx: WebCtx;
  kind: "issue" | "pull request";
  number: number;
  title: string;
  body: string;
  allLabels: readonly ForgejoLabel[];
  currentLabels: readonly ForgejoLabel[];
  assignees?: { candidates: readonly string[]; current: ReadonlySet<string> };
  backHref: string;
  action: string;
  testId: string;
}): Html {
  const currentIds = new Set(opts.currentLabels.map((label) => label.id));
  const labelFieldset = checkboxFieldset({
    legend: "Labels",
    name: "labels",
    rows: opts.allLabels.map((label) => ({
      value: String(label.id),
      checked: currentIds.has(label.id),
      disabled: label.is_archived && !currentIds.has(label.id),
      content: labelChip(label),
    })),
  });
  const assignees = opts.assignees;
  const assigneeFieldset = assignees
    ? checkboxFieldset({
        legend: "Assignees",
        name: "assignees",
        testId: "assignee-list",
        rows: assignees.candidates.map((login) => ({
          value: login,
          checked: assignees.current.has(login),
          content: displayLogin(login),
        })),
      })
    : emptyHtml;
  return html`<section class="edit-page issue-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><p class="eyebrow">Edit ${opts.kind}</p><h1>#${opts.number}</h1></div>
      <a class="button" href="${opts.backHref}">Cancel</a>
    </div>
    <form class="compose-form" data-testid="${opts.testId}" method="post" action="${opts.action}">
      <label>Title <input name="title" value="${opts.title}" required></label>
      <label>Description
        <textarea class="text-file-editor issue-body-editor" name="body" spellcheck="true">${opts.body}</textarea>
      </label>
      ${labelFieldset}
      ${assigneeFieldset}
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

export function pullEditPage(ctx: WebCtx, pull: ForgejoPull, allLabels: readonly ForgejoLabel[]): Html {
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

export function reviewRequestPanel(ctx: WebCtx, pull: ForgejoPull, availableReviewers: readonly { login: string }[]): Html {
  const requested = pull.requested_reviewers ?? [];
  const requestedTeams = pull.requested_reviewers_teams ?? [];
  const requestedLogins = new Set(requested.map((reviewer) => reviewer.login));
  const available = availableReviewers.filter((reviewer) => !requestedLogins.has(reviewer.login));
  const requestedHtml =
    requested.length === 0 && requestedTeams.length === 0
      ? html`<div class="empty">No requested reviewers.</div>`
      : html`<div class="label-chips">
          ${requested.map((reviewer) => reviewerRequestChip(ctx, pull, reviewer.login))}
          ${requestedTeams.map((team) => html`<span class="meta-pill">${team.username ?? team.name}</span>`)}
        </div>`;
  const requestForm =
    ctx.ws.role === "read" || pull.state === "closed"
      ? ""
      : html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests`)}">
          <label>Request reviewers
            <select name="reviewers" multiple size="${Math.min(Math.max(available.length, 2), 6)}">
              ${available.map((reviewer) => html`<option value="${reviewer.login}">${displayLogin(reviewer.login)}</option>`)}
            </select>
          </label>
          <button class="button" type="submit">Request review</button>
        </form>`;
  return html`<section class="rail-panel" data-testid="pull-review-requests">
    <h2>Reviewers</h2>
    ${requestedHtml}
    ${requestForm}
  </section>`;
}

function reviewerRequestChip(ctx: WebCtx, pull: ForgejoPull, reviewer: string): Html {
  const remove =
    ctx.ws.role === "read" || pull.state === "closed"
      ? ""
      : html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests/delete`)}">
          <input type="hidden" name="reviewer" value="${reviewer}">
          <button class="button" type="submit">Remove</button>
        </form>`;
  return html`<span class="meta-pill">${displayLogin(reviewer)}${remove}</span>`;
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
): Promise<Html> {
  const referenceEvents = timeline.filter((event) => event.type !== "comment" && isReferenceTimelineEvent(event.type));
  const visibleEvents = timeline.filter((event) => event.type !== "comment" && !isReferenceTimelineEvent(event.type));
  const items: WebTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, ts: parseDateMs(comment.created_at), number, comment })),
    ...visibleEvents.map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event })),
  ].sort(compareTimelineItems);
  const visibleHtml = joinHtml(await Promise.all(items.map((item) => renderTimelineItem(ctx, item))));
  if (referenceEvents.length === 0) return visibleHtml;
  const referenceItems = referenceEvents
    .map((event) => ({ kind: "event" as const, ts: parseDateMs(event.created_at), event }))
    .sort(compareTimelineItems);
  const referenceHtml = joinHtml(await Promise.all(referenceItems.map((item) => renderTimelineItem(ctx, item))));
  return html`${visibleHtml}<details class="timeline-collapsed"><summary>References (${referenceEvents.length})</summary>${referenceHtml}</details>`;
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
): Promise<Html> {
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
  return joinHtml(await Promise.all(items.map((item) => renderTimelineItem(ctx, item))));
}

function issueCommentActions(ctx: WebCtx, number: number, comment: ForgejoIssueComment): Html {
  if (ctx.ws.role === "read") return emptyHtml;
  return html`<details class="comment-actions" data-testid="issue-comment-actions">
    <summary>Comment actions</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/edit`)}">
      <textarea name="body" required>${comment.body}</textarea>
      <button class="button primary" type="submit">Save comment</button>
    </form>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/delete`)}">
      <button class="button danger" type="submit">Delete comment</button>
    </form>
  </details>`;
}

function pullCommentActions(ctx: WebCtx, number: number, comment: ForgejoPullReviewComment): Html {
  if (ctx.ws.role === "read") return emptyHtml;
  return html`<details class="comment-actions" data-testid="pull-comment-actions">
    <summary>Comment actions</summary>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/edit`)}">
      <textarea name="body" required>${comment.body}</textarea>
      <button class="button primary" type="submit">Save comment</button>
    </form>
    <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/delete`)}">
      <input type="hidden" name="review_id" value="${comment.pull_request_review_id}">
      <button class="button danger" type="submit">Delete comment</button>
    </form>
  </details>`;
}

async function renderTimelineItem(ctx: WebCtx, item: WebTimelineItem): Promise<Html> {
  if (item.kind === "comment") {
    const body = await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" });
    return html`<div class="comment">
      <div class="comment-meta">${displayLogin(item.comment.user?.login)} - ${formatDate(item.comment.created_at)}</div>
      ${body}
      ${issueCommentActions(ctx, item.number, item.comment)}
    </div>`;
  }
  if (item.kind === "line-comment") {
    const body = await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" });
    return html`<div class="comment">
      <div class="comment-meta">${displayLogin(item.comment.user?.login)} commented on ${item.comment.path} - ${formatDate(item.comment.created_at)}</div>
      ${body}
      ${pullCommentActions(ctx, item.number, item.comment)}
    </div>`;
  }
  if (item.kind === "review") {
    const label = reviewStateLabel(item.review.state);
    const body = item.review.body ? await renderMarkdownSurface(ctx, item.review.body, { surface: "thread" }) : "";
    return html`<div class="timeline-event">
      <strong>${displayLogin(item.review.user?.login)}</strong>
      <span>${label}</span>
      <small>${formatDate(item.review.submitted_at)}</small>
      ${body}
    </div>`;
  }
  if (item.kind === "commit") {
    return html`<div class="timeline-event">
      <strong>${displayLogin(item.commit.author?.login ?? item.commit.commit.author?.name)}</strong>
      <span>pushed commit <code>${item.commit.sha.slice(0, 10)}</code></span>
      <small>${formatDate(commitDateMs(item.commit))}</small>
      <p>${firstCommitLine(item.commit.commit.message)}</p>
    </div>`;
  }
  if (!webTimelineDescriptionText(item.event)) return emptyHtml;
  const description = webTimelineDescriptionHtml(item.event);
  return html`<div class="timeline-event">
    ${item.event.user?.login ? html`<strong>${displayLogin(item.event.user.login)}</strong>` : ""}
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

export function reviewForms(ctx: WebCtx, pull: ForgejoPull, redirectTo?: string): Html {
  if (ctx.ws.role === "read" || pull.user?.login === ctx.user || pull.state === "closed") return emptyHtml;
  return html`
    <form class="review-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/reviews`)}">
      ${redirectTo ? html`<input type="hidden" name="redirect_to" value="${redirectTo}">` : ""}
      <textarea name="body" placeholder="Leave a review comment"></textarea>
      <div class="toolbar-actions">
        <button class="button" name="event" value="COMMENT" type="submit">Comment</button>
        <button class="button" name="event" value="REQUEST_CHANGES" type="submit">Request changes</button>
        <button class="button primary" name="event" value="APPROVED" type="submit">Approve</button>
      </div>
    </form>
    ${
      ctx.ws.role === "admin"
        ? html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/merge`)}"><button class="button primary" type="submit">Merge pull request</button></form>`
        : ""
    }
  `;
}
