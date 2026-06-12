import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { ForgejoError } from "../forgejo.js";
import type { ForgejoIssue, ForgejoLabel, ForgejoMilestone } from "../forgejo-types.js";
import type { AppEnv } from "../types.js";
import { escapeAttr, escapeHtml } from "./html-escape.js";
import { validateLabelSelection } from "./label-utils.js";
import { isChatIssue, stripChatMetadata } from "./web-chat.js";
import {
  badRequestPage,
  displayLogin,
  formatDate,
  htmlResponse,
  notFoundPage,
  parseListState,
  positiveInt,
  positiveIntFields,
  queryText,
  redirect,
  repoHref,
  resolveWebRepo,
  resolveWebRepoForWrite,
  stringField,
  textField,
  type WebCtx,
  type WebListState,
} from "./web-context.js";
import { renderMarkdownSurface } from "./web-markdown.js";
import { labelChip, labelChips, repoPage, selected, sortField, stateField } from "./web-page.js";
import {
  chatIssueReadOnlyPage,
  issueEditPage,
  issueRelationsPanel,
  labelSelectionPatch,
  labelsRailPanel,
  rejectChatIssueMutation,
  renderIssueTimeline,
  threadLayout,
} from "./web-thread.js";

export function registerIssueRoutes(web: Hono<AppEnv>): void {
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
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
  const [issue, comments, timeline, dependencies, blocks, pinnedIssues] = await Promise.all([
    ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
      if (err instanceof ForgejoError && err.status === 404) return null;
      throw err;
    }),
    ctx.fj.listIssueComments(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueTimeline(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueDependencies(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listIssueBlocks(ctx.owner, ctx.repo, number).catch(() => []),
    ctx.fj.listPinnedIssues(ctx.owner, ctx.repo).catch(() => []),
  ]);
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  const chatBackedIssue = isChatIssue(issue);
  const isPinned = pinnedIssues.some((pinned) => pinned.number === issue.number);
  const body = await renderMarkdownSurface(ctx, chatBackedIssue ? stripChatMetadata(issue.body ?? "") : issue.body ?? "", { surface: "thread" });
  const timelineHtml = await renderIssueTimeline(ctx, issue.number, comments, timeline ?? []);
  const nextIssueState = issue.state === "open" ? "closed" : "open";
  const stateActionLabel = issue.state === "open" ? "Close issue" : "Reopen";
  const canEditIssue = ctx.ws.role !== "read" && !chatBackedIssue;
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
                canEditIssue
                  ? `<div class="toolbar-actions">
                      <a class="button" href="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/edit`)}" data-testid="issue-edit-button">Edit issue</a>
                      <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/pin`)}">
                        <input type="hidden" name="pinned" value="${isPinned ? "false" : "true"}">
                        <button class="button" type="submit" data-testid="issue-toggle-pin">${isPinned ? "Unpin" : "Pin issue"}</button>
                      </form>
                      <form method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/state`)}">
                        <input type="hidden" name="state" value="${nextIssueState}">
                        <button class="button" type="submit" data-testid="issue-toggle-state">${stateActionLabel}</button>
                      </form>
                    </div>`
                  : ""
              }
            </div>
            <p>${isPinned ? `<span class="meta-pill">pinned</span> ` : ""}by ${escapeHtml(displayLogin(ctx.owner, issue.user?.login))} - ${formatDate(issue.created_at)}</p>
          </header>
          ${chatBackedIssue ? `<div class="chat-readonly-notice">This chat-backed issue is read-only in the issue UI. Continue the transcript from the Chat tab.</div>` : ""}
          ${threadLayout(
            `<div class="issue-document">
                ${body}
              </div>
              ${timelineHtml}
              ${
                ctx.ws.role === "read" || chatBackedIssue
                  ? ""
                  : `<form class="comment-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/issues/${issue.number}/comments`)}">
                       <textarea name="body" placeholder="Leave a comment" required></textarea>
                       <button class="button primary" type="submit">Comment</button>
                     </form>`
              }`,
            `${labelsRailPanel(issue.labels)}
              ${chatBackedIssue ? "" : issueRelationsPanel(ctx, issue, dependencies, blocks)}`,
          )}
        </article>
      `,
    }),
  );
});

web.get("/:owner/:repo/issues/:number/edit", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number).catch((err) => {
    if (err instanceof ForgejoError && err.status === 404) return null;
    throw err;
  });
  if (!issue || issue.pull_request) return notFoundPage(ctx.user, "Issue not found");
  if (isChatIssue(issue)) return chatIssueReadOnlyPage(ctx.user);
  const allLabels = await ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Edit #${issue.number} - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "issues",
      user: ctx.user,
      ws: ctx.ws,
      body: issueEditPage(ctx, issue, allLabels),
    }),
  );
});

web.post("/:owner/:repo/issues/:number/edit", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
  const form = await c.req.parseBody({ all: true });
  const title = stringField(form.title);
  const body = textField(form.body);
  if (!title || body === null) return badRequestPage(ctx.user, "Issue title and description are required.");
  const issue = await ctx.fj.getIssue(ctx.owner, ctx.repo, number);
  const labelPatch = await labelSelectionPatch(ctx, form, issue.labels);
  if (!labelPatch.ok) return badRequestPage(ctx.user, labelPatch.message);
  await ctx.fj.editIssue(ctx.owner, ctx.repo, number, { title, body });
  if (labelPatch.labels) await ctx.fj.setIssueLabels(ctx.owner, ctx.repo, number, labelPatch.labels);
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/labels", async (c) => {
  // Label editing moved into the issue edit page; keep redirecting old form posts.
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}/edit`));
});

web.post("/:owner/:repo/issues/:number/comments", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (number) {
    const immutable = await rejectChatIssueMutation(ctx, number);
    if (immutable) return immutable;
  }
  const body = stringField((await c.req.parseBody()).body);
  if (number && body) await ctx.fj.createIssueComment(ctx.owner, ctx.repo, number, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number ?? ""}`));
});

web.post("/:owner/:repo/issues/:number/comments/:id/edit", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  const body = stringField((await c.req.parseBody()).body);
  if (!number || !id) return notFoundPage(ctx.user, "Comment not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
  if (!body) return badRequestPage(ctx.user, "Comment body is required.");
  await ctx.fj.editIssueComment(ctx.owner, ctx.repo, id, body);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/comments/:id/delete", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  const id = positiveInt(c.req.param("id"));
  if (!number || !id) return notFoundPage(ctx.user, "Comment not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
  await ctx.fj.deleteIssueComment(ctx.owner, ctx.repo, id);
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/pin", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
  const pinned = stringField((await c.req.parseBody()).pinned);
  if (pinned === "true") await ctx.fj.pinIssue(ctx.owner, ctx.repo, number);
  else if (pinned === "false") await ctx.fj.unpinIssue(ctx.owner, ctx.repo, number);
  else return badRequestPage(ctx.user, "Pinned state is required.");
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: "edited" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});

web.post("/:owner/:repo/issues/:number/dependencies", async (c) => {
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
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
  const ctx = await resolveWebRepoForWrite(c);
  if (!ctx.ok) return ctx.response;
  const number = positiveInt(c.req.param("number"));
  if (!number) return notFoundPage(ctx.user, "Issue not found");
  const immutable = await rejectChatIssueMutation(ctx, number);
  if (immutable) return immutable;
  const state = stringField((await c.req.parseBody()).state);
  if (state !== "open" && state !== "closed") return badRequestPage(ctx.user, "State must be open or closed.");
  await ctx.fj.editIssue(ctx.owner, ctx.repo, number, { state });
  c.get("sse").publish(ctx.ws.slug, { type: "issue", number, action: state === "closed" ? "closed" : "reopened" });
  return redirect(repoHref(ctx.owner, ctx.repo, `/issues/${number}`));
});
}

type IssueListSort = "relevance" | "latest" | "oldest" | "recentupdate" | "leastupdate" | "mostcomment" | "leastcomment" | "nearduedate" | "farduedate";

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

function issueFilterForm(
  owner: string,
  repo: string,
  filters: IssueListFilters,
  labels: readonly ForgejoLabel[],
  milestones: readonly ForgejoMilestone[],
): string {
  const action = repoHref(owner, repo, "/issues");
  return `<form class="filter-panel filter-panel--compact" method="get" action="${action}" data-testid="issue-filters">
    <div class="filter-basic">
      ${stateField(filters.state)}
      <label class="filter-search">Search <input name="q" value="${escapeAttr(filters.q)}" placeholder="title text" aria-label="Search issues"></label>
      ${sortField(filters.sort, ISSUE_SORT_OPTIONS)}
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
      </div>
    </details>
  </form>`;
}

function issueList(owner: string, repo: string, issues: ForgejoIssue[], emptyText = "No issues."): string {
  return `<div class="list">${issues
    .map((issue) => `<a class="list-row issue-row" href="${repoHref(owner, repo, `/issues/${issue.number}`)}">
      <span class="list-row-main">
        <span class="list-row-title"><span class="state ${issue.state}">${escapeHtml(issue.state)}</span><strong>${escapeHtml(issue.title)}</strong><span class="muted">#${issue.number}</span></span>
        <span class="list-meta">
          ${escapeHtml(displayLogin(owner, issue.user?.login))} opened ${formatDate(issue.created_at)}
          ${issue.milestone ? `<span class="meta-pill">${escapeHtml(issue.milestone.title)}</span>` : ""}
          ${labelChips(issue.labels)}
        </span>
      </span>
      <small>${issue.comments ? `${issue.comments} comments` : "No comments"}</small>
    </a>`)
    .join("") || `<div class="empty">${escapeHtml(emptyText)}</div>`}</div>`;
}
