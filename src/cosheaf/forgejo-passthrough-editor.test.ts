import { describe, expect, it } from "vitest";
import {
  extractForgejoPassthroughOutline,
  saveReasonCommits,
} from "./document-format/forgejo-passthrough-editor";

describe("forgejo passthrough editor save policy", () => {
  it("treats manual and command saves as committed", () => {
    expect(saveReasonCommits("manual")).toBe(true);
    expect(saveReasonCommits("command")).toBe(true);
  });

  it("does not treat autosave as committed", () => {
    expect(saveReasonCommits("autosave")).toBe(false);
  });
});

describe("forgejo passthrough editor outline", () => {
  it("emits stable heading ids for the shared outline contract", () => {
    expect(extractForgejoPassthroughOutline([
      "# Background",
      "",
      "## Background",
      "",
      "# Méthodes & Results!",
    ].join("\n")).map((entry) => entry.id)).toEqual([
      "background",
      "background-2",
      "methodes-results",
    ]);
  });
});
