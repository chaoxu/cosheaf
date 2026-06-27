import { chunks } from "./diff-parse.js";
import type { Side } from "./diff-position.js";

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

export function changeStops(patch: string): { base: number[]; head: number[] } {
  const base: number[] = [];
  const head: number[] = [];
  for (const chunk of chunks(patch)) {
    let pending: Partial<Record<Side, number>> | null = null;
    for (const change of chunk.changes) {
      if (change.content.startsWith("\\")) continue;
      if (change.type === "normal") {
        if (pending) {
          pushStop(pending, base, head);
          pending = null;
        }
        continue;
      }
      const side = change.type === "del" ? "base" : "head";
      if (change.ln !== undefined) {
        pending ??= {};
        pending[side] ??= change.ln;
      }
    }
    if (pending) pushStop(pending, base, head);
  }
  return { base, head };
}

function pushStop(stop: Partial<Record<Side, number>>, base: number[], head: number[]): void {
  // A replacement has both a base and a head line, but it is one navigable
  // change in split view. Prefer the head side so source/rich split advance in
  // the same rhythm; pure deletions still land on the base side.
  if (stop.head !== undefined) head.push(stop.head);
  else if (stop.base !== undefined) base.push(stop.base);
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
      // Strip the leading marker like add/del do, so context lines aren't
      // indented one space more than changed lines.
      else rows.push({ kind: "ctx", sign: " ", text: change.content.slice(1) });
    }
  }
  return rows;
}
