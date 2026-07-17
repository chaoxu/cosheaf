import { describe, expect, it } from "vitest";
import {
  buildReferenceCompletionResult,
  REFERENCE_QUERY_RE,
  referenceSuggestionToCompletion,
} from "./reference-suggest-completions";

describe("referenceSuggestionToCompletion", () => {
  it("maps a page suggestion to a completion that inserts the ref and labels by id", () => {
    const completion = referenceSuggestionToCompletion({
      id: "intro",
      insert: "[@intro]",
      display: "Introduction",
    });
    expect(completion).toEqual({ label: "intro", apply: "[@intro]", type: "reference", detail: "Introduction" });
  });

  it("strips a leading 'id — ' from the xref display so detail does not repeat the label", () => {
    const completion = referenceSuggestionToCompletion({
      id: "eq:main",
      insert: "[@eq:main]",
      display: "eq:main — Main equation (paper.md)",
    });
    expect(completion.detail).toBe("Main equation (paper.md)");
    expect(completion.label).toBe("eq:main");
  });

  it("omits detail when the display is empty or equals the id", () => {
    expect(referenceSuggestionToCompletion({ id: "x", insert: "[@x]", display: "x" }).detail).toBeUndefined();
    expect(referenceSuggestionToCompletion({ id: "x", insert: "[@x]", display: "" }).detail).toBeUndefined();
  });
});

describe("buildReferenceCompletionResult", () => {
  it("returns the result at the native popup range so CM6 merges into one popup", () => {
    const result = buildReferenceCompletionResult(3, 8, [
      { id: "a", insert: "[@a]", display: "Alpha" },
      { id: "b", insert: "[@b]", display: "Beta" },
    ]);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(3);
    expect(result?.to).toBe(8);
    expect(result?.options.map((o) => o.label)).toEqual(["a", "b"]);
    expect(result?.validFor).toBe(REFERENCE_QUERY_RE);
  });

  it("deduplicates by id, keeping the first occurrence", () => {
    const result = buildReferenceCompletionResult(0, 2, [
      { id: "dup", insert: "[@dup]", display: "Page" },
      { id: "dup", insert: "[@dup]", display: "dup — Xref target (a.md)" },
      { id: "keep", insert: "[@keep]", display: "Keep" },
    ]);
    expect(result?.options.map((o) => o.label)).toEqual(["dup", "keep"]);
    expect(result?.options[0].detail).toBe("Page");
  });

  it("returns null when there are no usable suggestions", () => {
    expect(buildReferenceCompletionResult(0, 1, [])).toBeNull();
    expect(buildReferenceCompletionResult(0, 1, [{ id: "", insert: "[@]", display: "" }])).toBeNull();
  });

  it("REFERENCE_QUERY_RE matches partial reference ids but not whitespace", () => {
    expect(REFERENCE_QUERY_RE.test("eq:main-2")).toBe(true);
    expect(REFERENCE_QUERY_RE.test("a/b.c")).toBe(true);
    expect(REFERENCE_QUERY_RE.test("has space")).toBe(false);
  });
});
