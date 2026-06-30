import { describe, expect, it } from "vitest";
import { friendlyGitError, friendlyLine } from "./git-errors.js";

describe("friendlyGitError", () => {
  it("recognizes a missing git identity and points at the Profile page", () => {
    const f = friendlyGitError("Author identity unknown\n*** Please tell me who you are.");
    expect(f.message).toMatch(/who you are/i);
    expect(f.hint).toMatch(/Profile/);
  });

  it("recognizes a non-fast-forward rejection and suggests Sync", () => {
    const f = friendlyGitError("! [rejected]        main -> main (non-fast-forward)");
    expect(f.message).toMatch(/remote has commits/i);
    expect(f.hint).toMatch(/Sync/);
  });

  it("recognizes an SSH auth failure", () => {
    expect(friendlyGitError("git@host: Permission denied (publickey).").message).toMatch(/authenticate/i);
  });

  it("recognizes a non-git folder", () => {
    expect(friendlyGitError("fatal: not a git repository").message).toMatch(/isn't a git repository/i);
  });

  it("falls back to the first non-empty line for unknown errors", () => {
    expect(friendlyGitError("fatal: something weird\n  more detail").message).toBe("fatal: something weird");
  });

  it("friendlyLine joins message and hint", () => {
    expect(friendlyLine(new Error("Author identity unknown"))).toMatch(/who you are.*Profile/i);
  });
});
