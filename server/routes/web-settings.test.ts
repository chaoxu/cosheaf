import { describe, expect, it } from "vitest";
import { mergeRepoTopics } from "./web-settings.js";

describe("mergeRepoTopics", () => {
  it("preserves the cosheaf-format-* topic across a topics edit", () => {
    // The format topic drives the workspace markdown format and must survive a
    // topics edit even though the user never sees it in the input.
    expect(mergeRepoTopics(["cosheaf-format-coflat", "math"], "notes physics")).toEqual([
      "cosheaf-format-coflat",
      "notes",
      "physics",
    ]);
  });

  it("does not let the user inject or change the format topic via the input", () => {
    expect(mergeRepoTopics(["cosheaf-format-coflat"], "cosheaf-format-forgejo-passthrough notes")).toEqual([
      "cosheaf-format-coflat",
      "notes",
    ]);
  });

  it("normalizes case and dedupes", () => {
    expect(mergeRepoTopics([], "Notes NOTES notes")).toEqual(["notes"]);
  });

  it("drops invalid topic shapes", () => {
    expect(mergeRepoTopics([], "valid-1 _bad has space @nope")).toEqual(["valid-1", "has", "space"]);
  });

  it("clears free topics when the input is empty but keeps the format topic", () => {
    expect(mergeRepoTopics(["cosheaf-format-coflat", "old"], "")).toEqual(["cosheaf-format-coflat"]);
  });

  it("returns an empty list for an untagged repo cleared to nothing", () => {
    expect(mergeRepoTopics([], "")).toEqual([]);
  });
});
