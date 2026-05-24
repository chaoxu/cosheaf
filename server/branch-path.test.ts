import { describe, expect, it } from "vitest";
import { resolveBranchPathFromNames } from "./branch-path.js";

describe("resolveBranchPathFromNames", () => {
  it("defaults an empty route tail to main", () => {
    expect(resolveBranchPathFromNames(["main"], "")).toEqual({ branch: "main", path: "" });
    expect(resolveBranchPathFromNames(["main"], "/")).toEqual({ branch: "main", path: "" });
  });

  it("resolves a branch root", () => {
    expect(resolveBranchPathFromNames(["main", "feature/docs"], "feature/docs")).toEqual({
      branch: "feature/docs",
      path: "",
    });
  });

  it("prefers the longest matching branch before treating the rest as a file path", () => {
    expect(resolveBranchPathFromNames(["feature", "feature/docs"], "feature/docs/notes/intro.md")).toEqual({
      branch: "feature/docs",
      path: "notes/intro.md",
    });
  });

  it("does not match branch name prefixes without a path boundary", () => {
    expect(resolveBranchPathFromNames(["feat"], "feature/readme.md")).toBeNull();
  });
});
