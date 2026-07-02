import type { Hono } from "hono";
import { branchFromRef } from "../activity-feed.js";
import type { ActivityRow, NotificationRow } from "../../shared/issues.js";
import type { AppEnv } from "../types.js";
import {
  htmlResponse,
  notFoundPage,
  positiveInt,
  redirect,
  repoHref,
  timeEl,
  urlPath,
  userLink,
  type WebCtx,
  webRoute,
} from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { repoPageShell } from "./web-page.js";

export function registerNotificationActivityRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/notifications", webRoute(async (_c, ctx) => {
  const threads = await ctx.collab.listRepoNotifications(ctx.owner, ctx.repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  });
  return htmlResponse(
    repoPageShell(ctx, "notifications", `Notifications - ${ctx.repo}`, notificationsPage(ctx, threads)),
  );
}));

web.post("/:owner/:repo/notifications/:id/read", webRoute(async (c, ctx) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return notFoundPage(ctx.user, "Notification not found");
  const thread = await ctx.collab.getNotificationThread(id).catch(() => null);
  if (!thread || thread.repo !== `${ctx.owner}/${ctx.repo}`) return notFoundPage(ctx.user, "Notification not found");
  await ctx.collab.markNotificationRead(id);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
}));

web.post("/:owner/:repo/notifications/read-all", webRoute(async (_c, ctx) => {
  await ctx.collab.markRepoNotificationsRead(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
}));

web.get("/:owner/:repo/activity", webRoute(async (_c, ctx) => {
  const activities = await ctx.collab.listRepoActivities(ctx.owner, ctx.repo, { limit: 50 }).catch(() => []);
  return htmlResponse(
    repoPageShell(ctx, "activity", `Activity - ${ctx.repo}`, html`<div class="page-title compact"><h1>Activity</h1></div>
        ${activityList(ctx, activities)}`),
  );
}));
}

function notificationsPage(ctx: WebCtx, threads: readonly NotificationRow[]): Html {
  return html`
    <div class="page-title compact">
      <div><h1>Notifications</h1></div>
      ${
        threads.length === 0
          ? ""
          : html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, "/notifications/read-all")}">
              <button class="button" type="submit" data-testid="notifications-read-all">Mark all read</button>
            </form>`
      }
    </div>
    <div class="list" data-testid="notification-list">
      ${threads.length === 0 ? html`<div class="empty">No unread notifications.</div>` : threads.map((thread) => notificationRow(ctx, thread))}
    </div>
  `;
}

function notificationRow(ctx: WebCtx, thread: NotificationRow): Html {
  const href = notificationHref(ctx, thread);
  const kind = thread.kind === "pr" ? "Pull request" : "Issue";
  return html`<div class="list-row">
    <a class="inline-link" href="${href}"><strong>${thread.title}</strong></a>
    <span>${kind} - ${timeEl(thread.updated_at)}</span>
    <form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/notifications/${thread.id}/read`)}">
      <button class="button" type="submit">Mark read</button>
    </form>
  </div>`;
}

function notificationHref(ctx: WebCtx, thread: NotificationRow): string {
  return thread.kind === "pr"
    ? repoHref(ctx.owner, ctx.repo, `/pulls/${thread.number}`)
    : repoHref(ctx.owner, ctx.repo, `/issues/${thread.number}`);
}

function activityList(ctx: WebCtx, activities: ActivityRow[]): Html {
  return html`<div class="list">${activities.length === 0 ? html`<div class="empty">No activity.</div>` : activities.map((activity) => activityRow(ctx, activity))}</div>`;
}

function activityRow(ctx: WebCtx, activity: ActivityRow): Html {
  const rendered = renderActivity(ctx, activity);
  const count = activity.repeat_count > 1 ? html`<small class="activity-count">${activity.repeat_count} commits</small>` : emptyHtml;
  return html`<div class="list-row activity-row" data-testid="activity-row">
    <strong>${userLink(activity.author_username, ctx.local)}</strong>
    <span>${rendered.summary}${count}</span>
    <small>${timeEl(activity.created_at)}</small>
  </div>`;
}

function renderActivity(ctx: WebCtx, activity: ActivityRow): { summary: Html } {
  const branch = branchFromRef(activity.ref_name ?? undefined);
  const pr = activity.ref_index !== null ? { number: activity.ref_index, label: activity.ref_text ?? "" } : null;
  const issue = activity.ref_index;
  const commit = activity.commit_sha ? { sha: activity.commit_sha, message: activity.commit_message ?? "" } : null;
  const branchHtml = branch ? activityBranchHtml(ctx, branch) : null;
  const commitHtml = commit ? activityCommitHtml(ctx, commit.sha) : null;
  switch (activity.op_type) {
    case "commit_repo": {
      const message = commit?.message ? html`: ${firstLine(commit.message)}` : emptyHtml;
      const target = commitHtml ?? branchHtml;
      if (activity.repeat_count > 1) {
        return { summary: html`saved edits${message}${target ? html` ${target}` : ""}${branchHtml && commitHtml ? html` on ${branchHtml}` : ""}` };
      }
      return { summary: html`committed${message}${target ? html` ${target}` : ""}${branchHtml && commitHtml ? html` on ${branchHtml}` : ""}` };
    }
    case "create_pull_request":
      if (pr) return { summary: html`opened ${activityPullHtml(ctx, pr.number)}${pr.label ? html`: ${pr.label}` : ""}` };
      return { summary: html`opened a pull request` };
    case "merge_pull_request":
      if (pr) return { summary: html`merged ${activityPullHtml(ctx, pr.number)}${pr.label ? html` from ${pr.label}` : ""}` };
      return { summary: html`merged a pull request` };
    case "comment_pull":
      if (pr) return { summary: html`commented on ${activityPullHtml(ctx, pr.number)}` };
      return { summary: html`commented on a pull request` };
    case "create_issue":
      if (issue) return { summary: html`opened ${activityIssueHtml(ctx, issue)}` };
      return { summary: html`opened an issue` };
    case "close_issue":
      if (issue) return { summary: html`closed ${activityIssueHtml(ctx, issue)}` };
      return { summary: html`closed an issue` };
    case "reopen_issue":
      if (issue) return { summary: html`reopened ${activityIssueHtml(ctx, issue)}` };
      return { summary: html`reopened an issue` };
    case "comment_issue":
      if (issue) return { summary: html`commented on ${activityIssueHtml(ctx, issue)}` };
      return { summary: html`commented on an issue` };
    case "delete_branch":
      return { summary: html`deleted branch ${branch ?? ""}` };
    default:
      return { summary: html`${activity.op_type}${branchHtml ? html` on ${branchHtml}` : ""}` };
  }
}

function activityCommitHtml(ctx: WebCtx, sha: string): Html {
  return html`<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/commits/${encodeURIComponent(sha)}`)}">${sha.slice(0, 10)}</a>`;
}

function activityPullHtml(ctx: WebCtx, number: number): Html {
  return html`<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/pulls/${number}`)}">pull request #${number}</a>`;
}

function activityIssueHtml(ctx: WebCtx, number: number): Html {
  return html`<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, `/issues/${number}`)}">issue #${number}</a>`;
}

function activityBranchHtml(ctx: WebCtx, branch: string): Html {
  return html`<a class="inline-link" href="${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch)}">${branch}</a>`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}
