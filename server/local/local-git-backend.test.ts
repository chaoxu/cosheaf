import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { LocalGitWorkspaceBackend, gitBlobHash } from "./local-git-backend.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cosheaf-wb-backend-"));
}

const O = "owner";
const R = "repo";

async function existingSha(backend: LocalGitWorkspaceBackend, path: string): Promise<string> {
  const meta = await backend.getFileMeta(O, R, "main", path);
  if (!meta) throw new Error(`missing fixture file: ${path}`);
  return meta.sha;
}

describe("gitBlobHash", () => {
  it("matches `git hash-object` for the same bytes", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobHash(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("LocalGitWorkspaceBackend", () => {
  it("walks the working tree as blobs, skipping .git and .cosheaf", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "a.md"), "# A\n");
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "b.md"), "# B\n");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, ".cosheaf"));
    writeFileSync(join(dir, ".cosheaf", "db.sqlite"), "x");

    const backend = new LocalGitWorkspaceBackend(dir);
    const tree = await backend.getTree(O, R, "main", true);
    const paths = tree.map((e) => e.path).sort();
    expect(paths).toEqual(["a.md", "notes/b.md"]);
    expect(tree.every((e) => e.type === "blob")).toBe(true);
  });

  it("reads content and reports a git-blob-hash sha", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "a.md"), "hello\n");
    const backend = new LocalGitWorkspaceBackend(dir);
    expect(await backend.getRawFile(O, R, "main", "a.md")).toBe("hello\n");
    const meta = await backend.getFileMeta(O, R, "main", "a.md");
    expect(meta).toEqual({ sha: "ce013625030ba8dba906f756967f9e9ca394464a", size: 6 });
  });

  it("writes to disk and returns a self-consistent sha", async () => {
    const dir = tmpRepo();
    const backend = new LocalGitWorkspaceBackend(dir);
    const written = await backend.putFile(O, R, { branch: "ignored", path: "deep/new.md", content: "# New\n", message: "m" });
    expect(readFileSync(join(dir, "deep", "new.md"), "utf8")).toBe("# New\n");
    const meta = await backend.getFileMeta(O, R, "main", "deep/new.md");
    expect(written.content?.sha).toBe(meta?.sha);
  });

  it("returns null meta for a missing file and 404 on raw read", async () => {
    const dir = tmpRepo();
    const backend = new LocalGitWorkspaceBackend(dir);
    expect(await backend.getFileMeta(O, R, "main", "missing.md")).toBeNull();
    await expect(backend.getRawFile(O, R, "main", "missing.md")).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes a file and then reports it missing", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "gone.md"), "x");
    const backend = new LocalGitWorkspaceBackend(dir);
    await backend.deleteFile(O, R, { branch: "main", path: "gone.md", sha: await existingSha(backend, "gone.md"), message: "m" });
    expect(await backend.getFileMeta(O, R, "main", "gone.md")).toBeNull();
  });

  it("rejects stale writes and leaves the current file untouched", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "a.md"), "first\n");
    const backend = new LocalGitWorkspaceBackend(dir);
    const stale = await existingSha(backend, "a.md");
    writeFileSync(join(dir, "a.md"), "second\n");

    await expect(
      backend.putFile(O, R, { branch: "main", path: "a.md", content: "third\n", message: "m", sha: stale }),
    ).rejects.toMatchObject({ code: "stale_sha" });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("second\n");
  });

  it("rejects blind overwrites of existing files", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "a.md"), "first\n");
    const backend = new LocalGitWorkspaceBackend(dir);

    await expect(
      backend.putFile(O, R, { branch: "main", path: "a.md", content: "second\n", message: "m" }),
    ).rejects.toMatchObject({ code: "stale_sha" });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("first\n");
  });

  it("rejects stale binary writes", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "image.bin"), Buffer.from([1, 2, 3]));
    const backend = new LocalGitWorkspaceBackend(dir);
    const stale = await existingSha(backend, "image.bin");
    writeFileSync(join(dir, "image.bin"), Buffer.from([4, 5, 6]));

    await expect(
      backend.putFileBytes(O, R, { branch: "main", path: "image.bin", content: Buffer.from([7]), message: "m", sha: stale }),
    ).rejects.toMatchObject({ code: "stale_sha" });
    expect(readFileSync(join(dir, "image.bin"))).toEqual(Buffer.from([4, 5, 6]));
  });

  it("rejects stale deletes and leaves the file in place", async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, "gone.md"), "first\n");
    const backend = new LocalGitWorkspaceBackend(dir);
    const stale = await existingSha(backend, "gone.md");
    writeFileSync(join(dir, "gone.md"), "second\n");

    await expect(
      backend.deleteFile(O, R, { branch: "main", path: "gone.md", sha: stale, message: "m" }),
    ).rejects.toMatchObject({ code: "stale_sha" });
    expect(readFileSync(join(dir, "gone.md"), "utf8")).toBe("second\n");
  });

  it("treats any branch name as existing (no branch forking) and lists main", async () => {
    const dir = tmpRepo();
    const backend = new LocalGitWorkspaceBackend(dir);
    expect(await backend.getBranch(O, R, "anything")).toMatchObject({ name: "anything" });
    expect((await backend.listBranches(O, R)).map((b) => b.name)).toEqual(["main"]);
    expect(await backend.listPulls(O, R, "all")).toEqual([]);
  });

  it("rejects a path escaping the workspace root", async () => {
    const dir = tmpRepo();
    const backend = new LocalGitWorkspaceBackend(dir);
    await expect(backend.getFileMeta(O, R, "main", "../escape.md")).rejects.toBeInstanceOf(WorkspaceBackendError);
  });

  it("does not read through a symlink that escapes the workspace", async () => {
    const dir = tmpRepo();
    const outside = mkdtempSync(join(tmpdir(), "cosheaf-wb-outside-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.md"));
    const backend = new LocalGitWorkspaceBackend(dir);
    await expect(backend.getRawFile(O, R, "main", "link.md")).rejects.toMatchObject({ code: "not_found" });
    expect(await backend.getFileMeta(O, R, "main", "link.md")).toBeNull();
    // The link is also not listed in the tree.
    expect((await backend.getTree(O, R, "main")).map((e) => e.path)).not.toContain("link.md");
  });

  it("does not render untracked symlink targets in local diffs", async () => {
    const dir = gitRepo({ identity: true });
    writeFileSync(join(dir, "tracked.md"), "# Tracked\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    const outside = mkdtempSync(join(tmpdir(), "cosheaf-wb-outside-"));
    writeFileSync(join(outside, "secret.md"), "private-secret\n");
    symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"));

    const backend = new LocalGitWorkspaceBackend(dir);
    const [diff] = await backend.diffForPaths(null, ["leak.md"]);
    expect(diff).toMatchObject({ path: "leak.md", changed: true, patch: "" });
    expect(diff?.patch).not.toContain("private-secret");
  });

  it("rejects git pathspec magic before diffing or committing paths", async () => {
    const dir = gitRepo({ identity: true });
    writeFileSync(join(dir, "root.md"), "# Root\n");
    mkdirSync(join(dir, "paper"));
    writeFileSync(join(dir, "paper", "paper.md"), "# Paper\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    writeFileSync(join(dir, "root.md"), "# Root\n\nEscaped edit.\n");

    const backend = new LocalGitWorkspaceBackend(join(dir, "paper"));
    await expect(backend.diffForPaths(null, [":(top)root.md"])).rejects.toMatchObject({ code: "invalid_path" });
    await expect(backend.commitPaths("escape", [":(top)root.md"])).rejects.toMatchObject({ code: "invalid_path" });
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("M root.md");
  });

  it("treats glob-like touched files as literal paths", async () => {
    const dir = gitRepo({ identity: true });
    writeFileSync(join(dir, "*.md"), "# Literal star\n");
    writeFileSync(join(dir, "other.md"), "# Other\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    writeFileSync(join(dir, "*.md"), "# Literal star\n\nAccepted.\n");
    writeFileSync(join(dir, "other.md"), "# Other\n\nMust stay uncommitted.\n");

    const backend = new LocalGitWorkspaceBackend(dir);
    const diffs = await backend.diffForPaths(null, ["*.md"]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "*.md", changed: true });
    expect(diffs[0]?.patch).toContain("Accepted.");
    expect(diffs[0]?.patch).not.toContain("Must stay uncommitted.");

    const sha = await backend.commitPaths("literal star only", ["*.md"]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("*.md");
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("M other.md");
  });

  it("scopes status and commitAll to the opened Workbench subdirectory", async () => {
    const dir = gitRepo({ identity: true });
    mkdirSync(join(dir, "paper"));
    writeFileSync(join(dir, "root.md"), "# Root\n");
    writeFileSync(join(dir, "paper", "paper.md"), "# Paper\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    writeFileSync(join(dir, "root.md"), "# Root\n\nOutside edit.\n");
    writeFileSync(join(dir, "paper", "paper.md"), "# Paper\n\nInside edit.\n");

    const backend = new LocalGitWorkspaceBackend(join(dir, "paper"));
    expect(await backend.gitStatus()).toMatchObject({ entries: [{ code: " M", path: "paper.md" }] });
    const sha = await backend.commitAll("commit workbench root only");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("paper/paper.md");
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("M root.md");
  });

  it("does not write or delete through a symlinked directory that escapes the workspace", async () => {
    const dir = tmpRepo();
    const outside = mkdtempSync(join(tmpdir(), "cosheaf-wb-outside-"));
    // `sub` inside the workspace is a symlink to a directory outside it.
    symlinkSync(outside, join(dir, "sub"));
    const backend = new LocalGitWorkspaceBackend(dir);
    await expect(
      backend.putFile(O, R, { branch: "main", path: "sub/pwned.md", content: "x", message: "m" }),
    ).rejects.toBeInstanceOf(WorkspaceBackendError);
    expect(existsSync(join(outside, "pwned.md"))).toBe(false);
    // Delete through the symlinked directory is likewise refused.
    writeFileSync(join(outside, "victim.md"), "keep");
    await expect(
      backend.deleteFile(O, R, { branch: "main", path: "sub/victim.md", sha: "x", message: "m" }),
    ).rejects.toBeInstanceOf(WorkspaceBackendError);
    expect(existsSync(join(outside, "victim.md"))).toBe(true);
  });

  it("writes the working tree regardless of the requested branch, and reports the checked-out branch (Tier 1)", async () => {
    const dir = tmpRepo();
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "T"]);
    writeFileSync(join(dir, "a.md"), "x");
    git(["add", "-A"]);
    git(["commit", "-qm", "i"]);
    git(["checkout", "-q", "-b", "feature"]);
    const backend = new LocalGitWorkspaceBackend(dir);
    // The working tree is the single source: a write with any branch label lands
    // on the checked-out tree — the work is always on the current branch.
    await expect(
      backend.putFile(O, R, {
        branch: "main",
        path: "a.md",
        content: "y",
        message: "m",
        sha: await existingSha(backend, "a.md"),
      }),
    ).resolves.toMatchObject({ content: { sha: expect.any(String) } });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("y");
    // getRepo reports the checked-out branch as the default, so the UI routes there.
    expect((await backend.getRepo(O, R))?.default_branch).toBe("feature");
  });
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function gitRepo(opts: { identity?: boolean } = {}): string {
  const dir = tmpRepo();
  git(dir, ["init", "-q", "-b", "main"]);
  if (opts.identity) {
    git(dir, ["config", "user.email", "repo@repo.test"]);
    git(dir, ["config", "user.name", "Repo"]);
  }
  return dir;
}

describe("LocalGitWorkspaceBackend git authorship (profile fallback)", () => {
  // Hermetic: hide the test machine's global/system git identity so "the repo has
  // no identity" is actually true and the profile fallback is exercised.
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  });
  afterEach(() => {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = saved.s;
  });

  it("commits with the profile author when the repo has no git identity", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.md"), "# A\n");
    const backend = new LocalGitWorkspaceBackend(dir, { author: () => ({ name: "Ada", email: "ada@x.test" }) });
    const sha = await backend.commitAll("first");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, ["log", "-1", "--format=%an <%ae>"]).trim()).toBe("Ada <ada@x.test>");
  });

  it("fails to commit when there is neither a repo identity nor a profile", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.md"), "# A\n");
    const backend = new LocalGitWorkspaceBackend(dir);
    await expect(backend.commitAll("x")).rejects.toThrow();
  });

  it("respects the repo's own git identity over the profile", async () => {
    const dir = gitRepo({ identity: true });
    writeFileSync(join(dir, "a.md"), "# A\n");
    const backend = new LocalGitWorkspaceBackend(dir, { author: () => ({ name: "Ada", email: "ada@x.test" }) });
    await backend.commitAll("first");
    expect(git(dir, ["log", "-1", "--format=%an"]).trim()).toBe("Repo");
  });
});

describe("LocalGitWorkspaceBackend sync (Tier 2)", () => {
  it("reports no upstream for a fresh repo", async () => {
    const backend = new LocalGitWorkspaceBackend(gitRepo({ identity: true }));
    expect(await backend.hasUpstream()).toBe(false);
    expect(await backend.aheadBehind()).toEqual({ ahead: 0, behind: 0 });
  });

  it("fetches and fast-forwards the current branch on sync", async () => {
    const bare = tmpRepo();
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { stdio: "ignore" });
    const a = gitRepo({ identity: true });
    git(a, ["remote", "add", "origin", bare]);
    writeFileSync(join(a, "a.md"), "1\n");
    git(a, ["add", "-A"]);
    git(a, ["commit", "-qm", "one"]);
    git(a, ["push", "-q", "-u", "origin", "main"]);
    // A second clone advances the remote by one commit.
    const b = tmpRepo();
    git(b, ["clone", "-q", bare, "."]);
    git(b, ["config", "user.email", "b@b.test"]);
    git(b, ["config", "user.name", "B"]);
    writeFileSync(join(b, "b.md"), "2\n");
    git(b, ["add", "-A"]);
    git(b, ["commit", "-qm", "two"]);
    git(b, ["push", "-q", "origin", "main"]);

    const backend = new LocalGitWorkspaceBackend(a);
    expect(await backend.hasUpstream()).toBe(true);
    const result = await backend.sync();
    expect(result.fastForwarded).toBe(true);
    expect(result.behind).toBe(1);
    expect(readFileSync(join(a, "b.md"), "utf8")).toBe("2\n");
  });
});
