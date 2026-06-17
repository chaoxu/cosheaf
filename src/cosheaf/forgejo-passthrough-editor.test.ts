import { describe, expect, it } from "vitest";
import { saveReasonCommits } from "./document-format/forgejo-passthrough-editor";

describe("forgejo passthrough editor save policy", () => {
  it("treats manual and command saves as committed", () => {
    expect(saveReasonCommits("manual")).toBe(true);
    expect(saveReasonCommits("command")).toBe(true);
  });

  it("does not treat autosave as committed", () => {
    expect(saveReasonCommits("autosave")).toBe(false);
  });
});
