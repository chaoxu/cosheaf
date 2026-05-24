import parseDiffLib from "parse-diff";

// Produces, for each `+` (or `-`) line in a unified patch, the absolute line
// number on the new or old side respectively. Used by the tint renderer to
// know which reader blocks to highlight.

interface ParsedChange {
  type: "add" | "del" | "normal";
  ln?: number;
  content: string;
}

interface ParsedChunk {
  changes: ParsedChange[];
}

function chunks(patch: string): ParsedChunk[] {
  const withoutNoNewlineMarkers = patch
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
  const parsed = (parseDiffLib as unknown as (s: string) => Array<{ chunks: ParsedChunk[] }>)(withoutNoNewlineMarkers);
  return parsed.flatMap((file) => file.chunks ?? []);
}

export function diffLineNumbers(patch: string, kind: "added" | "removed"): number[] {
  if (!patch) return [];
  const targetType = kind === "added" ? "add" : "del";
  const out: number[] = [];
  for (const chunk of chunks(patch)) {
    for (const change of chunk.changes) {
      if (change.type === targetType && !change.content.startsWith("\\") && change.ln !== undefined) {
        out.push(change.ln);
      }
    }
  }
  return out;
}
