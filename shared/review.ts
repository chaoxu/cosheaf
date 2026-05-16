// Types shared by server and client for the PR review surface.

export type PullFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface PullFile {
  path: string;
  previous_path?: string;
  status: PullFileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface PullFiles {
  files: PullFile[];
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
}
