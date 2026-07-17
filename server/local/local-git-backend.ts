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
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { splitUnifiedDiff } from "../diff-splitter.js";
import { gitBlobHash } from "../git-object.js";
import { isCommitSha } from "../branch-path.js";
import {
  type WorkspaceBackend,
  WorkspaceBackendError,
  type WsBranch,
  type WsCommit,
  type WsCreateBranch,
  type WsDeleteFile,
  type WsFileMeta,
  type WsFileRead,
  type WsFileWrite,
  type WsPull,
  type WsPutFile,
  type WsPutFileBytes,
  type WsRepo,
  type WsTreeEntry,
} from "../workspace-backend.js";
import type { WorkbenchProfile } from "./local-workspace.js";
import { KeyedQueue } from "./keyed-queue.js";

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

export { gitBlobHash };

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

export interface LocalFileDiff {
  path: string;
  previous_path?: string;
  patch: string;
  changed: boolean;
  review_hash: string;
}

export interface LocalHeadFile {
  path: string;
  content: string;
  head_sha: string;
}

export interface LocalExpectedFileState {
  headSha?: string;
  sha?: string | null;
}

export interface LocalTextFileState {
  head: LocalHeadFile;
  current: string;
  currentSha: string;
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
  private readonly mutationQueue = new KeyedQueue();
  private gitPrefixValue: string | undefined;

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

  // Write-side twin of realInside: symlink-resolve the nearest existing ancestor
  // directory of a write/delete target and re-assert containment. abs() is
  // lexical only, so without this a symlinked directory component in an untrusted
  // opened folder (e.g. `sub -> ~/.ssh`) would redirect a write/delete outside
  // the root. Walks up because a new file's parent dirs may not exist yet.
  private async assertRealParentInside(full: string): Promise<void> {
    const realRoot = (this.realRoot ??= await realpath(this.root));
    let dir = resolve(full, "..");
    for (;;) {
      let real: string | null = null;
      try {
        real = await realpath(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (real === null) {
        const parent = resolve(dir, "..");
        if (parent === dir) return; // reached the filesystem root without escaping
        dir = parent;
        continue;
      }
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new WorkspaceBackendError(400, "invalid_path", "path escapes workspace root");
      }
      return;
    }
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

  private async withPathMutation<T>(fullPath: string, fn: () => Promise<T>): Promise<T> {
    return this.mutationQueue.run(fullPath, fn);
  }

  private withGitMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.withPathMutation(`${this.root}\0git`, fn);
  }

  private assertExpectedHead(head: LocalHeadFile, expected: LocalExpectedFileState): void {
    if (expected.headSha && head.head_sha !== expected.headSha) {
      throw new WorkspaceBackendError(409, "stale_sha", "suggesting base changed; reload the file and retry");
    }
  }

  private assertExpectedBlob(path: string, currentSha: string | null, expected: LocalExpectedFileState): void {
    if (expected.sha !== undefined && currentSha !== expected.sha) {
      throw new WorkspaceBackendError(409, "stale_sha", `suggesting file changed; reload the file and retry: ${path}`);
    }
  }

  async getSuggestingHeadFile(path: string): Promise<LocalHeadFile> {
    try {
      return await this.getHeadFile(path);
    } catch (err) {
      if (!(err instanceof WorkspaceBackendError) || err.status !== 404) throw err;
      const meta = await this.getFileMeta("", "", "WORKTREE", path);
      if (!meta) throw err;
      const headSha = await this.currentHeadSha();
      if (!headSha) throw err;
      return { path, content: "", head_sha: headSha };
    }
  }

  private async writeBytesUnlocked(full: string, content: Buffer): Promise<WsFileWrite> {
    await this.assertRealParentInside(full);
    await mkdir(resolve(full, ".."), { recursive: true });
    const tmp = `${full}.tmp-${gitBlobHash(content).slice(0, 12)}-${this.writeSeq++}`;
    await writeFile(tmp, content);
    await rename(tmp, full);
    return { content: { sha: gitBlobHash(content) }, commit: { sha: WORKTREE_REF } };
  }

  async mutateTextFileAgainstHead(
    path: string,
    expected: LocalExpectedFileState,
    mutate: (state: LocalTextFileState) => Promise<string | null> | string | null,
  ): Promise<{ path: string; content: string; sha: string; head: LocalHeadFile } | null> {
    const full = this.abs(path);
    return this.withGitMutation(() => this.withPathMutation(full, async () => {
      const head = await this.getSuggestingHeadFile(path);
      this.assertExpectedHead(head, expected);
      const currentBytes = await this.readBytes(path);
      const currentSha = gitBlobHash(currentBytes);
      this.assertExpectedBlob(path, currentSha, expected);
      const content = await mutate({ head, current: currentBytes.toString("utf8"), currentSha });
      if (content === null) return null;
      const written = await this.writeBytesUnlocked(full, Buffer.from(content, "utf8"));
      return { path, content, sha: written.content?.sha ?? gitBlobHash(Buffer.from(content, "utf8")), head };
    }));
  }

  async commitPathIfUnchanged(message: string, path: string, expected: LocalExpectedFileState): Promise<string | null> {
    const full = this.abs(path);
    return this.withGitMutation(() => this.withPathMutation(full, async () => {
      const head = await this.getSuggestingHeadFile(path);
      this.assertExpectedHead(head, expected);
      const meta = await this.getFileMeta("", "", "WORKTREE", path);
      this.assertExpectedBlob(path, meta?.sha ?? null, expected);
      return await this.commitPathsUnlocked(message, [path]);
    }));
  }

  private async requireCurrentSha(
    filepath: string,
    sha: string | undefined,
    opts: { mustExist?: boolean } = {},
  ): Promise<void> {
    const current = await this.getFileMeta("", "", "WORKTREE", filepath);
    if (!current) {
      if (opts.mustExist) {
        throw new WorkspaceBackendError(404, "not_found", `not found: ${filepath}`);
      }
      if (sha) {
        throw new WorkspaceBackendError(409, "stale_sha", `stale sha for ${filepath}`);
      }
      return;
    }
    if (!sha || current.sha !== sha) {
      throw new WorkspaceBackendError(409, "stale_sha", `stale sha for ${filepath}`);
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

  async readFile(_owner: string, _repo: string, _ref: string, filepath: string): Promise<WsFileRead | null> {
    try {
      const bytes = await this.readBytes(filepath);
      return { sha: gitBlobHash(bytes), size: bytes.length, content: bytes.toString("utf8") };
    } catch (err) {
      if (err instanceof WorkspaceBackendError && err.status === 404) return null;
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
    return this.withPathMutation(full, async () => {
      await this.requireCurrentSha(opts.path, opts.sha);
      // Write to a temp sibling then rename so a reader never sees a half-written
      // file. The temp name is derived from the content hash (no Math.random,
      // which is unavailable in some sandboxes and irrelevant here).
      return await this.writeBytesUnlocked(full, opts.content);
    });
  }

  async deleteFile(_owner: string, _repo: string, opts: WsDeleteFile): Promise<void> {
    const full = this.abs(opts.path);
    return this.withPathMutation(full, async () => {
      await this.assertRealParentInside(full);
      await this.requireCurrentSha(opts.path, opts.sha, { mustExist: true });
      try {
        await rm(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new WorkspaceBackendError(404, "not_found", `not found: ${opts.path}`);
        }
        throw err;
      }
    });
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

  // No pull requests locally: the review/merge surface is the connected Core
  // Server (Tier 2), reached through OriginCollaborationClient, not this backend.
  async listPulls(_owner: string, _repo: string, _state: "open" | "closed" | "all", _opts: { limit?: number } = {}): Promise<WsPull[]> {
    return [];
  }

  // Resolve a commit from the working tree's git history (the commit-detail page).
  // Returns null when the folder is not a git repo or the sha is unknown locally
  // — e.g. a core-side commit linked from the activity feed that was never fetched
  // into this clone — so the page degrades to a clear "not available" state rather
  // than 500ing. `author_login` is absent: a local commit has no forge identity.
  async getCommit(_owner: string, _repo: string, sha: string): Promise<WsCommit | null> {
    if (!isCommitSha(sha)) return null;
    if (!(await this.isGitRepo())) return null;
    let out: string;
    try {
      // NUL-separated fields so a commit message with newlines stays intact in
      // the trailing %B body.
      out = await this.git(["show", "-s", "--format=%H%x00%an%x00%aI%x00%B", sha, "--"]);
    } catch (_err) {
      return null;
    }
    const parts = out.split("\0");
    const fullSha = parts[0]?.trim();
    if (!fullSha) return null;
    return {
      sha: fullSha,
      message: parts.slice(3).join("\0"),
      author_name: parts[1] || undefined,
      date: parts[2] || undefined,
    };
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

  private async gitWithLiteralPathspecs(args: string[]): Promise<string> {
    const { stdout } = await execFileP("git", ["-C", this.root, "--literal-pathspecs", ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async gitPrefix(): Promise<string> {
    this.gitPrefixValue ??= (await this.git(["rev-parse", "--show-prefix"]).catch(() => "")).trim();
    return this.gitPrefixValue;
  }

  private stripGitPrefix(path: string, prefix: string): string {
    return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }

  private gitLiteralPaths(paths: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (!path || path.startsWith("-") || path.startsWith(":") || path.includes("\0")) {
        throw new WorkspaceBackendError(400, "invalid_path", `invalid git path: ${path}`);
      }
      this.abs(path);
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
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
    const prefix = await this.gitPrefix();
    const out = await this.gitWithLiteralPathspecs(["status", "--porcelain=v1", "--", "."]);
    const entries = out
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => {
        const code = line.slice(0, 2);
        const rest = line.slice(3).trim();
        // Renamed/copied entries are "old -> new"; show the new path.
        const arrow = rest.indexOf(" -> ");
        const path = arrow === -1 ? rest : rest.slice(arrow + 4);
        return { code, path: this.stripGitPrefix(path, prefix) };
      });
    return { branch, entries };
  }

  async diffForPaths(baseSha: string | null, paths: string[]): Promise<LocalFileDiff[]> {
    if (!(await this.isGitRepo())) return [];
    const safePaths = this.gitLiteralPaths(paths);
    if (safePaths.length === 0) return [];
    const base = baseSha && isCommitSha(baseSha) ? baseSha : "HEAD";
    const prefix = await this.gitPrefix();
    const out = await this.gitWithLiteralPathspecs(["diff", "--no-ext-diff", "--find-renames", base, "--", ...safePaths]);
    const patches = splitUnifiedDiff(out).map((patch) => ({
      ...patch,
      path: this.stripGitPrefix(patch.path, prefix),
      ...(patch.previous_path ? { previous_path: this.stripGitPrefix(patch.previous_path, prefix) } : {}),
    }));
    const byPath = new Map(patches.map((patch) => [patch.path, this.withReviewHash({ ...patch, changed: true })]));
    const unresolvedPaths = safePaths.filter((path) => !byPath.has(path));
    if (unresolvedPaths.length === 0) return safePaths.map((path) => byPath.get(path) ?? this.withReviewHash({ path, patch: "", changed: false }));
    const status = await this.gitWithLiteralPathspecs(["status", "--porcelain=v1", "--", ...unresolvedPaths]);
    const untracked = new Set(
      status
        .split("\n")
        .filter((line) => line.startsWith("?? "))
        .map((line) => this.stripGitPrefix(line.slice(3).trim(), prefix)),
    );
    for (const path of unresolvedPaths) {
      if (byPath.has(path)) continue;
      if (untracked.has(path)) {
        byPath.set(path, {
          path,
          patch: await this.untrackedPatch(path),
          changed: true,
          review_hash: "",
        });
        const diff = byPath.get(path);
        if (diff) byPath.set(path, this.withReviewHash(diff));
      } else {
        byPath.set(path, this.withReviewHash({ path, patch: "", changed: false }));
      }
    }
    return safePaths.map((path) => byPath.get(path) ?? this.withReviewHash({ path, patch: "", changed: false }));
  }

  async getHeadFile(path: string): Promise<LocalHeadFile> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    const [safePath] = this.gitLiteralPaths([path]);
    if (!safePath) throw new WorkspaceBackendError(400, "invalid_path", `invalid git path: ${path}`);
    const prefix = await this.gitPrefix();
    const headSha = await this.currentHeadSha();
    if (!headSha) throw new WorkspaceBackendError(404, "not_found", "HEAD not found");
    try {
      const content = await this.git(["show", `HEAD:${prefix}${safePath}`]);
      return { path: safePath, content, head_sha: headSha };
    } catch (_err) {
      throw new WorkspaceBackendError(404, "not_found", `not found at HEAD: ${safePath}`);
    }
  }

  private withReviewHash(diff: Omit<LocalFileDiff, "review_hash"> | LocalFileDiff): LocalFileDiff {
    return {
      ...diff,
      review_hash: createHash("sha256").update(`${diff.path}\0${diff.patch}`).digest("hex"),
    };
  }

  private async untrackedPatch(path: string): Promise<string> {
    let text: string;
    try {
      const full = this.abs(path);
      const info = await lstat(full);
      if (!info.isFile()) return "";
      const bytes = await readFile(await this.realInside(full));
      text = bytes.toString("utf8");
    } catch (_err) {
      return "";
    }
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join("\n");
  }

  // Stage everything and commit. Returns the new commit sha, or null when there
  // was nothing to commit.
  async commitAll(message: string): Promise<string | null> {
    return this.withGitMutation(() => this.commitAllUnlocked(message));
  }

  private async commitAllUnlocked(message: string): Promise<string | null> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    await this.gitWithLiteralPathspecs(["add", "-A", "--", "."]);
    const status = await this.gitWithLiteralPathspecs(["status", "--porcelain=v1", "--", "."]);
    if (status.trim() === "") return null;
    await this.gitWithLiteralPathspecs([...(await this.commitIdentityArgs()), "commit", "-m", message, "--", "."]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async commitPaths(message: string, paths: string[]): Promise<string | null> {
    return this.withGitMutation(() => this.commitPathsUnlocked(message, paths));
  }

  private async commitPathsUnlocked(message: string, paths: string[]): Promise<string | null> {
    if (!(await this.isGitRepo())) throw new WorkspaceBackendError(400, "not_git", "folder is not a git repository");
    const safePaths = this.gitLiteralPaths(paths);
    if (safePaths.length === 0) return null;
    await this.gitWithLiteralPathspecs(["add", "--", ...safePaths]);
    const status = await this.gitWithLiteralPathspecs(["status", "--porcelain=v1", "--", ...safePaths]);
    if (status.trim() === "") return null;
    await this.gitWithLiteralPathspecs([...(await this.commitIdentityArgs()), "commit", "-m", message, "--only", "--", ...safePaths]);
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
