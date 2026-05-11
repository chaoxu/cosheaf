// Per-file diff metadata for a pull request. Shared by server and client.

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
