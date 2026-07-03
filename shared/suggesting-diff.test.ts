import { describe, expect, it } from "vitest";
import { revertSuggestingHunk, suggestingHunks } from "./suggesting-diff.js";

describe("suggesting diff hunks", () => {
  it("identifies inserted, deleted, and changed line hunks", () => {
    expect(suggestingHunks("a\n", "a\nb\n")).toEqual([
      { id: "2:0:2:1", kind: "insert", old_start: 2, old_lines: 0, new_start: 2, new_lines: 1 },
    ]);
    expect(suggestingHunks("a\nb\n", "a\n")).toEqual([
      { id: "2:1:2:0", kind: "delete", old_start: 2, old_lines: 1, new_start: 2, new_lines: 0 },
    ]);
    expect(suggestingHunks("a\nb\n", "a\nB\n")).toEqual([
      { id: "2:1:2:1", kind: "change", old_start: 2, old_lines: 1, new_start: 2, new_lines: 1 },
    ]);
  });

  it("reverts a matching hunk to the base text", () => {
    const base = "a\nb\nc\n";
    const current = "a\nB\nc\n";
    const [hunk] = suggestingHunks(base, current);
    expect(hunk).toBeDefined();
    if (!hunk) throw new Error("expected a suggesting hunk");
    expect(revertSuggestingHunk(base, current, hunk)).toBe(base);
  });

  it("returns null when the client hunk is stale", () => {
    const base = "a\nb\n";
    const current = "a\nB\n";
    const [hunk] = suggestingHunks(base, current);
    expect(hunk).toBeDefined();
    if (!hunk) throw new Error("expected a suggesting hunk");
    expect(revertSuggestingHunk(base, "a\nB\nextra\n", hunk)).toBeNull();
  });
});
