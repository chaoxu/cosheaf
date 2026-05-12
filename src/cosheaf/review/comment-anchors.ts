// Helpers for grouping LineComment[] by their (side, line) anchor.

import type { LineComment } from "../api";

export type LineKey = `new:${number}` | `old:${number}`;

export function groupCommentsByLine(comments: readonly LineComment[]): Map<LineKey, LineComment[]> {
  const byLine = new Map<LineKey, LineComment[]>();
  for (const c of comments) {
    if (c.line === null) continue;
    const key: LineKey = `${c.side}:${c.line}`;
    const bucket = byLine.get(key);
    if (bucket) bucket.push(c);
    else byLine.set(key, [c]);
  }
  return byLine;
}
