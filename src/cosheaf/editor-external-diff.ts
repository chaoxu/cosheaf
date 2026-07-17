import { diffLines } from "diff";
import { splitLinesPreserveEndings } from "../../shared/line-diff";

export type EditorExternalDiffRow =
  | { kind: "equal"; key: string; bufferLine: number; latestLine: number; buffer: string; latest: string }
  | { kind: "remove"; key: string; bufferLine: number; buffer: string; bufferNote?: string }
  | { kind: "add"; key: string; latestLine: number; latest: string; latestNote?: string };

function displayLine(line: string, annotate: boolean): { text: string; note?: string } {
  const hasNewline = line.endsWith("\n");
  const stripped = line.endsWith("\n") ? line.slice(0, -1) : line;
  return {
    text: stripped || " ",
    ...(annotate && stripped === "" ? { note: "Blank line" } : {}),
    ...(annotate && stripped !== "" && !hasNewline ? { note: "No final newline" } : {}),
  };
}

export function editorExternalDiffRows(buffer: string, latest: string): EditorExternalDiffRow[] {
  const rows: EditorExternalDiffRow[] = [];
  let bufferLine = 1;
  let latestLine = 1;
  let key = 0;

  for (const change of diffLines(buffer, latest)) {
    const lines = splitLinesPreserveEndings(change.value);
    if (change.removed) {
      for (const line of lines) {
        const display = displayLine(line, true);
        rows.push({
          kind: "remove",
          key: String(key++),
          bufferLine: bufferLine++,
          buffer: display.text,
          ...(display.note ? { bufferNote: display.note } : {}),
        });
      }
      continue;
    }
    if (change.added) {
      for (const line of lines) {
        const display = displayLine(line, true);
        rows.push({
          kind: "add",
          key: String(key++),
          latestLine: latestLine++,
          latest: display.text,
          ...(display.note ? { latestNote: display.note } : {}),
        });
      }
      continue;
    }
    for (const line of lines) {
      const value = displayLine(line, false).text;
      rows.push({ kind: "equal", key: String(key++), bufferLine: bufferLine++, latestLine: latestLine++, buffer: value, latest: value });
    }
  }
  return rows;
}

export function editorExternalDiffHasVisibleChanges(rows: readonly EditorExternalDiffRow[]): boolean {
  return rows.some((row) => row.kind === "add" || row.kind === "remove");
}
