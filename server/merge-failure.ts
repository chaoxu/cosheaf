// Merge-precondition status plumbing extracted from routes/pulls.ts. Classifies
// merge failures into agent-actionable reasons, maps backend errors to HTTP
// status, reads the base-branch review gate, and provides client-safe copy.
// Self-contained: it depends only on the collaboration client seam and shared
// review DTOs, never on the route module.

import type { CollaborationClient } from "./collaboration-client.js";
import { ForgejoError, mergePullWithRetry } from "./forgejo.js";
import { errorStatus } from "./forgejo-errors.js";
import type { MergeFailure, MergeFailureReason, PrMeta, PrState, ReviewDto } from "../shared/review.js";

// Latest-per-user approval count, ignoring older reviews from the same user.
export function approvalCountsFromReviews(reviews: readonly ReviewDto[]): { approvals: number; rejections: number } {
  const latestByUser = new Map<string, ReviewDto>();
  const ordered = [...reviews].sort((a, b) => {
    const at = a.created_at;
    const bt = b.created_at;
    return at - bt || (a.id ?? 0) - (b.id ?? 0);
  });
  for (const r of ordered) {
    // Forgejo may keep deleted-account reviews with user=null, but without a
    // stable reviewer identity we cannot collapse to "latest verdict per user"
    // without risking overcounts. Leave merge authority to Forgejo itself.
    if (!r.username) continue;
    // #56: DISMISSED must invalidate an earlier APPROVED/REQUEST_CHANGES from
    // the same user, otherwise stale approvals/rejections persist after
    // Forgejo has already dismissed them.
    if (r.decision === "approve" || r.decision === "request_changes" || r.decision === "dismissed") {
      latestByUser.set(r.username, r);
    }
  }
  let approvals = 0;
  let rejections = 0;
  for (const r of latestByUser.values()) {
    if (r.decision === "approve") approvals++;
    else if (r.decision === "request_changes") rejections++;
  }
  return { approvals, rejections };
}

export async function approvalCounts(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ approvals: number; rejections: number }> {
  return approvalCountsFromReviews(await collab.listReviews(owner, repo, prNumber));
}

// Forgejo can return 405 "try again later" right after an approve lands and
// before its merge gate sees the new state. Retry with linear backoff.
type MergeFailureResult = { ok: false; status: number; message: string; transientExhausted: boolean };

export async function mergeWithRetry(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  prNumber: number,
  opts: { Do?: "squash" | "merge" | "rebase"; force?: boolean } = {},
): Promise<{ ok: true } | MergeFailureResult> {
  const Do = opts.Do ?? "squash";
  try {
    await mergePullWithRetry(() => collab.mergePull(owner, repo, prNumber, { Do, force: opts.force }));
    return { ok: true };
  } catch (err) {
    return forgejoErrToResult(err);
  }
}

function forgejoErrToResult(err: unknown): MergeFailureResult {
  // Status-bearing so a local Workbench merge (RemoteCosheafError) classifies the
  // same as a hosted forge merge (ForgejoError) — both carry a numeric `status`.
  const status = errorStatus(err);
  if (status !== null) {
    // `bodyText` is forge-specific; the remote core carries its detail on the
    // error message instead. Keep the forge body parsing working for hosted.
    const bodyText = err instanceof ForgejoError ? err.bodyText : err instanceof Error ? err.message : "";
    const message = bodyText || "backend rejected request";
    // A 405 "try again later" that survived all of mergePullWithRetry's retries:
    // the merge stayed transient, not a hard conflict. Flagged so the handler
    // can classify the eventual 409 without re-parsing the error.
    const transientExhausted = status === 405 && /try again/i.test(bodyText);
    // Pass distinguishable 4xx through so the client can show the right
    // affordance — auth/permission, missing target, validation, rate limit —
    // instead of collapsing every precondition failure into 409.
    if (status === 401 || status === 403) return { ok: false, status, message, transientExhausted };
    if (status === 404) return { ok: false, status: 404, message, transientExhausted };
    if (status === 422) return { ok: false, status: 422, message, transientExhausted };
    if (status === 429) return { ok: false, status: 429, message, transientExhausted };
    // 405 (conflict: e.g. "Please try again later", "PR has conflicts"), 409,
    // and any other 4xx we don't separate map to 409 — the caller violated a
    // merge precondition. 5xx → backend upstream is sick: 502.
    if (status >= 500) return { ok: false, status: 502, message, transientExhausted };
    return { ok: false, status: 409, message, transientExhausted };
  }
  return { ok: false, status: 500, message: (err as Error)?.message ?? "merge failed", transientExhausted: false };
}

// The branch-protection review gate state for the PR's base branch, read when a
// merge failed but the PR has no content conflict — to tell "blocked on review
// requirements" from "transient" structurally rather than by parsing Forgejo's
// error text.
export interface ReviewGate {
  requiredApprovals: number;
  approvals: number;
  rejections: number;
}

// Read the base-branch protection + this PR's current approval/rejection counts.
// Best-effort: a missing protection or unreadable reviews collapse to a
// non-blocking gate so we don't mislabel a transient failure as blocked.
export async function readReviewGate(
  collab: CollaborationClient,
  owner: string,
  repo: string,
  prNumber: number,
  baseRef: string,
): Promise<ReviewGate> {
  const [bp, counts] = await Promise.all([
    collab.getBranchProtection(owner, repo, baseRef).catch(() => null),
    approvalCounts(collab, owner, repo, prNumber).catch(() => null),
  ]);
  if (!counts) return { requiredApprovals: 0, approvals: 0, rejections: 0 };
  return { requiredApprovals: bp?.required_approvals ?? 0, approvals: counts.approvals, rejections: counts.rejections };
}

// Classify a merge-precondition failure (the 409 bucket) into an agent-actionable
// reason by re-reading the live PR (#94). `pull` is the re-read PR (null if it's
// gone), `message` is Forgejo's body text (used only for the human error string),
// `reviewGate` is the base-branch protection + approval counts (null when not
// needed — i.e. the PR is gone/merged or has a real content conflict), and
// `transientExhausted` is whether the retried path stayed transient.
export function classifyMergeFailure(
  pull: PrMeta | null,
  reviewGate: ReviewGate | null,
  transientExhausted: boolean,
): MergeFailure {
  const head_sha = pull?.head_sha ?? null;
  const base_sha = pull?.base_sha ?? null;
  const state: PrState = pull?.state === "closed" ? "closed" : "open";
  const merged = pull?.merged ?? false;
  const mergeable = pull?.mergeable ?? null;
  const reviewBlocked =
    reviewGate !== null && (reviewGate.approvals < reviewGate.requiredApprovals || reviewGate.rejections > 0);
  let reason: MergeFailureReason;
  if (pull === null || merged) reason = "stale";
  else if (pull.state === "closed") reason = "closed";
  else if (mergeable === false) reason = "conflict";
  else if (reviewBlocked) reason = "blocked";
  else if (mergeable === null || transientExhausted) reason = "transient";
  else reason = "unknown";
  return { error: mergeFailureMessage(reason), code: "conflict", reason, mergeable, head_sha, base_sha, state, merged };
}

// Client-safe merge-failure copy keyed on the structured reason/status. NEVER echo
// Forgejo's raw body text to a caller — it carries internal backend URLs (e.g. the
// forge host:port). The raw text is logged server-side (with the request id) for
// debugging; only these sentences reach the browser/agent.
export function mergeFailureMessage(reason: MergeFailureReason): string {
  switch (reason) {
    case "blocked":
      return "This pull request needs its required approvals before it can merge.";
    case "conflict":
      return "This pull request has conflicts that must be resolved before it can merge.";
    case "stale":
      return "This pull request is already merged or no longer open.";
    case "closed":
      return "This pull request is closed; reopen it before merging.";
    case "transient":
      return "The merge service is busy — try again in a moment.";
    case "unknown":
      return "The merge was rejected.";
  }
}

export function isSettingsPayload(value: unknown): value is { min_approvals?: number; default_md_format?: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function mergeStatusMessage(status: number): string {
  if (status === 401 || status === 403) return "You don't have permission to merge this pull request.";
  if (status === 404) return "This pull request no longer exists.";
  if (status === 422) return "The merge request was invalid.";
  if (status === 429) return "Too many merge attempts — try again shortly.";
  if (status === 502) return "The merge service is unavailable — try again shortly.";
  return "The merge failed unexpectedly.";
}
