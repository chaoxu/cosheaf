import type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  TimelineEvent,
} from "../../shared/issues";
import { jsonFetch, workspaceApiPath as w } from "./api-core";

export const issueApi = {
  listIssues: (
    slug: string,
    opts: {
      state?: "open" | "closed" | "all";
      filter?: "mine" | "assigned" | "all";
      q?: string;
      label?: string;
      milestone?: string;
      assigned_by?: string;
      created_by?: string;
      sort?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.state) qs.set("state", opts.state);
    if (opts.filter) qs.set("filter", opts.filter);
    if (opts.q && opts.q.trim()) qs.set("q", opts.q.trim());
    if (opts.label) qs.set("labels", opts.label);
    if (opts.milestone) qs.set("milestones", opts.milestone);
    if (opts.assigned_by?.trim()) qs.set("assigned_by", opts.assigned_by.trim());
    if (opts.created_by?.trim()) qs.set("created_by", opts.created_by.trim());
    if (opts.sort) qs.set("sort", opts.sort);
    const q = qs.toString();
    return jsonFetch<{ issues: IssueRow[] }>(`${w(slug)}/issues${q ? `?${q}` : ""}`);
  },
  getIssue: (slug: string, number: number) =>
    jsonFetch<IssueDetail>(`${w(slug)}/issues/${number}`),
  updateIssue: (slug: string, number: number, body: { title?: string; body?: string }) =>
    jsonFetch<Pick<IssueDetail, "number" | "title" | "body" | "state">>(`${w(slug)}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  getIssueComments: (slug: string, number: number) =>
    jsonFetch<{ comments: IssueComment[] }>(`${w(slug)}/issues/${number}/comments`),
  createIssue: (slug: string, body: { title: string; body: string }) =>
    jsonFetch<{ number: number; title: string; state: "open" | "closed" }>(
      `${w(slug)}/issues`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  closeIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true; state: "open" | "closed" }>(`${w(slug)}/issues/${number}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    }).then((issue) => ({ ok: true as const, state: issue.state as "closed" })),
  reopenIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true; state: "open" | "closed" }>(`${w(slug)}/issues/${number}/state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    }).then((issue) => ({ ok: true as const, state: issue.state as "open" })),
  createIssueComment: (slug: string, number: number, body: string) =>
    jsonFetch<IssueComment>(`${w(slug)}/issues/${number}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  editIssueComment: (slug: string, number: number, id: number, body: string) =>
    jsonFetch<IssueComment>(`${w(slug)}/issues/${number}/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }).then((cm) => ({ id: cm.id, body: cm.body, updated_at: cm.updated_at })),
  deleteIssueComment: (slug: string, number: number, id: number) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/comments/${id}`, { method: "DELETE" }).then(
      () => ({ ok: true as const }),
    ),
  renderMarkdown: (slug: string, text: string): Promise<{ html: string }> =>
    jsonFetch<{ html: string }>(`${w(slug)}/markdown/render`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  listLabels: (slug: string) =>
    jsonFetch<{ labels: Label[] }>(`${w(slug)}/labels`),
  createLabel: (slug: string, body: { name: string; color: string; description?: string; exclusive?: boolean }) =>
    jsonFetch<Label>(`${w(slug)}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, color: body.color.replace(/^#/, "") }),
    }),
  setIssueLabels: (slug: string, number: number, labels: number[]) =>
    jsonFetch<{ labels: Label[] }>(`${w(slug)}/issues/${number}/labels`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    }),
  listPinnedIssues: (slug: string) =>
    jsonFetch<{ issues: IssueRow[] }>(`${w(slug)}/issues/pinned`),
  pinIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/pin`, { method: "POST" }),
  unpinIssue: (slug: string, number: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/issues/${number}/pin`, { method: "DELETE" }),
  getIssueTimeline: (slug: string, number: number) =>
    jsonFetch<{ events: TimelineEvent[] }>(`${w(slug)}/issues/${number}/timeline`),
  listActivities: (slug: string, limit = 50) =>
    jsonFetch<{ activities: ActivityRow[] }>(`${w(slug)}/activities?limit=${limit}`),
  listIssueDependencies: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/dependencies`),
  listIssueBlocks: (slug: string, number: number) =>
    jsonFetch<{ issues: DependencyRow[] }>(`${w(slug)}/issues/${number}/blocks`),
  addIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).then(() => ({ ok: true as const })),
  removeIssueDependency: (slug: string, number: number, index: number) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/dependencies`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index }),
    }).then(() => ({ ok: true as const })),
  listMilestones: (slug: string, state: "open" | "closed" | "all" = "open") =>
    jsonFetch<{ milestones: Milestone[] }>(`${w(slug)}/milestones?state=${state}`),
  createMilestone: (slug: string, body: { title: string; description?: string }) =>
    jsonFetch<{ id: number; title: string; state: "open" | "closed" }>(`${w(slug)}/milestones`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  setIssueMilestone: (slug: string, number: number, id: number | null) =>
    jsonFetch<unknown>(`${w(slug)}/issues/${number}/milestone`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).then(() => ({ ok: true as const })),
};
