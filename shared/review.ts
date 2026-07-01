// Types shared by server and client for the PR review surface.

import type { Label } from "./issues.js";

export type PrFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface PrFile {
  path: string;
  previous_path?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface PrFiles {
  files: PrFile[];
}

// A single commit on a pull request's head branch. `author_username` is the
// Forgejo login when the commit author is a known forge user (null otherwise);
// `author_name` is the git author name from the commit metadata.
export interface PrCommit {
  sha: string;
  message: string;
  author_username: string | null;
  author_name: string | null;
  date: number | null;
}

export interface PrCommits {
  commits: PrCommit[];
}

// Forgejo PR state vocabulary. Cosheaf no longer stores its own workflow
// state — `open` and `closed` come straight from Forgejo, and `merged` is
// distinguished by the `merged: true` flag on a closed PR.
export type PrState = "open" | "closed";

// Forgejo review states / submit events. One owner for the vocabulary the forge
// client, forge types, and the Origin collaboration client all spell out. A
// submitted review can never be PENDING (that's the unsubmitted draft state).
// The GET /pulls/:n/reviews wire item. Owned here so the hosted core adapter,
// local Workbench Origin client, and typed route can't drift.
export type ReviewDecision = "approve" | "request_changes" | "comment" | "pending" | "dismissed";
export interface ReviewDto {
  id: number;
  username: string;
  decision: ReviewDecision;
  comment: string | null;
  created_at: number;
}

export const REVIEW_STATES = ["APPROVED", "REQUEST_CHANGES", "COMMENT", "PENDING"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export type ReviewSubmitEvent = Exclude<ReviewState, "PENDING">;

// The author self-review gate: a PR author may leave a plain COMMENT review on
// their own PR, but not approve / request-changes (that would game the
// required-approvals threshold). This owns the "which review events are exempt"
// decision for both the typed PR API and the server-rendered review route, which
// spell the event differently ("comment" vs "COMMENT"), so it normalizes case.
export function reviewRequiresNonAuthor(event: string): boolean {
  return event.toUpperCase() !== "COMMENT";
}

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  state: PrState;
  merged: boolean;
  author_username: string;
  created_at: number;
  merged_at: number | null;
  mergeable: boolean | null;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  additions_total: number;
  deletions_total: number;
  files_changed: number;
  comment_count: number;
  labels: Label[];
  milestone: { id: number; title: string } | null;
  requested_reviewers: string[];
  requested_reviewer_teams: string[];
}

// Why a merge attempt failed, after Cosheaf has exhausted its transient retries
// and re-read the PR. Lets an agent choose the right recovery instead of
// blindly retrying or force-merging a generic 409 (#94):
//  - conflict  : the branch has real merge conflicts (main moved) — rebase or close as dup
//  - transient : mergeability still computing / "try again later" survived retries — retry after a delay
//  - stale     : the PR is already merged or gone — treat as done
//  - closed    : the PR still exists but was closed without merging — reopen it to merge
//  - blocked   : a branch-protection gate (e.g. required approvals) — get a review, don't force
//  - unknown   : unclassified precondition failure
export type MergeFailureReason = "conflict" | "transient" | "stale" | "closed" | "blocked" | "unknown";

export interface MergeFailure {
  error: string;
  code: "conflict";
  reason: MergeFailureReason;
  mergeable: boolean | null;
  head_sha: string | null;
  base_sha: string | null;
  state: PrState;
  merged: boolean;
}
