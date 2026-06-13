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

// Forgejo PR state vocabulary. Cosheaf no longer stores its own workflow
// state — `open` and `closed` come straight from Forgejo, and `merged` is
// distinguished by the `merged: true` flag on a closed PR.
export type PrState = "open" | "closed";

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
//  - blocked   : a branch-protection gate (e.g. required approvals) — get a review, don't force
//  - unknown   : unclassified precondition failure
export type MergeFailureReason = "conflict" | "transient" | "stale" | "blocked" | "unknown";

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
