import { diffLines } from "diff";

export type SuggestingHunkKind = "insert" | "delete" | "change";

export interface SuggestingHunk {
  id: string;
  kind: SuggestingHunkKind;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
}

function countLines(value: string): number {
  if (value === "") return 0;
  return value.match(/[^\n]*\n|[^\n]+/g)?.length ?? 0;
}

function hunkKind(oldLines: number, newLines: number): SuggestingHunkKind {
  if (oldLines === 0) return "insert";
  if (newLines === 0) return "delete";
  return "change";
}

function hunkId(oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  return `${oldStart}:${oldLines}:${newStart}:${newLines}`;
}

export function splitLinesPreserveEndings(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

export function suggestingHunks(baseText: string, currentText: string): SuggestingHunk[] {
  const changes = diffLines(baseText, currentText);
  const hunks: SuggestingHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let oldStart = 0;
  let newStart = 0;
  let oldLines = 0;
  let newLines = 0;

  const flush = () => {
    if (oldLines === 0 && newLines === 0) return;
    hunks.push({
      id: hunkId(oldStart, oldLines, newStart, newLines),
      kind: hunkKind(oldLines, newLines),
      old_start: oldStart,
      old_lines: oldLines,
      new_start: newStart,
      new_lines: newLines,
    });
    oldStart = 0;
    newStart = 0;
    oldLines = 0;
    newLines = 0;
  };

  for (const change of changes) {
    const lines = change.count ?? countLines(change.value);
    if (!change.added && !change.removed) {
      flush();
      oldLine += lines;
      newLine += lines;
      continue;
    }
    if (oldLines === 0 && newLines === 0) {
      oldStart = oldLine;
      newStart = newLine;
    }
    if (change.removed) {
      oldLines += lines;
      oldLine += lines;
    }
    if (change.added) {
      newLines += lines;
      newLine += lines;
    }
  }
  flush();
  return hunks;
}

export function sameSuggestingHunk(a: SuggestingHunk, b: SuggestingHunk): boolean {
  return a.old_start === b.old_start &&
    a.old_lines === b.old_lines &&
    a.new_start === b.new_start &&
    a.new_lines === b.new_lines;
}

export function suggestingHunkFingerprint(baseText: string, currentText: string, hunk: SuggestingHunk): string {
  const baseLines = splitLinesPreserveEndings(baseText);
  const currentLines = splitLinesPreserveEndings(currentText);
  const oldStart = Math.max(0, hunk.old_start - 1);
  const newStart = Math.max(0, hunk.new_start - 1);
  const oldText = baseLines.slice(oldStart, oldStart + hunk.old_lines).join("");
  const newText = currentLines.slice(newStart, newStart + hunk.new_lines).join("");
  return `${hunk.kind}\0${oldText}\0${newText}`;
}

export function revertSuggestingHunk(baseText: string, currentText: string, hunk: SuggestingHunk): string | null {
  const fresh = suggestingHunks(baseText, currentText).find((candidate) => sameSuggestingHunk(candidate, hunk));
  if (!fresh) return null;
  const baseLines = splitLinesPreserveEndings(baseText);
  const currentLines = splitLinesPreserveEndings(currentText);
  const insertAt = Math.max(0, Math.min(currentLines.length, fresh.new_start - 1));
  const oldStart = Math.max(0, fresh.old_start - 1);
  const replacement = baseLines.slice(oldStart, oldStart + fresh.old_lines);
  currentLines.splice(insertAt, fresh.new_lines, ...replacement);
  return currentLines.join("");
}
