// Splits a unified diff (the output of `git diff`) into per-file patches.
// Each output entry is the slice of the unified diff starting at one
// `diff --git ...` header and ending just before the next.

export function splitUnifiedDiff(unified: string): Array<{ path: string; previous_path?: string; patch: string }> {
  if (!unified) return [];
  const lines = unified.split("\n");

  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) headerIdx.push(i);
  }
  if (headerIdx.length === 0) return [];
  headerIdx.push(lines.length);

  const out: Array<{ path: string; previous_path?: string; patch: string }> = [];
  for (let h = 0; h < headerIdx.length - 1; h++) {
    const start = headerIdx[h];
    const end = headerIdx[h + 1];
    const slice = lines.slice(start, end);
    const trailingBlank = slice.length > 0 && slice[slice.length - 1] === "" ? 1 : 0;
    const patch = slice.slice(0, slice.length - trailingBlank).join("\n");

    const { path, previous_path } = parsePaths(slice);
    if (!path) continue;
    out.push(previous_path ? { path, previous_path, patch } : { path, patch });
  }
  return out;
}

function parsePaths(slice: string[]): { path: string; previous_path?: string } {
  let aPath: string | undefined;
  let bPath: string | undefined;

  for (const line of slice) {
    if (line.startsWith("--- ")) {
      aPath = stripPrefix(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      bPath = stripPrefix(line.slice(4));
      break;
    }
  }
  if (bPath && bPath !== "/dev/null") {
    const previous = aPath && aPath !== "/dev/null" && aPath !== bPath ? aPath : undefined;
    return previous ? { path: bPath, previous_path: previous } : { path: bPath };
  }
  if (aPath && aPath !== "/dev/null") return { path: aPath };

  // Fallback: parse the `diff --git a/X b/Y` header itself (e.g. for binary diffs).
  const header = slice[0];
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (match) {
    const previous = match[1] !== match[2] ? match[1] : undefined;
    return previous ? { path: match[2], previous_path: previous } : { path: match[2] };
  }
  return { path: "" };
}

function stripPrefix(s: string): string {
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}
