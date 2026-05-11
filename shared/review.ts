// Types shared by server and client for the PR review surface.

import type { ChangeState } from "./change-lifecycle.js";

export type PullFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface PullFile {
  path: string;
  previous_path?: string;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ChangeDiff {
  files: PullFile[];
}

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  state: ChangeState;
  author_user_id: number;
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
}
