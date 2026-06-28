import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { LocalGitWorkspaceBackend, gitBlobHash } from "./local-git-backend.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "cosheaf-wb-backend-"));
}

const O = "owner";
const R = "repo";

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
    await backend.deleteFile(O, R, { branch: "main", path: "gone.md", sha: "x", message: "m" });
    expect(await backend.getFileMeta(O, R, "main", "gone.md")).toBeNull();
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
});
