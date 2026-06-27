import { chunks } from "./diff-parse.js";
import type { Side } from "./diff-position.js";
import { matchSourceLines } from "./source-line-matcher.js";

export interface SourceSplitCell {
  side: Side;
  line: number;
  text: string;
  kind: "ctx" | "add" | "del";
}

export type SourceSplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "pair"; base: SourceSplitCell | null; head: SourceSplitCell | null };

export function sourceSplitRows(patch: string): SourceSplitRow[] {
  const out: SourceSplitRow[] = [];
  for (const chunk of chunks(patch)) {
    out.push({ kind: "hunk", text: chunk.content });
    const changes = chunk.changes.filter((change) => !change.content.startsWith("\\"));
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.type === "normal") {
        out.push({
          kind: "pair",
          base: change.ln1 === undefined ? null : { side: "base", line: change.ln1, text: change.content.slice(1), kind: "ctx" },
          head: change.ln2 === undefined ? null : { side: "head", line: change.ln2, text: change.content.slice(1), kind: "ctx" },
        });
        continue;
      }
      if (change.type === "add") {
        out.push({
          kind: "pair",
          base: null,
          head: change.ln === undefined ? null : { side: "head", line: change.ln, text: change.content.slice(1), kind: "add" },
        });
        continue;
      }

      const deleted: SourceSplitCell[] = [];
      while (changes[i]?.type === "del") {
        const del = changes[i];
        if (del.ln !== undefined) deleted.push({ side: "base", line: del.ln, text: del.content.slice(1), kind: "del" });
        i++;
      }

      const added: SourceSplitCell[] = [];
      while (changes[i]?.type === "add") {
        const add = changes[i];
        if (add.ln !== undefined) added.push({ side: "head", line: add.ln, text: add.content.slice(1), kind: "add" });
        i++;
      }
      i--;

      out.push(...matchSourceLines(deleted, added).map((row) => ({ kind: "pair" as const, ...row })));
    }
  }
  return out;
}
