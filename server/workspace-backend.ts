// The repository data-access seam every workspace route flows through.
//
// `WorkspaceBackend` is the abstraction that lets the same routes/islands serve
// either a hosted Forgejo workspace (ForgejoWorkspaceBackend, see
// `forgejo-backend.ts`) or a local working tree (LocalGitWorkspaceBackend, see
// `local/`). It speaks Cosheaf-native DTOs and throws a native
// `WorkspaceBackendError` — no Forgejo type or error crosses this line, so the
// local backend and everything under `server/local/**` stay Forgejo-free.
//
// The DTO shapes are deliberately structural subsets of what the route code
// reads (sha, commit.id, head.ref, …) so the hosted ForgejoWorkspaceBackend can
// return its Forgejo responses directly and the conversion stays mechanical.

// A backend operation failed with a recoverable, classifiable status. `code`
// carries the semantic the route branches on (so it never reaches into a
// backend-specific error body):
//   - "not_found"     — ref or file missing (HTTP 404)
//   - "stale_sha"     — compare-and-set lost a head race (409, or 422 sha mismatch)
//   - "ref_missing"   — branch/sha vanished mid-read (400 "sha not found")
//   - "conflict"      — other 409 conflict
//   - "unprocessable" — other 422
//   - "error"         — anything else (status preserved)
export class WorkspaceBackendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? `workspace backend ${status} ${code}`);
    this.name = "WorkspaceBackendError";
  }
}

// True for a concurrent-write loss: the blob sha the caller based its edit on no
// longer matches the branch head. Mirrors the old `isStaleShaConflict` (409, or
// 422 "sha does not match") but classifies on the native error code so routes
// don't pattern-match a forge error body.
export function isStaleShaConflict(err: unknown): boolean {
  return err instanceof WorkspaceBackendError && err.code === "stale_sha";
}

// True for a "resource not found" backend error (ref/file missing, HTTP 404).
export function isWorkspaceNotFound(err: unknown): boolean {
  return err instanceof WorkspaceBackendError && err.code === "not_found";
}

// `.catch` handler that swallows a backend not-found into `fallback` and
// rethrows everything else — the native twin of the old `onForgejo404`.
export function onWorkspaceNotFound<T>(fallback: T): (err: unknown) => T {
  return (err: unknown) => {
    if (isWorkspaceNotFound(err)) return fallback;
    throw err;
  };
}

export interface WsTreeEntry {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
  sha: string;
}

export interface WsFileMeta {
  sha: string;
  size: number;
}

// Result of a content write: the new blob sha (null when the backend can't
// report one) and the commit it landed in.
export interface WsFileWrite {
  content: { sha: string } | null;
  commit: { sha: string };
}

export interface WsBranch {
  name: string;
  commit: {
    id: string;
    timestamp?: string;
    author?: { username?: string; name?: string; email?: string };
  };
}

export interface WsRepo {
  default_branch: string;
  description?: string;
  ssh_url?: string;
  updated_at?: string;
  open_issues_count?: number;
}

// The pull-request fields the mounted routes read for branch/edit-branch state
// (retired-edit-branch detection, "branch has an open PR"). The full PR/review
// surface stays on the hosted `Forgejo` client, outside this seam.
export interface WsPull {
  head: { ref: string };
  base: { ref: string };
  merged: boolean;
  state: "open" | "closed";
}

export interface WsPutFile {
  branch: string;
  path: string;
  content: string;
  sha?: string;
  message: string;
}

export interface WsPutFileBytes {
  branch: string;
  path: string;
  content: Buffer;
  sha?: string;
  message: string;
}

export interface WsDeleteFile {
  branch: string;
  path: string;
  sha: string;
  message: string;
}

export interface WsCreateBranch {
  newBranchName: string;
  oldBranchName?: string;
}

// The repository data layer. Methods keep `(owner, repo, …)` so the hosted
// conversion is a mechanical `repoCtx.fj` → `repoCtx.backend` rename; the local
// backend is bound to a single working tree and ignores owner/repo.
export interface WorkspaceBackend {
  // tree + reads
  getTree(owner: string, repo: string, ref: string, recursive?: boolean): Promise<WsTreeEntry[]>;
  getRawFile(owner: string, repo: string, ref: string, filepath: string): Promise<string>;
  getRawFileBytes(owner: string, repo: string, ref: string, filepath: string): Promise<Buffer>;
  getFileMeta(owner: string, repo: string, ref: string, filepath: string): Promise<WsFileMeta | null>;
  // writes
  putFile(owner: string, repo: string, opts: WsPutFile): Promise<WsFileWrite>;
  putFileBytes(owner: string, repo: string, opts: WsPutFileBytes): Promise<WsFileWrite>;
  deleteFile(owner: string, repo: string, opts: WsDeleteFile): Promise<void>;
  // branches
  getBranch(owner: string, repo: string, branch: string): Promise<WsBranch | null>;
  listBranches(owner: string, repo: string): Promise<WsBranch[]>;
  createBranch(owner: string, repo: string, opts: WsCreateBranch): Promise<WsBranch>;
  deleteBranch(owner: string, repo: string, branch: string): Promise<void>;
  // repo meta + pulls
  getRepo(owner: string, repo: string): Promise<WsRepo | null>;
  listPulls(owner: string, repo: string, state: "open" | "closed" | "all"): Promise<WsPull[]>;
}
