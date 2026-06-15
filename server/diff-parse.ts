// Shared parse-diff tokenization for the diff utilities (diff-position,
// diff-lines). The single `as unknown as` cast over the loosely-typed parse-diff
// default export lives here so a parse-diff upgrade touches one place, and the
// ParsedChange/ParsedChunk shapes don't drift between the two consumers.

import parseDiffLib from "parse-diff";

export interface ParsedChange {
  type: "add" | "del" | "normal";
  ln1?: number; // old-side line (set on del + normal)
  ln2?: number; // new-side line (set on add + normal)
  ln?: number;
  content: string;
}

export interface ParsedChunk {
  content: string; // the hunk "@@ …" header line (diff-position ignores it)
  changes: ParsedChange[];
}

// parse-diff is loose about input — bare hunks (no `diff --git` header) parse
// fine. Returns the flat list of hunks across all files in the patch.
export function chunks(patch: string): ParsedChunk[] {
  if (!patch) return [];
  const parsed = (parseDiffLib as unknown as (s: string) => Array<{ chunks: ParsedChunk[] }>)(patch);
  return parsed.flatMap((file) => file.chunks ?? []);
}
