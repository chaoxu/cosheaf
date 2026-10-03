import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nestedGitEnv } from "../check-coflat-ref.mjs";
import { coflatWorkingTreeDirty } from "./pinned-coflat-gate.mjs";

it("checks the sibling's status when a hook exports another repository", () => {
  const root = mkdtempSync(join(tmpdir(), "cosheaf-hook-status-"));
  const outer = join(root, "cosheaf");
  const sibling = join(root, "coflat");
  const git = (args) => execFileSync("git", args, { env: nestedGitEnv(), stdio: "pipe" });
  try {
    git(["init", "-q", outer]);
    git(["init", "-q", sibling]);
    writeFileSync(join(outer, "outer-change"), "unrelated\n");
    const env = { ...process.env, GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, ".git/index") };
    expect(coflatWorkingTreeDirty(sibling, env)).toBe(false);
    writeFileSync(join(sibling, "sibling-change"), "candidate\n");
    expect(coflatWorkingTreeDirty(sibling, env)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
