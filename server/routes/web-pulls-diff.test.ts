import { describe, expect, it } from "vitest";
import { raw } from "./web-html.js";
import { parseDiffMode, parseDiffShape, renderPrFileView, richDiffGapAnchors, richDiffInlineRanges, richDiffSurfaceOpts, richReviewAnchors, type WebLineComment } from "./web-pulls-diff.js";

describe("parseDiffMode", () => {
  it("defaults to rich when rich is available and no mode is given", () => {
    expect(parseDiffMode(undefined, true)).toBe("rich");
  });

  it("honors an explicit source choice", () => {
    expect(parseDiffMode("source", true)).toBe("source");
    expect(parseDiffMode("rich", true)).toBe("rich");
  });

  it("coerces to source when rich content is unavailable", () => {
    // The server is the source of truth: a stale ?mode=rich or saved preference
    // must not reach a rich surface when the route says it is unavailable.
    expect(parseDiffMode(undefined, false)).toBe("source");
    expect(parseDiffMode("rich", false)).toBe("source");
    expect(parseDiffMode("source", false)).toBe("source");
  });

  it("treats an unknown mode as the rich default when rich is available", () => {
    expect(parseDiffMode("nonsense", true)).toBe("rich");
  });
});

describe("parseDiffShape", () => {
  it("defaults to after for an unset or unknown shape", () => {
    expect(parseDiffShape(undefined, "source")).toBe("after");
    expect(parseDiffShape("nonsense", "source")).toBe("after");
  });

  it("passes through valid shapes in source mode", () => {
    expect(parseDiffShape("unified", "source")).toBe("unified");
    expect(parseDiffShape("split", "source")).toBe("split");
    expect(parseDiffShape("after", "source")).toBe("after");
  });

  it("disables the unified shape under rich mode (coerces to after)", () => {
    expect(parseDiffShape("unified", "rich")).toBe("after");
  });

  it("keeps split/after under rich mode", () => {
    expect(parseDiffShape("split", "rich")).toBe("split");
    expect(parseDiffShape("after", "rich")).toBe("after");
  });
});

describe("richReviewAnchors", () => {
  it("projects current comments on one side into rendered rich-diff anchors", () => {
    const comments: WebLineComment[] = [
      { id: 1, line: 4, side: "head", body: "tighten this", bodyHtml: "" as never, author: "ada", createdAt: 1, outdated: false },
      { id: 2, line: 8, side: "base", body: "why remove?", bodyHtml: "" as never, author: "grace", createdAt: 2, outdated: false },
      { id: 3, line: null, side: "head", body: "old", bodyHtml: "" as never, author: "alan", createdAt: 3, outdated: true },
    ];

    expect(richReviewAnchors(comments, "head")).toEqual([
      { id: 1, line: 4, side: "head", author: "ada", body: "tighten this", bodyHtml: "", outdated: false },
    ]);
  });
});

describe("richDiffSurfaceOpts", () => {
  it("passes source positions and head review anchors for rich after rendering", () => {
    const comments: WebLineComment[] = [
      { id: 1, line: 4, side: "head", body: "tighten this", bodyHtml: raw("<p>tighten this</p>"), author: "ada", createdAt: 1, outdated: false },
      { id: 2, line: 8, side: "base", body: "why remove?", bodyHtml: raw("<p>why remove?</p>"), author: "grace", createdAt: 2, outdated: false },
    ];

    expect(richDiffSurfaceOpts("feature", "note.md", new Set([4]), comments, "head")).toEqual({
      branch: "feature",
      documentPath: "note.md",
      surface: "diff",
      markedLines: [4],
      sourcePositions: true,
      reviewComments: [
        { id: 1, line: 4, side: "head", author: "ada", body: "tighten this", bodyHtml: "<p>tighten this</p>", outdated: false },
      ],
    });
  });

  it("passes rich diff navigation stops separately from highlighted lines", () => {
    expect(richDiffSurfaceOpts("feature", "note.md", new Set([4, 5, 6]), [], "head", [4])).toMatchObject({
      markedLines: [4, 5, 6],
      changeStops: [4],
    });
  });

  it("passes paired rich split gap anchors separately from highlights", () => {
    expect(richDiffSurfaceOpts("feature", "note.md", new Set([4]), [], "head", [], null, new Set(), [{ id: "rich-gap-1", line: 4, role: "content" }])).toMatchObject({
      markedLines: [4],
      richGapAnchors: [{ id: "rich-gap-1", line: 4, role: "content" }],
    });
  });

  it("passes PDF image preview paths into rich diff rendering", () => {
    expect(
      richDiffSurfaceOpts("feature", "note.md", new Set([4]), [], "head", [], null, new Set(), [], [], {
        "img/complexity.pdf": "img/complexity.png",
      }),
    ).toMatchObject({
      assetPreviewPaths: { "img/complexity.pdf": "img/complexity.png" },
    });
  });
});

describe("richDiffGapAnchors", () => {
  it("builds paired replacement anchors from the same row model as source split", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,5 +1,5 @@",
      " one",
      "-old first",
      "-old second",
      "+new first",
      "+new second",
      "+added only",
      " same",
      "-deleted only",
      " done",
    ].join("\n");

    expect(richDiffGapAnchors(patch)).toEqual({
      base: [
        { id: "rich-gap-1", line: 2, role: "content" },
        { id: "rich-gap-1-before", line: 2, role: "gap", placement: "before" },
        { id: "rich-gap-1-after", line: 2, role: "gap", placement: "after" },
        { id: "rich-gap-2", line: 3, role: "content" },
        { id: "rich-gap-2-before", line: 3, role: "gap", placement: "before" },
        { id: "rich-gap-2-after", line: 3, role: "gap", placement: "after" },
        { id: "rich-gap-3-missing", line: 3, role: "gap", placement: "after" },
        { id: "rich-gap-4", line: 5, role: "content" },
      ],
      head: [
        { id: "rich-gap-1", line: 2, role: "content" },
        { id: "rich-gap-1-before", line: 2, role: "gap", placement: "before" },
        { id: "rich-gap-1-after", line: 2, role: "gap", placement: "after" },
        { id: "rich-gap-2", line: 3, role: "content" },
        { id: "rich-gap-2-before", line: 3, role: "gap", placement: "before" },
        { id: "rich-gap-2-after", line: 3, role: "gap", placement: "after" },
        { id: "rich-gap-3", line: 4, role: "content" },
        { id: "rich-gap-4-missing", line: 5, role: "gap", placement: "after" },
      ],
    });
  });
});

describe("richDiffInlineRanges", () => {
  it("builds absolute source ranges from paired replacement rows", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,3 +1,3 @@",
      " Title",
      "-The quick brown fox.",
      "+The quick red fox.",
      " Tail",
    ].join("\n");
    const base = "Title\nThe quick brown fox.\nTail\n";
    const head = "Title\nThe quick red fox.\nTail\n";

    expect(richDiffInlineRanges(patch, { base, head })).toEqual({
      base: [{ from: base.indexOf("brown"), to: base.indexOf("brown") + "brown".length, kind: "del" }],
      head: [{ from: head.indexOf("red"), to: head.indexOf("red") + "red".length, kind: "add" }],
    });
  });
});

describe("renderPrFileView", () => {
  it("previews PDF pull-request files instead of rendering raw PDF bytes", async () => {
    const rendered = await renderPrFileView(
      { owner: "chao", repo: "milk" } as never,
      { base_sha: "base-sha", head_sha: "head-sha" } as never,
      { path: "img/complexity.pdf", status: "modified", additions: 1, deletions: 1, patch: "" },
      "source",
      "after",
      null,
      [],
    );

    expect(String(rendered)).toContain('data-testid="diff-pane-after"');
    expect(String(rendered)).toContain('data-testid="pr-file-pdf"');
    expect(String(rendered)).toContain("/chao/milk/raw/branch/head-sha/img/complexity.pdf");
    expect(String(rendered)).not.toContain("source-line-");
  });

  it("previews both sides of modified PDF pull-request files in split mode", async () => {
    const rendered = await renderPrFileView(
      { owner: "chao", repo: "milk" } as never,
      { base_sha: "base-sha", head_sha: "head-sha" } as never,
      { path: "img/complexity.pdf", status: "modified", additions: 1, deletions: 1, patch: "" },
      "source",
      "split",
      null,
      [],
    );

    expect(String(rendered)).toContain('data-testid="diff-pane-split"');
    expect(String(rendered)).toContain("/chao/milk/raw/branch/base-sha/img/complexity.pdf");
    expect(String(rendered)).toContain("/chao/milk/raw/branch/head-sha/img/complexity.pdf");
  });

  it("renders inline token highlights for paired source replacements", async () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,1 +1,1 @@",
      "-The quick brown fox.",
      "+The quick red fox.",
    ].join("\n");

    const rendered = await renderPrFileView(
      {} as never,
      { state: "closed" } as never,
      { path: "a.md", status: "modified", additions: 1, deletions: 1, patch },
      "source",
      "split",
      { base: "", head: "" },
      [],
    );

    expect(String(rendered)).toContain('<span class="source-inline-del">brown</span>');
    expect(String(rendered)).toContain('<span class="source-inline-add">red</span>');
  });
});
