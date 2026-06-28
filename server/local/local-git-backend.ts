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

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  WorkspaceBackendError,
  type WorkspaceBackend,
  type WsBranch,
  type WsCommit,
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

export class LocalGitWorkspaceBackend implements WorkspaceBackend {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
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

  private async readBytes(filepath: string): Promise<Buffer> {
    try {
      return await readFile(this.abs(filepath));
    } catch (err) {
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
          const full = join(dir, dirent.name);
          const rel = relative(this.root, full).split(sep).join("/");
          const bytes = await readFile(full);
          entries.push({ path: rel, type: "blob", size: bytes.length, sha: gitBlobHash(bytes) });
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
      const info = await stat(full);
      if (!info.isFile()) return null;
      const bytes = await readFile(full);
      return { sha: gitBlobHash(bytes), size: bytes.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  putFile(owner: string, repo: string, opts: WsPutFile): Promise<WsFileWrite> {
    return this.putFileBytes(owner, repo, { ...opts, content: Buffer.from(opts.content, "utf8") });
  }

  async putFileBytes(_owner: string, _repo: string, opts: WsPutFileBytes): Promise<WsFileWrite> {
    const full = this.abs(opts.path);
    await mkdir(resolve(full, ".."), { recursive: true });
    // Write to a temp sibling then rename so a reader never sees a half-written
    // file. The temp name is derived from the content hash (no Math.random,
    // which is unavailable in some sandboxes and irrelevant here).
    const tmp = `${full}.tmp-${gitBlobHash(opts.content).slice(0, 12)}`;
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

  // Tier 0: the working tree is presented as a single `main` branch. Tier 1
  // (git repo) overrides this with the real branch list.
  async listBranches(_owner: string, _repo: string): Promise<WsBranch[]> {
    return [{ name: "main", commit: { id: WORKTREE_REF } }];
  }

  async createBranch(_owner: string, _repo: string, opts: WsCreateBranch): Promise<WsBranch> {
    return { name: opts.newBranchName, commit: { id: WORKTREE_REF } };
  }

  async deleteBranch(_owner: string, _repo: string, _branch: string): Promise<void> {
    // No-op: branches are not materialized in Tier 0.
  }

  async getRepo(_owner: string, _repo: string): Promise<WsRepo | null> {
    return { default_branch: "main", description: "", ssh_url: "", open_issues_count: 0 };
  }

  // No pull requests locally: the review/merge surface is the remote Cosheaf
  // (Tier 2), reached through RemoteCosheafClient, not this backend.
  async listPulls(_owner: string, _repo: string, _state: "open" | "closed" | "all"): Promise<WsPull[]> {
    return [];
  }

  async getCommit(_owner: string, _repo: string, sha: string): Promise<WsCommit> {
    throw new WorkspaceBackendError(404, "not_found", `commit not available locally: ${sha}`);
  }

  // Expose the root for the launcher (indexing, identity derivation).
  get rootDir(): string {
    return this.root;
  }

  async exists(filepath: string): Promise<boolean> {
    return pathExists(this.abs(filepath));
  }
}
