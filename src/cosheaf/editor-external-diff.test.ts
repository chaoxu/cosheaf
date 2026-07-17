import { describe, expect, it } from "vitest";
import { editorExternalDiffHasVisibleChanges, editorExternalDiffRows } from "./editor-external-diff";

describe("editor external diff rows", () => {
  it("uses diff package line hunks for added and removed rows", () => {
    expect(editorExternalDiffRows("a\nold\nc\n", "a\nnew\nc\n")).toEqual([
      { kind: "equal", key: "0", bufferLine: 1, latestLine: 1, buffer: "a", latest: "a" },
      { kind: "remove", key: "1", bufferLine: 2, buffer: "old" },
      { kind: "add", key: "2", latestLine: 2, latest: "new" },
      { kind: "equal", key: "3", bufferLine: 3, latestLine: 3, buffer: "c", latest: "c" },
    ]);
  });

  it("annotates EOF-newline-only changes", () => {
    expect(editorExternalDiffRows("a", "a\n")).toEqual([
      { kind: "remove", key: "0", bufferLine: 1, buffer: "a", bufferNote: "No final newline" },
      { kind: "add", key: "1", latestLine: 1, latest: "a" },
    ]);
    expect(editorExternalDiffRows("a\n", "a")).toEqual([
      { kind: "remove", key: "0", bufferLine: 1, buffer: "a" },
      { kind: "add", key: "1", latestLine: 1, latest: "a", latestNote: "No final newline" },
    ]);
  });

  it("distinguishes changed blank lines from space-only lines", () => {
    expect(editorExternalDiffRows(" \n", "\n")).toEqual([
      { kind: "remove", key: "0", bufferLine: 1, buffer: " " },
      { kind: "add", key: "1", latestLine: 1, latest: " ", latestNote: "Blank line" },
    ]);
  });

  it("distinguishes identical lines from visible changes", () => {
    expect(editorExternalDiffHasVisibleChanges(editorExternalDiffRows("a\n", "a\n"))).toBe(false);
    expect(editorExternalDiffHasVisibleChanges(editorExternalDiffRows("a", "a\n"))).toBe(true);
  });
});
