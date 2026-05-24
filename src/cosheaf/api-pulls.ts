import type { CommentSide, LineComment } from "../../shared/comments";
import type { PrFiles, PrMeta } from "../../shared/review";
import type { ApprovalRecord, DecisionResult } from "./api-types";
import { jsonFetch, workspaceApiPath as w } from "./api-core";

export const pullApi = {
  listPulls: (
    slug: string,
    state: "open" | "closed" | "all" = "open",
    filters: { label?: number; milestone?: number; author?: string; sort?: string } = {},
  ) => {
    const q = new URLSearchParams({ state });
    if (filters.label) q.set("labels", String(filters.label));
    if (filters.milestone) q.set("milestone", String(filters.milestone));
    if (filters.author?.trim()) q.set("author", filters.author.trim());
    if (filters.sort) q.set("sort", filters.sort);
    return jsonFetch<{ pulls: PrMeta[] }>(`${w(slug)}/pulls?${q}`).then((r) => r.pulls);
  },
  openPull: (
    slug: string,
    payload: { head: string; base?: string; title?: string; body?: string },
  ) =>
    jsonFetch<PrMeta>(`${w(slug)}/pulls`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getPull: (slug: string, prNumber: number) =>
    jsonFetch<{ pull: PrMeta }>(`${w(slug)}/pulls/${prNumber}`).then((r) => r.pull),
  updatePull: (slug: string, prNumber: number, body: { title?: string; body?: string }) =>
    jsonFetch<{ pull: PrMeta }>(`${w(slug)}/pulls/${prNumber}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.pull),
  setPullLabels: (slug: string, prNumber: number, labels: number[]) =>
    jsonFetch<{ pull: PrMeta }>(`${w(slug)}/pulls/${prNumber}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    }).then((r) => r.pull),
  mergePull: (
    slug: string,
    prNumber: number,
    opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: opts.Do ?? "squash", force: opts.force ?? false }),
    }),
  closePull: (slug: string, prNumber: number) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/close`, { method: "POST" }),

  listPrFiles: (slug: string, prNumber: number) =>
    jsonFetch<PrFiles>(`${w(slug)}/pulls/${prNumber}/files`),
  pullFile: (slug: string, prNumber: number, path: string, side: "base" | "head") =>
    jsonFetch<{ content: string }>(
      `${w(slug)}/pulls/${prNumber}/file?path=${encodeURIComponent(path)}&side=${side}`,
    ).then((r) => r.content),

  submitReview: (
    slug: string,
    prNumber: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string | null,
  ) =>
    jsonFetch<DecisionResult>(`${w(slug)}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event, body: body ?? null }),
    }),
  listReviews: (slug: string, prNumber: number) =>
    jsonFetch<{ reviews: ApprovalRecord[]; approvals: number; rejections: number }>(
      `${w(slug)}/pulls/${prNumber}/reviews`,
    ),
  listReviewRequests: (slug: string, prNumber: number) =>
    jsonFetch<{
      requested_reviewers: string[];
      requested_reviewer_teams: string[];
      available_reviewers: string[];
    }>(`${w(slug)}/pulls/${prNumber}/review-requests`),
  requestPullReviewers: (slug: string, prNumber: number, reviewers: string[]) =>
    jsonFetch<{ pull: PrMeta }>(`${w(slug)}/pulls/${prNumber}/review-requests`, {
      method: "POST",
      body: JSON.stringify({ reviewers }),
    }).then((r) => r.pull),
  removePullReviewers: (slug: string, prNumber: number, reviewers: string[]) =>
    jsonFetch<{ pull: PrMeta | null }>(`${w(slug)}/pulls/${prNumber}/review-requests`, {
      method: "DELETE",
      body: JSON.stringify({ reviewers }),
    }).then((r) => r.pull),

  listComments: (slug: string, prNumber: number) =>
    jsonFetch<{ comments: LineComment[] }>(`${w(slug)}/pulls/${prNumber}/comments`).then((r) => r.comments),
  addComment: (
    slug: string,
    prNumber: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/pulls/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  editComment: (slug: string, prNumber: number, commentId: number, body: string) =>
    jsonFetch<unknown>(`${w(slug)}/pulls/${prNumber}/comments/${commentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }).then(() => ({ ok: true as const })),
  deleteComment: (slug: string, prNumber: number, commentId: number, reviewId: number) =>
    jsonFetch<unknown>(
      `${w(slug)}/pulls/${prNumber}/comments/${commentId}?review_id=${encodeURIComponent(String(reviewId))}`,
      { method: "DELETE" },
    ).then(() => ({ ok: true as const })),

  startPendingReview: (slug: string, prNumber: number) =>
    jsonFetch<{ review_id: number }>(`${w(slug)}/pulls/${prNumber}/pending-review`, { method: "POST" }),
  addPendingReviewComment: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { path: string; line: number; side: CommentSide; body: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/pending-review/${reviewId}/comments`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  submitPendingReview: (
    slug: string,
    prNumber: number,
    reviewId: number,
    payload: { event: "approve" | "request_changes" | "comment"; body?: string },
  ) =>
    jsonFetch<{ ok: true }>(
      `${w(slug)}/pulls/${prNumber}/pending-review/${reviewId}/submit`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
};
