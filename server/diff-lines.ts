import { chunks } from "./diff-parse.js";

export function changedLines(patch: string): { added: Set<number>; deleted: Set<number> } {
  const added = new Set<number>();
  const deleted = new Set<number>();
  for (const chunk of chunks(patch)) {
    for (const change of chunk.changes) {
      if (change.content.startsWith("\\")) continue;
      if (change.type === "add" && change.ln !== undefined) added.add(change.ln);
      if (change.type === "del" && change.ln !== undefined) deleted.add(change.ln);
    }
  }
  return { added, deleted };
}

export function commentableLines(patch: string): { head: Set<number>; base: Set<number> } {
  const head = new Set<number>();
  const base = new Set<number>();
  for (const chunk of chunks(patch)) {
    for (const change of chunk.changes) {
      if (change.content.startsWith("\\")) continue;
      if (change.type === "add" && change.ln !== undefined) {
        head.add(change.ln);
      } else if (change.type === "del" && change.ln !== undefined) {
        base.add(change.ln);
      } else if (change.type === "normal") {
        if (change.ln1 !== undefined) base.add(change.ln1);
        if (change.ln2 !== undefined) head.add(change.ln2);
      }
    }
  }
  return { head, base };
}

export interface PatchRow {
  kind: "add" | "del" | "hunk" | "ctx";
  sign: string;
  text: string;
}

export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  for (const chunk of chunks(patch)) {
    rows.push({ kind: "hunk", sign: "@", text: chunk.content.slice(1) });
    for (const change of chunk.changes) {
      if (change.content.startsWith("\\")) continue;
      if (change.type === "add") rows.push({ kind: "add", sign: "+", text: change.content.slice(1) });
      else if (change.type === "del") rows.push({ kind: "del", sign: "-", text: change.content.slice(1) });
      else rows.push({ kind: "ctx", sign: change.content[0] ?? "", text: change.content });
    }
  }
  return rows;
}
