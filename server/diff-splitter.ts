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
      aPath = stripPrefix(gitUnquotePath(line.slice(4)));
    } else if (line.startsWith("+++ ")) {
      bPath = stripPrefix(gitUnquotePath(line.slice(4)));
      break;
    }
  }
  if (bPath && bPath !== "/dev/null") {
    const previous = aPath && aPath !== "/dev/null" && aPath !== bPath ? aPath : undefined;
    return previous ? { path: bPath, previous_path: previous } : { path: bPath };
  }
  if (aPath && aPath !== "/dev/null") return { path: aPath };

  // Fallback: parse the `diff --git a/X b/Y` header itself (e.g. for binary
  // diffs with no ---/+++ lines). Handle git's quoted form first.
  const header = slice[0];
  const quoted = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(header);
  if (quoted) {
    const a = gitUnquotePath(`"${quoted[1]}"`);
    const b = gitUnquotePath(`"${quoted[2]}"`);
    return a !== b ? { path: b, previous_path: a } : { path: b };
  }
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

// git renders a path in a `---`/`+++`/`diff --git` line one of two ways: an
// unquoted path with a trailing TAB delimiter when it merely contains spaces, or
// a double-quoted C-style string (with octal byte escapes) when it has non-ASCII
// or control characters. Forgejo's file list reports the plain UTF-8 name, so the
// patch lookup only matches if we undo git's quoting here.
function gitUnquotePath(raw: string): string {
  const s = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[i + 1];
    if (next >= "0" && next <= "7") {
      let oct = "";
      while (i + 1 < body.length && oct.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") {
        oct += body[++i];
      }
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
