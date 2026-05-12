import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { groupCommentsByLine, type LineKey } from "../comment-anchors";
import type { LineComment } from "../../api";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function UnifiedSourceDiff({ file, comments }: SpikeProps): ReactElement {
  if (!file.patch) {
    return <div className={cn("p-3 text-sm", muted)}>(no textual diff — binary or empty)</div>;
  }
  const rows = renderRows(file.patch);
  const byLine = groupCommentsByLine(comments);
  const orphanOutdated = comments.filter((c) => c.outdated && c.line === null);

  return (
    <div data-testid="spike-unified-pane" className="text-[13px] font-mono leading-5">
      {rows.map((r, i) => (
        <RowWithThread key={i} row={r} byLine={byLine} />
      ))}
      {orphanOutdated.length > 0 && (
        <div className="px-3 pt-3">
          <div className={cn("text-xs mb-1", muted)}>Outdated comments (anchored lines no longer in diff):</div>
          <CommentThread comments={orphanOutdated} />
        </div>
      )}
    </div>
  );
}

function RowWithThread({ row, byLine }: { row: Row; byLine: Map<LineKey, LineComment[]> }): ReactElement {
  if (row.kind === "hunk") {
    return <div className={cn("px-3 py-1 bg-[var(--cf-hover)] text-xs", muted)}>{row.text}</div>;
  }
  const bg = row.kind === "add" ? "bg-green-500/10" : row.kind === "del" ? "bg-red-500/10" : "";
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const newSide = row.headLine !== null ? byLine.get(`new:${row.headLine}`) : undefined;
  const oldSide = row.baseLine !== null ? byLine.get(`old:${row.baseLine}`) : undefined;
  return (
    <>
      <div className={cn("flex", bg)}>
        <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none", muted)}>
          {row.baseLine ?? ""}
        </span>
        <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none", muted)}>
          {row.headLine ?? ""}
        </span>
        <span className="w-4 select-none text-center">{sign}</span>
        <span className="flex-1 whitespace-pre">{row.text}</span>
      </div>
      {newSide && <CommentThread comments={newSide} />}
      {oldSide && <CommentThread comments={oldSide} />}
    </>
  );
}

type Row =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; text: string; baseLine: number | null; headLine: number | null };

function renderRows(patch: string): Row[] {
  const out: Row[] = [];
  let baseLine = 0;
  let headLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      baseLine = Number(hunk[1]);
      headLine = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), baseLine: null, headLine });
      headLine++;
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), baseLine, headLine: null });
      baseLine++;
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      out.push({ kind: "ctx", text: content, baseLine, headLine });
      baseLine++;
      headLine++;
    }
  }
  return out;
}
