// Walks a unified-diff patch and produces, for each `+` line, the absolute
// head-side line number. Used by the source-tint and rendered-highlight spikes
// to know which lines in the head file are new/changed.

export function addedHeadLines(patch: string): number[] {
  if (!patch) return [];
  const out: number[] = [];
  let headLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      headLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      out.push(headLine);
      headLine++;
    } else if (raw.startsWith("-")) {
      // old-side line: head line number does not advance
    } else {
      // context line: present in both, advance head
      headLine++;
    }
  }
  return out;
}

// Same but for the old-side; useful when rendering deletions above context.
export function removedBaseLines(patch: string): number[] {
  if (!patch) return [];
  const out: number[] = [];
  let baseLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      baseLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("-")) {
      out.push(baseLine);
      baseLine++;
    } else if (raw.startsWith("+")) {
      // new-side: base line does not advance
    } else {
      baseLine++;
    }
  }
  return out;
}
