import { describe, expect, it } from "vitest";
import { matchSourceLines, sourceLineSimilarity } from "./source-line-matcher.js";
import type { SourceSplitCell } from "./source-split-rows.js";

const del = (line: number, text: string): SourceSplitCell => ({ side: "base", line, text, kind: "del" });
const add = (line: number, text: string): SourceSplitCell => ({ side: "head", line, text, kind: "add" });

describe("matchSourceLines", () => {
  it("keeps a single deleted and added line paired as a replacement", () => {
    expect(matchSourceLines([del(10, "Old heading")], [add(12, "New heading")])).toEqual([
      { base: del(10, "Old heading"), head: add(12, "New heading") },
    ]);
  });

  it("skips unrelated rows to match the better later line", () => {
    const base = [
      del(80, "unrelated deleted setup"),
      del(81, "The bound follows from Lemma 4 and [@smith2024]."),
    ];
    const head = [
      add(96, "new setup paragraph"),
      add(97, "The bound follows from Lemma 5 and [@jones2025]."),
    ];

    expect(matchSourceLines(base, head)).toEqual([
      { base: base[0], head: null },
      { base: null, head: head[0] },
      { base: base[1], head: head[1] },
    ]);
  });

  it("prefers nearby matches unless a later line is materially better", () => {
    const base = [
      del(2, "old first"),
      del(3, "old second"),
    ];
    const head = [
      add(2, "new first"),
      add(3, "new second"),
      add(4, "added only"),
    ];

    expect(matchSourceLines(base, head)).toEqual([
      { base: base[0], head: head[0] },
      { base: base[1], head: head[1] },
      { base: null, head: head[2] },
    ]);
  });
});

describe("sourceLineSimilarity", () => {
  it("scores citation-like replacements higher than unrelated text", () => {
    expect(sourceLineSimilarity("See [@smith2024] for the proof.", "See [@jones2025] for the proof.")).toBeGreaterThan(0.45);
    expect(sourceLineSimilarity("K-armed bandits with offline data", "Resolve the following problem.")).toBeLessThan(0.45);
  });

  it("handles Chinese text through the shared diff tokenizer", () => {
    expect(sourceLineSimilarity("我喜欢苹果", "我喜欢香蕉")).toBeGreaterThan(0.45);
  });
});
