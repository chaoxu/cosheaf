import { canWrite } from "../../shared/roles.js";
import type { LineComment } from "../../shared/comments.js";
import type { DependencyRow, IssueComment, IssueDetail, Label, TimelineEvent, UserRef } from "../../shared/issues.js";
import type { PrCommit, PrMeta, ReviewDto } from "../../shared/review.js";
import { onForgejo404 } from "../forgejo-errors.js";
import type {
  ForgejoLabel,
  ForgejoTimelineEvent,
} from "../forgejo-types.js";
import { type AvatarUser, avatarLinkForUser } from "./avatar.js";
import { chevronIcon, editIcon } from "./icons.js";
import { validateLabelSelection } from "./label-utils.js";
import { isChatIssue } from "./web-chat.js";
import {
  badRequestPage,
  displayLogin,
  notFoundPage,
  positiveInt,
  positiveIntFields,
  repoHref,
  stringField,
  timeEl,
  userLink,
  type WebCtx,
} from "./web-context.js";
import { emptyHtml, type Html, html, joinHtml } from "./web-html.js";
import { composeField, renderMarkdownSurface } from "./web-markdown.js";
import { addDisclosure, labelChip, labelChips } from "./web-page.js";
import { coflatCommentAssets } from "./web-shell.js";
import { compareWebTimelineItems, webTimelineDescriptionHtml, webTimelineDescriptionText } from "./web-timeline.js";

type WebLabel = Pick<Label, "id" | "name" | "color"> & Partial<Pick<Label, "description" | "exclusive" | "is_archived" | "scope">>;
type WebMilestone = { id: number; title: string };

export function issueEditPage(
  ctx: WebCtx,
  issue: IssueDetail,
  allLabels: readonly WebLabel[],
  collaborators: readonly { login: string }[],
  milestones: readonly WebMilestone[],
): Html {
  const current = new Set(issue.assignees ?? []);
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
    milestones: { all: milestones, current: issue.milestone?.id ?? null },
    backHref: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}`),
    action: repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/edit`),
    testId: "issue-edit-form",
  });
}

export function pullStateForm(ctx: WebCtx, pull: PrMeta): Html {
  if (!canWrite(ctx.ws.role) || pull.merged) return emptyHtml;
  const nextState = pull.state === "open" ? "closed" : "open";
  const label = pull.state === "open" ? "Close PR" : "Reopen PR";
  return html`<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/state`)}">
    <input type="hidden" name="state" value="${nextState}">
    <button class="button" type="submit" data-testid="pull-toggle-state">${label}</button>
  </form>`;
}

export async function rejectChatIssueMutation(ctx: WebCtx, number: number): Promise<IssueDetail | Response> {
  const issue = await ctx.collab.getIssue(ctx.owner, ctx.repo, number).catch(onForgejo404(null));
  if (!issue) return notFoundPage(ctx.user, "Issue not found");
  return isChatIssue(issue) ? chatIssueReadOnlyPage(ctx.user) : issue;
}

// The shared preamble for issue-mutation handlers: parse the :number param
// (404 on bad), then apply the chat-issue read-only gate. Returns the issue
// issue detail, or a Response the handler should return as-is. Callers do:
//   const issue = await resolveMutableIssue(ctx, c.req.param("number"));
//   if (issue instanceof Response) return issue;
export async function resolveMutableIssue(ctx: WebCtx, numberParam: string | undefined): Promise<IssueDetail | Response> {
  const number = positiveInt(numberParam);
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  return rejectChatIssueMutation(ctx, number);
}

export function chatIssueReadOnlyPage(user: string): Response {
  return badRequestPage(user, "Chat-backed issues are read-only from the issue UI.");
}

export function issueRelationsPanel(
  ctx: WebCtx,
  issue: Pick<IssueDetail, "number">,
  dependencies: readonly DependencyRow[],
  blocks: readonly DependencyRow[],
): Html {
  return html`<section class="relation-panel" data-testid="issue-relations">
    <h2>Issue relations</h2>
    <div class="relation-grid">
      ${issueRelationList(ctx, issue, "depends_on", "Depends on", dependencies)}
      ${issueRelationList(ctx, issue, "blocks", "Blocks", blocks)}
    </div>
  </section>`;
}

export function dependenciesPanel(
  ctx: WebCtx,
  issue: Pick<IssueDetail, "number">,
  dependencies: readonly DependencyRow[],
  blocks: readonly DependencyRow[],
): Html {
  return issueRelationsPanel(ctx, issue, dependencies, blocks);
}

function issueRelationList(
  ctx: WebCtx,
  issue: Pick<IssueDetail, "number">,
  relation: "depends_on" | "blocks",
  title: string,
  issues: readonly DependencyRow[],
): Html {
  const rows = issues.map(
    (item) => html`<div class="relation-row">
        <a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/issues/${item.number}`)}">#${item.number} ${item.title}</a>
        <span class="state ${item.state}">${item.state}</span>
        ${
          !canWrite(ctx.ws.role)
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
    !canWrite(ctx.ws.role)
      ? emptyHtml
      : addDisclosure("add", html`<form class="inline-add-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/dependencies`)}">
          <input type="hidden" name="relation" value="${relation}">
          <input name="index" inputmode="numeric" pattern="[0-9]+" placeholder="Issue #" aria-label="${title} issue number">
          <button class="button" type="submit">Add</button>
        </form>`);
  return html`<section class="relation-card">
    <h3>${title}</h3>
    ${rows.length ? rows : html`<div class="empty compact-empty">None.</div>`}
    ${form}
  </section>`;
}

// Shared thread (issue + pull request) building blocks. Both thread kinds
// must render through these so layout and editing stay uniform.

export function threadLayout(main: Html, railPanels: readonly Html[]): Html {
  return html`<div class="thread-layout">
    <div class="thread-main">${main}</div>
    <aside class="thread-rail">${joinHtml(railPanels)}</aside>
  </div>`;
}

// The shared thread header: state badge + title row (h1 + #number + caller-owned
// actions), an optional byline <p>, and optional subtabs. The issue thread, the
// PR conversation, and the PR files-changed page all render through this.
// `state` is both the badge class suffix and its text. `actions` is dropped
// straight into the title row after the <h1> — the caller owns any
// `.toolbar-actions` wrapper (the files-changed header has none). `byline` and
// `subtabs`, when omitted, drop their whole element.
export function threadHeader(opts: {
  state: string;
  title: string;
  number: number;
  actions: Html;
  byline?: Html;
  subtabs?: Html;
}): Html {
  return html`<header class="thread-header">
    <span class="state ${opts.state}">${opts.state}</span>
    <div class="thread-title-row">
      <h1>${opts.title} <span>#${opts.number}</span></h1>
      ${opts.actions}
    </div>
    ${opts.byline ? html`<p>${opts.byline}</p>` : emptyHtml}
    ${opts.subtabs ? html`<nav class="subtabs">${opts.subtabs}</nav>` : emptyHtml}
  </header>`;
}

// The issue/PR description block. Renders the body markdown, or — when the body
// is empty — a muted "No description." rather than an empty reader island that
// would show as a tall bordered band (#135). The `.issue-document` class is
// shared by both thread kinds; callers pass the (already chat-stripped) body.
export async function threadDescription(ctx: WebCtx, rawBody: string): Promise<Html> {
  const body = rawBody.trim().length > 0 ? await renderMarkdownSurface(ctx, rawBody, { surface: "thread" }) : null;
  return html`<div class="issue-document">${body ?? html`<p class="muted">No description.</p>`}</div>`;
}

// The rail Labels panel: chips plus, for write+ roles, an inline "+ edit"
// disclosure revealing the same checkbox picker the edit page uses. Submitting
// posts the selected label ids to `action`, which sets them via Forgejo and
// returns to the thread — no trip to the heavyweight edit page. `allLabels`
// empty (read role / chat-backed) hides the editor.
export function labelsRailPanel(opts: {
  ctx: WebCtx;
  current: readonly WebLabel[];
  allLabels: readonly WebLabel[];
  action: string;
}): Html {
  const currentIds = new Set(opts.current.map((label) => label.id));
  const editor =
    !canWrite(opts.ctx.ws.role) || opts.allLabels.length === 0
      ? emptyHtml
      : addDisclosure(
          "edit",
          html`<form method="post" action="${opts.action}">
            ${checkboxFieldset({
              legend: "Labels",
              name: "labels",
              rows: opts.allLabels.map((label) => ({
                value: String(label.id),
                checked: currentIds.has(label.id),
                disabled: label.is_archived && !currentIds.has(label.id),
                content: labelChip(label),
              })),
            })}
            <button class="button small primary" type="submit">Save labels</button>
          </form>`,
        );
  return html`<section class="rail-panel" data-testid="thread-labels">
    <h2>Labels</h2>
    ${opts.current.length ? labelChips(opts.current) : html`<span class="muted">None.</span>`}
    ${editor}
  </section>`;
}

export function labelsPanel(opts: {
  ctx: WebCtx;
  current: readonly WebLabel[];
  allLabels: readonly WebLabel[];
  action: string;
}): Html {
  return labelsRailPanel(opts);
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
  kind: "issue" | "PR";
  number: number;
  title: string;
  body: string;
  allLabels: readonly WebLabel[];
  currentLabels: readonly WebLabel[];
  assignees?: { candidates: readonly string[]; current: ReadonlySet<string> };
  milestones?: { all: readonly WebMilestone[]; current: number | null };
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
  // Milestone is a single <select> (value 0 = no milestone, which Forgejo
  // treats as "clear"). Only rendered when the caller passes milestones.
  const milestoneField = opts.milestones
    ? html`<label>Milestone
        <select name="milestone" data-testid="issue-milestone-select">
          <option value="0"${opts.milestones.current ? "" : " selected"}>No milestone</option>
          ${opts.milestones.all.map(
            (m) => html`<option value="${m.id}"${opts.milestones?.current === m.id ? " selected" : ""}>${m.title}</option>`,
          )}
        </select>
      </label>`
    : emptyHtml;
  return html`<section class="edit-page issue-edit-page">
    <div class="file-toolbar edit-titlebar">
      <div><p class="eyebrow">Edit ${opts.kind}</p><h1>#${opts.number}</h1></div>
      <a class="button subtle" href="${opts.backHref}">Cancel</a>
    </div>
    <form class="compose-form" data-testid="${opts.testId}" method="post" action="${opts.action}">
      <label>Title <input name="title" value="${opts.title}" required></label>
      <label>Description
        ${composeField(opts.ctx, { value: opts.body, className: "text-file-editor issue-body-editor" })}
      </label>
      ${labelFieldset}
      ${milestoneField}
      ${assigneeFieldset}
      <div class="form-actions">
        <button class="button primary" type="submit">Save ${opts.kind}</button>
      </div>
    </form>
    ${coflatCommentAssets(opts.ctx.coflat)}
  </section>`;
}

export async function labelSelectionPatch(
  ctx: WebCtx,
  form: Record<string, unknown>,
  current: readonly WebLabel[],
): Promise<{ ok: true; labels?: number[] } | { ok: false; message: string }> {
  if (!stringField(form.labels_present)) return { ok: true };
  const labelIds = positiveIntFields(form.labels);
  if (labelIds === null) return { ok: false, message: "Labels must be positive integer ids." };
  const allLabels = await ctx.collab.listLabels(ctx.owner, ctx.repo);
  const validation = validateLabelSelection(labelIds, allLabels, [...current]);
  if (!validation.ok) return { ok: false, message: validation.message };
  return { ok: true, labels: labelIds };
}

export function milestoneFormValue(raw: unknown): { ok: true; milestone?: number } | { ok: false; message: string } {
  const rawValue = stringField(raw);
  if (rawValue === null) return { ok: true };
  const value = rawValue.trim();
  if (value === "0") return { ok: true, milestone: 0 };
  const milestone = positiveInt(value);
  if (milestone === null) return { ok: false, message: "Milestone must be a positive integer id." };
  return { ok: true, milestone };
}

export function pullEditPage(
  ctx: WebCtx,
  pull: PrMeta,
  allLabels: readonly ForgejoLabel[],
  milestones: readonly WebMilestone[],
): Html {
  return threadEditPage({
    ctx,
    kind: "PR",
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    allLabels,
    currentLabels: pull.labels ?? [],
    milestones: { all: milestones, current: pull.milestone?.id ?? null },
    backHref: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}`),
    action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/edit`),
    testId: "pull-edit-form",
  });
}

export function reviewRequestPanel(ctx: WebCtx, pull: PrMeta, availableReviewers: readonly { login: string }[]): Html {
  const requested = pull.requested_reviewers ?? [];
  const requestedTeams = pull.requested_reviewer_teams ?? [];
  const requestedLogins = new Set(requested);
  const available = availableReviewers.filter((reviewer) => !requestedLogins.has(reviewer.login));
  const requestedHtml =
    requested.length === 0 && requestedTeams.length === 0
      ? html`<div class="empty">No requested reviewers.</div>`
      : html`<div class="label-chips">
          ${requested.map((reviewer) => reviewerRequestChip(ctx, pull, reviewer))}
          ${requestedTeams.map((team) => html`<span class="meta-pill">${team}</span>`)}
        </div>`;
  const requestForm =
    !canWrite(ctx.ws.role) || pull.state === "closed"
      ? emptyHtml
      : addDisclosure("request", html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests`)}">
          <label>Request reviewers
            <select name="reviewers" multiple size="${Math.min(Math.max(available.length, 2), 6)}">
              ${available.map((reviewer) => html`<option value="${reviewer.login}">${displayLogin(reviewer.login)}</option>`)}
            </select>
          </label>
          <button class="button" type="submit">Request review</button>
        </form>`);
  return html`<section class="rail-panel" data-testid="pull-review-requests">
    <h2>Reviewers</h2>
    ${requestedHtml}
    ${requestForm}
  </section>`;
}

export function reviewersPanel(ctx: WebCtx, pull: PrMeta, availableReviewers: readonly { login: string }[]): Html {
  return reviewRequestPanel(ctx, pull, availableReviewers);
}

function reviewerRequestChip(ctx: WebCtx, pull: PrMeta, reviewer: string): Html {
  const remove =
    !canWrite(ctx.ws.role) || pull.state === "closed"
      ? ""
      : html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/review-requests/delete`)}">
          <input type="hidden" name="reviewer" value="${reviewer}">
          <button class="button" type="submit">Remove</button>
        </form>`;
  return html`<span class="meta-pill">${userLink(reviewer, ctx.local)}${remove}</span>`;
}

type WebTimelineItem =
  | { kind: "comment"; ts: number; number: number; comment: IssueComment }
  | { kind: "pull-comment"; ts: number; number: number; comment: IssueComment }
  | { kind: "event"; ts: number; event: ForgejoTimelineEvent | TimelineEvent }
  | { kind: "review"; ts: number; review: ReviewDto }
  | { kind: "line-comment"; ts: number; number: number; comment: LineComment }
  | { kind: "commit"; ts: number; commit: PrCommit };

export async function renderIssueTimeline(
  ctx: WebCtx,
  number: number,
  comments: readonly IssueComment[],
  timeline: readonly TimelineEvent[],
): Promise<Html> {
  const referenceEvents = timeline.filter((event) => event.type !== "comment" && isReferenceTimelineEvent(event.type));
  const visibleEvents = timeline.filter((event) => event.type !== "comment" && !isReferenceTimelineEvent(event.type));
  const items: WebTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, ts: comment.created_at, number, comment })),
    ...visibleEvents.map((event) => ({ kind: "event" as const, ts: event.created_at, event })),
  ].sort(compareTimelineItems);
  const visibleHtml = joinHtml(await Promise.all(items.map((item) => renderTimelineItem(ctx, item))));
  if (referenceEvents.length === 0) return visibleHtml;
  const referenceItems = referenceEvents
    .map((event) => ({ kind: "event" as const, ts: event.created_at, event }))
    .sort(compareTimelineItems);
  const referenceHtml = joinHtml(await Promise.all(referenceItems.map((item) => renderTimelineItem(ctx, item))));
  return html`${visibleHtml}<details class="timeline-collapsed"><summary>References (${referenceEvents.length})</summary>${referenceHtml}</details>`;
}

function isReferenceTimelineEvent(type: string): boolean {
  return type === "commit_ref" || type === "issue_ref" || type === "comment_ref" || type === "pull_ref";
}

// --- Participant helpers (shared by issue/PR thread rendering) ---------------
// The initials avatar chip lives in ./avatar.js (also used by the sidebar
// identity block); re-exported here for the thread test + existing importers.
export { initials, tint } from "./avatar.js";

function userRef(login: string | null | undefined): AvatarUser | null {
  return login ? { login } : null;
}

function commentUser(comment: { user?: AvatarUser | null; author?: UserRef | null; author_username?: string }): AvatarUser | null {
  return comment.user ?? comment.author ?? userRef(comment.author_username);
}

function eventUser(event: ForgejoTimelineEvent | TimelineEvent): AvatarUser | null {
  if ("user" in event) return event.user ?? null;
  const dto = event as TimelineEvent;
  return dto.author ?? userRef(dto.author_username);
}

// The right-hand metadata cluster for an issue/pull list row: author avatar +
// name, short date, and bare comment count — all on one line. The avatar is a
// server-rendered <img> for uploaders (same-origin /forge-avatars/*), else the
// initials chip; the forge host never appears in a client URL (#177).
export function listRowSide(
  author: AvatarUser | null | undefined,
  createdAt: string | number | undefined,
  comments: number | undefined,
  local = false,
): Html {
  return html`<span class="list-row-side">
    ${avatarLinkForUser(author, local)}<span class="row-who">${userLink(author?.login, local)}</span>
    <span class="row-sep">·</span>${timeEl(createdAt)}
    <span class="row-sep">·</span><span class="row-count" title="comments">(${comments ?? 0})</span>
  </span>`;
}

// One list row shared by the issue and pull lists — identical structure (state
// badge + title link + #number, optional .list-meta with pills + label chips,
// listRowSide). Callers supply the row class, state, the extra meta pills
// (milestone, and the base-branch pill for pulls), and whether to show the meta
// section.
export function threadListRow(opts: {
  rowClass: "issue-row" | "pull-row";
  href: string;
  state: string;
  title: string;
  number: number;
  metaPills: Html;
  hasMeta: boolean;
  labels: readonly ForgejoLabel[];
  author: AvatarUser | null | undefined;
  createdAt: string | number | undefined;
  comments: number | undefined;
  local: boolean;
}): Html {
  return html`<div class="list-row ${opts.rowClass}">
      <span class="list-row-main">
        <span class="list-row-title"><span class="state ${opts.state}">${opts.state}</span><a class="list-row-title-link" href="${opts.href}"><strong>${opts.title}</strong><span class="muted">#${opts.number}</span></a></span>
        ${opts.hasMeta ? html`<span class="list-meta">${opts.metaPills}${labelChips(opts.labels)}</span>` : ""}
      </span>
      ${listRowSide(opts.author, opts.createdAt, opts.comments, opts.local)}
    </div>`;
}

// The shared new-issue / new-PR compose page shell: title + Cancel, an optional
// error banner, the compose <form>, and the Coflat comment-editor assets. Callers
// supply the heading, cancel/action hrefs, form test id, and the inner fields.
export function composePage(opts: {
  ctx: WebCtx;
  heading: string;
  cancelHref: string;
  action: string;
  testId: string;
  error?: string;
  fields: Html;
}): Html {
  return html`
    <div class="form-page">
      <div class="page-title compact">
        <div>
          <h1>${opts.heading}</h1>
        </div>
        <a class="button subtle" href="${opts.cancelHref}">Cancel</a>
      </div>
      ${opts.error ? html`<div class="form-error" role="alert">${opts.error}</div>` : ""}
      <form class="compose-form" method="post" action="${opts.action}" data-testid="${opts.testId}">
        ${opts.fields}
      </form>
      ${coflatCommentAssets(opts.ctx.coflat)}
    </div>
  `;
}

// Participants bar at the top of an issue/PR thread: who has taken part, the
// reply count, last activity, and a jump-to-latest anchor (targets
// #thread-bottom by the composer). Generic over issue/PR comment shapes so both
// thread kinds reuse it; all computed from data already fetched.
export function threadParticipantsBar(
  author: AvatarUser | null | undefined,
  comments: readonly { user?: AvatarUser | null; author?: UserRef | null; author_username?: string; created_at?: string | number }[],
  local = false,
): Html {
  const seen = new Set<string>();
  const participants: AvatarUser[] = [];
  for (const user of [author, ...comments.map(commentUser)]) {
    if (user?.login && !seen.has(user.login)) {
      seen.add(user.login);
      participants.push(user);
    }
  }
  const last = comments[comments.length - 1];
  return html`<div class="thread-bar" data-testid="thread-bar">
    <span class="thread-faces" aria-label="Participants">${participants.map((user) => avatarLinkForUser(user, local))}</span>
    <span class="thread-stats"><strong>${comments.length}</strong> ${comments.length === 1 ? "reply" : "replies"}${
      last?.created_at ? html` · last ${timeEl(last.created_at)} by ${userLink(commentUser(last)?.login, local)}` : emptyHtml
    }</span>
    ${comments.length ? html`<a class="thread-jump" href="#thread-bottom">Jump to latest ↓</a>` : emptyHtml}
  </div>`;
}

// Which reviews are worth surfacing: not a PENDING (unsubmitted) review, and not
// an empty bare-COMMENT review. The timeline and the participants bar/count MUST
// agree on this, so they share the one predicate (#14).
export function isVisibleReview(review: Pick<ReviewDto, "decision" | "comment">): boolean {
  return review.decision !== "pending" && review.decision !== "dismissed" && (review.decision !== "comment" || Boolean(review.comment?.trim()));
}

export async function renderPullTimeline(
  ctx: WebCtx,
  number: number,
  issueComments: readonly IssueComment[],
  reviews: readonly ReviewDto[],
  comments: readonly LineComment[],
  timeline: readonly (ForgejoTimelineEvent | TimelineEvent)[],
  commits: readonly PrCommit[],
): Promise<Html> {
  const items: WebTimelineItem[] = [
    ...timeline
      .filter((event) => event.type !== "comment" && event.type !== "pull_push" && event.type !== "review")
      .map((event) => ({ kind: "event" as const, ts: new Date(event.created_at).getTime() || 0, event })),
    ...issueComments.map((comment) => ({
      kind: "pull-comment" as const,
      ts: comment.created_at,
      number,
      comment,
    })),
    ...reviews
      .filter(isVisibleReview)
      .map((review) => ({ kind: "review" as const, ts: review.created_at, review })),
    ...comments.map((comment) => ({
      kind: "line-comment" as const,
      ts: comment.created_at,
      number,
      comment,
    })),
    ...commits.map((commit) => ({ kind: "commit" as const, ts: commitDateMs(commit), commit })),
  ].sort(compareTimelineItems);
  // Group consecutive commits (a comment/review/event between two breaks the
  // run, preserving chronology). A run of one renders as a single compact line;
  // a run of many collapses behind a GitHub-style expandable group (#111).
  const rendered: Array<Html | Promise<Html>> = [];
  for (let i = 0; i < items.length; ) {
    if (items[i].kind === "commit") {
      const run: PrCommit[] = [];
      while (i < items.length && items[i].kind === "commit") {
        run.push((items[i] as Extract<WebTimelineItem, { kind: "commit" }>).commit);
        i++;
      }
      rendered.push(run.length === 1 ? compactCommitRow(run[0]) : commitGroup(run, ctx.local));
    } else {
      rendered.push(renderTimelineItem(ctx, items[i]));
      i++;
    }
  }
  return joinHtml(await Promise.all(rendered));
}

// Subtle edit/delete affordance: a small pencil that only appears on comment
// hover (see .comment-actions CSS) and floats at the comment's top-right.
// Clicking it opens the inline edit + delete forms.
function commentActions(opts: { ctx: WebCtx; testId: string; formId: string; editAction: string; deleteAction: string; body: string; deleteHidden?: Html }): Html {
  // Save and Delete share one action row even though they POST to different
  // endpoints: the Delete button lives in the edit form's row but targets the
  // separate (empty) delete form via the HTML `form=` attribute.
  return html`<details class="comment-actions" data-testid="${opts.testId}">
    <summary title="Edit or delete" aria-label="Edit or delete comment">${editIcon({ size: 13 })}</summary>
    <form method="post" action="${opts.editAction}">
      ${composeField(opts.ctx, { value: opts.body, required: true })}
      <div class="comment-action-row">
        <button class="button small primary" type="submit">Save</button>
        <button class="button small danger" type="submit" form="${opts.formId}">Delete</button>
      </div>
    </form>
    <form id="${opts.formId}" method="post" action="${opts.deleteAction}">${opts.deleteHidden ?? emptyHtml}</form>
  </details>`;
}

function issueCommentActions(ctx: WebCtx, number: number, comment: IssueComment): Html {
  if (!canWrite(ctx.ws.role) && commentUser(comment)?.login !== ctx.user) return emptyHtml;
  return commentActions({
    ctx,
    testId: "issue-comment-actions",
    formId: `comment-del-${comment.id}`,
    editAction: repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/edit`),
    deleteAction: repoHref(ctx.owner, ctx.repo, `/issues/${number}/comments/${comment.id}/delete`),
    body: comment.body,
  });
}

function pullCommentActions(ctx: WebCtx, number: number, comment: LineComment): Html {
  if (!canWrite(ctx.ws.role) && comment.author_username !== ctx.user) return emptyHtml;
  return commentActions({
    ctx,
    testId: "pull-comment-actions",
    formId: `comment-del-${comment.id}`,
    editAction: repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/edit`),
    deleteAction: repoHref(ctx.owner, ctx.repo, `/pulls/${number}/comments/${comment.id}/delete`),
    body: comment.body,
    deleteHidden: html`<input type="hidden" name="review_id" value="${comment.review_id}">`,
  });
}

function pullIssueCommentActions(ctx: WebCtx, number: number, comment: IssueComment): Html {
  if (!canWrite(ctx.ws.role) && commentUser(comment)?.login !== ctx.user) return emptyHtml;
  return commentActions({
    ctx,
    testId: "pull-issue-comment-actions",
    formId: `pull-issue-comment-del-${comment.id}`,
    editAction: repoHref(ctx.owner, ctx.repo, `/pulls/${number}/issue-comments/${comment.id}/edit`),
    deleteAction: repoHref(ctx.owner, ctx.repo, `/pulls/${number}/issue-comments/${comment.id}/delete`),
    body: comment.body,
  });
}

// Compact comment: avatar gutter + a single (author · time) byline + body, with
// the hover edit affordance floated top-right.
function commentEntry(opts: { author: AvatarUser | null | undefined; anchorId: string; whenHtml: Html; body: Html; actions: Html; local: boolean }): Html {
  return html`<article class="comment" id="${opts.anchorId}">
    <span class="comment-avatar">${avatarLinkForUser(opts.author, opts.local)}</span>
    <div class="comment-body">
      <div class="comment-byline"><span class="comment-who">${userLink(opts.author?.login, opts.local)}</span> ${opts.whenHtml}</div>
      <div class="comment-text">${opts.body}</div>
      ${opts.actions}
    </div>
  </article>`;
}

// One muted line per commit: short sha + first message line. Used for lone
// commits and inside a collapsed commit group (#111).
function compactCommitRow(commit: PrCommit): Html {
  return html`<div class="commit-row"><code>${commit.sha.slice(0, 7)}</code> <span class="commit-msg">${firstCommitLine(commit.message)}</span></div>`;
}

// A run of adjacent commits collapses behind one expandable summary so a PR
// built from many editor autosaves doesn't bury the conversation (#111).
function commitGroup(commits: readonly PrCommit[], local = false): Html {
  const authors = new Set(commits.map((c) => c.author_username ?? c.author_name ?? null));
  const label =
    authors.size === 1
      ? html`${userLink([...authors][0], local)} pushed ${commits.length} commits`
      : html`${commits.length} commits`;
  return html`<details class="commit-group">
    <summary>${chevronIcon({ size: 12, class: "disclosure-chevron" })}<span>${label}</span> ${timeEl(commitDateMs(commits[commits.length - 1]))}</summary>
    <div class="commit-list">${commits.map(compactCommitRow)}</div>
  </details>`;
}

async function renderTimelineItem(ctx: WebCtx, item: WebTimelineItem): Promise<Html> {
  const local = ctx.local;
  if (item.kind === "comment") {
    return commentEntry({
      author: commentUser(item.comment),
      anchorId: `comment-${item.comment.id}`,
      whenHtml: timeEl(item.comment.created_at),
      body: await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" }),
      actions: issueCommentActions(ctx, item.number, item.comment),
      local,
    });
  }
  if (item.kind === "pull-comment") {
    return commentEntry({
      author: commentUser(item.comment),
      anchorId: `comment-${item.comment.id}`,
      whenHtml: timeEl(item.comment.created_at),
      body: await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" }),
      actions: pullIssueCommentActions(ctx, item.number, item.comment),
      local,
    });
  }
  if (item.kind === "line-comment") {
    return commentEntry({
      author: { login: item.comment.author_username },
      anchorId: `comment-${item.comment.id}`,
      whenHtml: html`<span class="comment-on">on ${item.comment.path}</span> · ${timeEl(item.comment.created_at)}`,
      body: await renderMarkdownSurface(ctx, item.comment.body, { surface: "thread" }),
      actions: pullCommentActions(ctx, item.number, item.comment),
      local,
    });
  }
  if (item.kind === "review") {
    const label = reviewStateLabel(reviewDecisionToStateLabel(item.review.decision));
    const body = item.review.comment ? await renderMarkdownSurface(ctx, item.review.comment, { surface: "thread" }) : "";
    return html`<div class="timeline-event timeline-review">
      <div class="timeline-event-meta">
        <strong>${userLink(item.review.username, local)}</strong>
        <span>${label}</span>
        <small>${timeEl(item.review.created_at)}</small>
      </div>
      ${body ? html`<div class="timeline-event-body">${body}</div>` : emptyHtml}
    </div>`;
  }
  if (item.kind === "commit") {
    return compactCommitRow(item.commit);
  }
  // System events (close/reopen/label/assign/milestone) are demoted to a quiet
  // centered note so the thread reads cleanly; reference events are already
  // collapsed by renderIssueTimeline.
  if (!webTimelineDescriptionText(item.event)) return emptyHtml;
  return html`<p class="timeline-note">${
    eventUser(item.event)?.login ? html`${userLink(eventUser(item.event)?.login, local)} ` : emptyHtml
  }${webTimelineDescriptionHtml(item.event)} · ${timeEl(item.event.created_at)}</p>`;
}

function compareTimelineItems(a: WebTimelineItem, b: WebTimelineItem): number {
  return compareWebTimelineItems(a, b);
}

function commitDateMs(commit: PrCommit): number {
  return commit.date ?? 0;
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

function reviewDecisionToStateLabel(decision: ReviewDto["decision"]): string {
  if (decision === "approve") return "APPROVED";
  if (decision === "request_changes") return "REQUEST_CHANGES";
  if (decision === "pending") return "PENDING";
  return "COMMENT";
}

export function reviewForms(ctx: WebCtx, pull: PrMeta, redirectTo?: string): Html {
  if (pull.state === "closed") return emptyHtml;
  const isAuthor = pull.author_username === ctx.user;
  const canVerdict = ctx.ws.role !== "read" && !isAuthor;
  return html`<div>
    <form class="review-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/reviews`)}">
      ${redirectTo ? html`<input type="hidden" name="redirect_to" value="${redirectTo}">` : ""}
      ${composeField(ctx, { placeholder: "Leave a review comment" })}
      <div class="toolbar-actions">
        <button class="button" name="event" value="COMMENT" type="submit">Comment</button>
        ${canVerdict ? html`
          <button class="button" name="event" value="REQUEST_CHANGES" type="submit">Request changes</button>
          <button class="button" name="event" value="APPROVED" type="submit">Approve</button>
        ` : ""}
      </div>
    </form>
    ${
      ctx.ws.role === "admin"
        ? html`<form class="merge-actions" method="post" action="${repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/merge`)}">
            <button class="button primary" type="submit">Merge PR</button>
            <button class="button subtle" name="force" value="true" type="submit" title="Bypass required approvals (admin)" onclick="return confirm('Merge without the required approvals?')">Merge anyway</button>
          </form>`
        : ""
    }
  </div>`;
}
