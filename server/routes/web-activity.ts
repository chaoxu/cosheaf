import type { Hono } from "hono";
import {
  type ActivityFeedItem,
  activityCommitRef,
  branchFromRef,
  collapseNoisyEditBranchCommits,
  parseActivityContent,
} from "../activity-feed.js";
import type { ForgejoActivity, ForgejoNotificationThread } from "../forgejo-types.js";
import type { AppEnv } from "../types.js";
import { escapeHtml } from "./html-escape.js";
import {
  displayLogin,
  formatDate,
  htmlResponse,
  notFoundPage,
  positiveInt,
  redirect,
  repoHref,
  resolveWebRepo,
  urlPath,
  type WebCtx,
} from "./web-context.js";
import { repoPage } from "./web-page.js";

export function registerNotificationActivityRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/notifications", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const threads = await ctx.fj.listRepoNotifications(ctx.owner, ctx.repo, {
    statusTypes: ["unread"],
    subjectTypes: ["Issue", "Pull"],
  }).catch(() => []);
  return htmlResponse(
    repoPage({
      title: `Notifications - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "notifications",
      user: ctx.user,
      ws: ctx.ws,
      body: notificationsPage(ctx, threads),
    }),
  );
});

web.post("/:owner/:repo/notifications/:id/read", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const id = positiveInt(c.req.param("id"));
  if (!id) return notFoundPage(ctx.user, "Notification not found");
  const thread = await ctx.fj.getNotificationThread(id);
  if (thread.repository.full_name !== `${ctx.owner}/${ctx.repo}`) return notFoundPage(ctx.user, "Notification not found");
  await ctx.fj.markNotificationRead(id);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
});

web.post("/:owner/:repo/notifications/read-all", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  await ctx.fj.markRepoNotificationsRead(ctx.owner, ctx.repo);
  return redirect(repoHref(ctx.owner, ctx.repo, "/notifications"));
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
}

function notificationsPage(ctx: WebCtx, threads: readonly ForgejoNotificationThread[]): string {
  return `
    <div class="page-title compact">
      <div><p class="eyebrow">Unread</p><h1>Notifications</h1></div>
      ${
        threads.length === 0
          ? ""
          : `<form method="post" action="${repoHref(ctx.owner, ctx.repo, "/notifications/read-all")}">
              <button class="button" type="submit" data-testid="notifications-read-all">Mark all read</button>
            </form>`
      }
    </div>
    <div class="list" data-testid="notification-list">
      ${threads.map((thread) => notificationRow(ctx, thread)).join("") || `<div class="empty">No unread notifications.</div>`}
    </div>
  `;
}

function notificationRow(ctx: WebCtx, thread: ForgejoNotificationThread): string {
  const href = notificationHref(ctx, thread);
  const kind = thread.subject.type === "Pull" ? "Pull request" : thread.subject.type;
  return `<div class="list-row">
    <a class="inline-link" href="${href}"><strong>${escapeHtml(thread.subject.title)}</strong></a>
    <span>${escapeHtml(kind)} - ${formatDate(thread.updated_at)}</span>
    <form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, `/notifications/${thread.id}/read`)}">
      <button class="button" type="submit">Mark read</button>
    </form>
  </div>`;
}

function notificationHref(ctx: WebCtx, thread: ForgejoNotificationThread): string {
  const match = thread.subject.url.match(/\/(?:issues|pulls)\/(\d+)(?:$|[?#])/);
  const number = match ? Number(match[1]) : null;
  if (!number) return repoHref(ctx.owner, ctx.repo, "/notifications");
  return thread.subject.type === "Pull"
    ? repoHref(ctx.owner, ctx.repo, `/pulls/${number}`)
    : repoHref(ctx.owner, ctx.repo, `/issues/${number}`);
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
    case "create_issue":
      if (issue) return { summary: `opened ${activityIssueHtml(ctx, issue)}` };
      return { summary: "opened an issue" };
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
