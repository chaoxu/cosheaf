// Local working-tree implementation of WorkspaceBackend (Cosheaf Workbench).
//
// Bound to a single absolute `rootDir`, this serves the same typed routes the
// hosted app does, but reads/writes files on disk instead of calling a forge.
// It never imports the forge client — the Workbench path is forge-free (enforced
// by the no-forge workbench gate).
//
// Working-tree semantics: `owner`/`repo` are ignored (one workspace per folder)
// and every `ref`/`branch` aliases the current working tree. Reads return what
// is on disk now; writes land on disk immediately (a save, not a commit —
// committing is an explicit Tier-1 action). The content sha is the git blob
// hash so it equals the committed blob id for unchanged files and so a
// concurrent on-disk edit is detected as a stale-sha conflict.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  WorkspaceBackendError,
  type WorkspaceBackend,
  type WsBranch,
  type WsCreateBranch,
  type WsDeleteFile,
  type WsFileMeta,
  type WsFileWrite,
  type WsPull,
  type WsPutFile,
  type WsPutFileBytes,
  type WsRepo,
  type WsTreeEntry,
} from "../workspace-backend.js";
import type { WorkbenchProfile } from "./local-workspace.js";

// Outcome of a Tier-2 sync (fetch + fast-forward), reported back to the UI.
export interface SyncResult {
  fastForwarded: boolean;
  ahead: number;
  behind: number;
  message: string;
}

// The synthetic commit id every ref reports. The working tree is the only
// snapshot the local backend exposes, so reads against any ref read disk.
const WORKTREE_REF = "WORKTREE";

// Directories never surfaced as workspace content: VCS metadata and Cosheaf's
// own sidecar dir.
const SKIP_DIRS = new Set([".git", ".cosheaf"]);

// git blob hash: sha1("blob " + bytelength + "\0" + bytes). Equals `git
// hash-object` for the same content, so an unchanged tracked file's meta sha
// matches its committed blob id.
export function gitBlobHash(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

const execFileP = promisify(execFile);

// A single changed entry from `git status --porcelain` (Tier 1 status panel).
export interface GitStatusEntry {
  // The two-char porcelain status code (e.g. " M", "??", "A ").
  code: string;
  path: string;
}

export interface GitStatus {
  branch: string | null;
  entries: GitStatusEntry[];
}

export class LocalGitWorkspaceBackend implements WorkspaceBackend {
  private readonly root: string;
  private realRoot: string | undefined;
  // Monotonic per-instance counter so concurrent writes (even of identical
  // content) never collide on the same temp filename.
  private writeSeq = 0;
  // The git remote `push` targets. Defaults to `origin`; the registry sets this
  // to the working tree's actual upstream name (e.g. `cosheaf`) so a repo whose
  // upstream isn't called `origin` can still push for Tier-2 Open-PR.
  private readonly pushRemote: string;
  // Lazy getter for the Workbench profile (git authorship fallback). Read at
  // commit time so a profile set after the backend was built still applies.
  private readonly author: (() => WorkbenchProfile | null) | undefined;

  constructor(rootDir: string, opts: { pushRemote?: string; author?: () => WorkbenchProfile | null } = {}) {
    this.root = resolve(rootDir);
    this.pushRemote = opts.pushRemote ?? "origin";
    this.author = opts.author;
  }

  // Resolve a repo-relative path to an absolute path inside the root, rejecting
  // anything that would escape it. Routes already validate paths (safeRel), but
  // the backend is the trust boundary for the filesystem.
  private abs(filepath: string): string {
    const full = resolve(this.root, filepath);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new WorkspaceBackendError(400, "invalid_path", `path escapes workspace root: ${filepath}`);
    }
    return full;
  }

  // Resolve symlinks and re-assert containment so a link INSIDE the workspace
  // (e.g. `secret.md -> /etc/passwd` in a folder cloned from an untrusted
  // source) can't be read past the trust boundary. Throws not_found if the real
  // target escapes the root; rethrows ENOENT for a genuinely missing file.
  private async realInside(full: string): Promise<string> {
    const realRoot = (this.realRoot ??= await realpath(this.root));
    const real = await realpath(full);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new WorkspaceBackendError(404, "not_found", "not found");
    }
    return real;
  }

  private async readBytes(filepath: string): Promise<Buffer> {
    const full = this.abs(filepath);
    try {
      return await readFile(await this.realInside(full));
    } catch (err) {
      if (err instanceof WorkspaceBackendError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "EISDIR") {
        throw new WorkspaceBackendError(404, "not_found", `not found: ${filepath}`);
      }
      throw err;
    }
  }

  async getTree(_owner: string, _repo: string, _ref: string, _recursive = true): Promise<WsTreeEntry[]> {
    const entries: WsTreeEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          if (SKIP_DIRS.has(dirent.name)) continue;
          await walk(join(dir, dirent.name));
        } else if (dirent.isFile()) {
          // isFile() is false for symlinks, so links are not listed (and can't
          // be read through the tree). Use a stat-based signature for the sha:
          // it's only a cache key, and reading every blob — including large
          // binaries — just to hash it is wasteful and can exhaust memory.
          const full = join(dir, dirent.name);
          const rel = relative(this.root, full).split(sep).join("/");
          const info = await stat(full);
          const sha = createHash("sha1").update(`${rel}:${info.size}:${info.mtimeMs}`).digest("hex");
          entries.push({ path: rel, type: "blob", size: info.size, sha });
        }
      }
    };
    await walk(this.root);
    return entries;
  }

  async getRawFile(_owner: string, _repo: string, _ref: string, filepath: string): Promise<string> {
    return (await this.readBytes(filepath)).toString("utf8");
  }

  getRawFileBytes(_owner: string, _repo: string, _ref: string, filepath: string): Promise<Buffer> {
    return this.readBytes(filepath);
  }

  async getFileMeta(_owner: string, _repo: string, _ref: string, filepath: string): Promise<WsFileMeta | null> {
    const full = this.abs(filepath);
    try {
      const real = await this.realInside(full);
      const info = await stat(real);
      if (!info.isFile()) return null;
      const bytes = await readFile(real);
      return { sha: gitBlobHash(bytes), size: bytes.length };
    } catch (err) {
      // Missing file, or a symlink whose target escaped the root — both "no meta".
      if (err instanceof WorkspaceBackendError) return null;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  putFile(owner: string, repo: string, opts: WsPutFile): Promise<WsFileWrite> {
    return this.putFileBytes(owner, repo, { ...opts, content: Buffer.from(opts.content, "utf8") });
  }

  // The Workbench has a single working tree, so the work is always on whatever
  // branch is checked out. Reads already alias every ref to that tree; writes do
  // the same — the requested branch is advisory and never rejected, since there
  // is no other branch to write to. getRepo() reports the checked-out branch so
  // the UI routes there in the first place (no hardcoded "main" mismatch).
  async putFileBytes(_owner: string, _repo: string, opts: WsPutFileBytes): Promise<WsFileWrite> {
    const full = this.abs(opts.path);
    await mkdir(resolve(full, ".."), { recursive: true });
    // Write to a temp sibling then rename so a reader never sees a half-written
    // file. The temp name is derived from the content hash (no Math.random,
    // which is unavailable in some sandboxes and irrelevant here).
    const tmp = `${full}.tmp-${gitBlobHash(opts.content).slice(0, 12)}-${this.writeSeq++}`;
    await writeFile(tmp, opts.content);
    await rename(tmp, full);
    return { content: { sha: gitBlobHash(opts.content) }, commit: { sha: WORKTREE_REF } };
  }

  async deleteFile(_owner: string, _repo: string, opts: WsDeleteFile): Promise<void> {
    const full = this.abs(opts.path);
    try {
      await rm(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceBackendError(404, "not_found", `not found: ${opts.path}`);
      }
      throw err;
    }
  }

  // Any branch name "exists" (it aliases the working tree), so the route's
  // ensureBranch never tries to fork a branch and a save just writes to disk.
  async getBranch(_owner: string, _repo: string, branch: string): Promise<WsBranch | null> {
    return { name: branch, commit: { id: WORKTREE_REF } };
  }

  // Tier 0 (non-git folder): the working tree is a single `main` branch. Tier 1
  // (git repo): the real local branch list, so /raw/branch/<name> resolves and
  // the chrome reflects the actual branches. All refs alias the working tree for
  // reads; writes are pinned to the checked-out branch (see putFileBytes).
  async listBranches(_owner: string, _repo: string): Promise<WsBranch[]> {
    if (await this.isGitRepo()) {
      try {
        const out = await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
        const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
        if (names.length > 0) return names.map((name) => ({ name, commit: { id: WORKTREE_REF } }));
      } catch (_err) {
        // Fall through to the working-tree default.
      }
    }
    return [{ name: "main", commit: { id: WORKTREE_REF } }];
  }

  async createBranch(_owner: string, _repo: string, opts: WsCreateBranch): Promise<WsBranch> {
    return { name: opts.newBranchName, commit: { id: WORKTREE_REF } };
  }

  async deleteBranch(_owner: string, _repo: string, _branch: string): Promise<void> {
    // No-op: branches are not materialized in Tier 0.
  }

  async getRepo(_owner: string, _repo: string): Promise<WsRepo | null> {
    // The default branch is whatever the working tree has checked out, so the
    // repo landing, file tree, and edit links all route to the current branch —
    // the Workbench edits the current branch, never a hardcoded "main".
    const branch = (await this.currentBranch()) ?? "main";
    return { default_branch: branch, description: "", ssh_url: "", open_issues_count: 0 };
  }

  // No pull requests locally: the review/merge surface is the remote Cosheaf
  // (Tier 2), reached through CosheafOriginClient, not this backend.
  async listPulls(_owner: string, _repo: string, _state: "open" | "closed" | "all"): Promise<WsPull[]> {
    return [];
  }

  // ---------------- Tier 1: git operations ----------------
  //
  // These are extra capabilities of the local backend (not part of the
  // WorkspaceBackend interface), used by the local commit page. When the folder
  // is not a git repo they degrade to "no git" rather than failing.

  private gitRepo: boolean | undefined;

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileP("git", ["-C", this.root, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  async isGitRepo(): Promise<boolean> {
    if (this.gitRepo !== undefined) return this.gitRepo;
    try {
      const out = await this.git(["rev-parse", "--is-inside-work-tree"]);
      this.gitRepo = out.trim() === "true";
    } catch (_err) {
      this.gitRepo = false;
    }
    return this.gitRepo;
  }

  async currentBranch(): Promise<string | null> {
    try {
      const out = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return out && out !== "HEAD" ? out : null;
    } catch (_err) {
      return null;
    }
  }

  async gitStatus(): Promise<GitStatus> {
    if (!(await this.isGitRepo())) return { branch: null, entries: [] };
    const branch = await this.currentBranch();
    const out = await this.git(["status", "--porcelain=v1"]);
    const entries = out
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => {
        const code = line.slice(0, 2);
        const rest = line.slice(3).trim();
        // Renamed/copied entries are "old -> new"; show the new path.
        const arrow = rest.indexOf(" -> ");
        return { code, path: arrow === -1 ? rest : rest.slice(arrow + 4) };
      });
    return { branch, entries };
  }

  // Stage everything and commit. Returns the new commit sha, or null when there
  // was nothing to commit.
  async commitAll(message: string): Promise<string | null> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain=v1"]);
    if (status.trim() === "") return null;
    await this.git([...(await this.commitIdentityArgs()), "commit", "-m", message]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  // Fill `user.name`/`user.email` from the Workbench profile ONLY when the repo's
  // own git config has none — so a freshly-cloned folder commits without git's
  // "author identity unknown" error, while an existing git identity is respected.
  private async commitIdentityArgs(): Promise<string[]> {
    const name = (await this.git(["config", "user.name"]).catch(() => "")).trim();
    const email = (await this.git(["config", "user.email"]).catch(() => "")).trim();
    if (name && email) return [];
    const profile = this.author?.();
    if (!profile?.name || !profile?.email) return [];
    return ["-c", `user.name=${profile.name}`, "-c", `user.email=${profile.email}`];
  }

  // Tier 2: push a branch to the working tree's upstream remote over the user's
  // configured git transport (SSH key). Cosheaf is never in this path — the
  // remote service only opens the PR afterward.
  getPushRemoteName(): string {
    return this.pushRemote;
  }

  async pushRemoteUrl(): Promise<string | null> {
    if (!(await this.isGitRepo())) return null;
    try {
      const out = await this.git(["remote", "get-url", this.pushRemote]);
      return out.trim() || null;
    } catch (_err) {
      return null;
    }
  }

  async currentHeadSha(): Promise<string | null> {
    if (!(await this.isGitRepo())) return null;
    try {
      return (await this.git(["rev-parse", "HEAD"])).trim();
    } catch (_err) {
      return null;
    }
  }

  async push(branch: string): Promise<void> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    await this.git(["push", this.pushRemote, branch]);
  }

  // True when the current branch tracks an upstream (so Sync has somewhere to
  // fetch from). False for Tier 0/1 or a branch with no @{u}.
  async hasUpstream(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--abbrev-ref", "@{u}"]);
      return true;
    } catch (_err) {
      return false;
    }
  }

  // Commits the current branch is ahead/behind its upstream. 0/0 when there is no
  // upstream (so callers can treat "no upstream" as "nothing to sync").
  async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    try {
      const parts = (await this.git(["rev-list", "--left-right", "--count", "@{u}...HEAD"])).trim().split(/\s+/);
      return { behind: Number(parts[0]) || 0, ahead: Number(parts[1]) || 0 };
    } catch (_err) {
      return { ahead: 0, behind: 0 };
    }
  }

  // Tier 2: fetch the upstream and fast-forward the current branch. Never merges
  // or force-updates: if histories diverged it reports that and leaves the tree
  // untouched for the user to resolve in their terminal.
  async sync(): Promise<SyncResult> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    if (!(await this.currentBranch())) {
      throw new WorkspaceBackendError(409, "detached_head", "HEAD is detached; check out a branch before syncing");
    }
    if (!(await this.hasUpstream())) {
      throw new WorkspaceBackendError(409, "no_upstream", "this branch has no upstream to sync with");
    }
    await this.git(["fetch", this.pushRemote]);
    const { ahead, behind } = await this.aheadBehind();
    if (behind === 0) {
      return {
        fastForwarded: false,
        ahead,
        behind,
        message: ahead > 0 ? `Up to date; ${ahead} local commit${ahead === 1 ? "" : "s"} to push.` : "Already up to date.",
      };
    }
    if (ahead > 0) {
      return {
        fastForwarded: false,
        ahead,
        behind,
        message: `Local and remote diverged (${ahead} ahead, ${behind} behind). Merge or rebase in your terminal.`,
      };
    }
    await this.git(["merge", "--ff-only", "@{u}"]);
    return { fastForwarded: true, ahead: 0, behind, message: `Fast-forwarded ${behind} commit${behind === 1 ? "" : "s"} from the remote.` };
  }
}
