import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyWorkingTree, gitVisibleFiles } from "./lib/pinned-coflat-gate.mjs";

describe("pinned Coflat gate helpers", () => {
  it("parses Git-visible file lists", () => {
    const files = gitVisibleFiles((args) => {
      expect(args).toEqual(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      return "package.json\0scripts/new.mjs\0";
    });
    expect(files).toEqual(["package.json", "scripts/new.mjs"]);
  });

  it("copies only requested working-tree files", () => {
    const dest = mkdtempSync(join(tmpdir(), "cosheaf-copy-test-"));
    const ignoredRel = ".env.dev";
    const copiedRel = "package.json";
    copyWorkingTree(dest, [copiedRel]);
    expect(readFileSync(join(dest, copiedRel), "utf8")).toContain('"name": "cosheaf"');
    expect(existsSync(join(dest, ignoredRel))).toBe(false);
  });

  it("skips tracked files deleted from the working tree", () => {
    const dest = mkdtempSync(join(tmpdir(), "cosheaf-copy-test-"));
    copyWorkingTree(dest, ["package.json", "missing-deleted-file.md"]);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, "missing-deleted-file.md"))).toBe(false);
  });
});
