import { useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { InlineComposer } from "../InlineComposer";
import { groupCommentsByLine, type LineKey } from "../comment-anchors";
import type { LineComment } from "../../api";
import type { AddCommentTarget, SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function UnifiedSourceDiff({ file, comments, onAddComment }: SpikeProps): ReactElement {
  const [composerAt, setComposerAt] = useState<AddCommentTarget | null>(null);
  const [busy, setBusy] = useState(false);
  if (!file.patch) {
    return <div className={cn("p-3 text-sm", muted)}>(no textual diff — binary or empty)</div>;
  }
  const rows = renderRows(file.patch);
  const byLine = groupCommentsByLine(comments);
  const orphanOutdated = comments.filter((c) => c.outdated && c.line === null);

  return (
    <div data-testid="spike-unified-pane" className="text-[13px] font-mono leading-5">
      {rows.map((r, i) => (
        <RowWithThread
          key={i}
          row={r}
          byLine={byLine}
          onAddClick={onAddComment ? (t) => setComposerAt({ ...t, path: file.path }) : undefined}
          composerAt={composerAt}
          composer={
            composerAt && onAddComment ? (
              <InlineComposer
                busy={busy}
                onCancel={() => setComposerAt(null)}
                onSubmit={async (body) => {
                  setBusy(true);
                  try {
                    await onAddComment(composerAt, body);
                    setComposerAt(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ) : null
          }
        />
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

function RowWithThread({
  row,
  byLine,
  onAddClick,
  composerAt,
  composer,
}: {
  row: Row;
  byLine: Map<LineKey, LineComment[]>;
  onAddClick?: (target: { line: number; side: "new" | "old" }) => void;
  composerAt: AddCommentTarget | null;
  composer: ReactElement | null;
}): ReactElement {
  if (row.kind === "hunk") {
    return <div className={cn("px-3 py-1 bg-[var(--cf-hover)] text-xs", muted)}>{row.text}</div>;
  }
  const bg = row.kind === "add" ? "bg-green-500/10" : row.kind === "del" ? "bg-red-500/10" : "";
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const newSide = row.headLine !== null ? byLine.get(`new:${row.headLine}`) : undefined;
  const oldSide = row.baseLine !== null ? byLine.get(`old:${row.baseLine}`) : undefined;
  // Prefer commenting on the new side when both are present (added/context).
  const target =
    row.headLine !== null
      ? { line: row.headLine, side: "new" as const }
      : row.baseLine !== null
        ? { line: row.baseLine, side: "old" as const }
        : null;
  const composerForRow =
    composerAt && target && composerAt.line === target.line && composerAt.side === target.side
      ? composer
      : null;
  return (
    <>
      <div className={cn("flex group", bg)}>
        <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none", muted)}>
          {row.baseLine ?? ""}
        </span>
        <span className={cn("w-10 px-1 text-right tabular-nums text-xs select-none relative", muted)}>
          {row.headLine ?? ""}
          {onAddClick && target && (
            <button
              type="button"
              data-testid={`comment-add-${target.side}-${target.line}`}
              onClick={() => onAddClick(target)}
              className="absolute -left-2 top-0 hidden group-hover:flex w-4 h-4 items-center justify-center rounded bg-[var(--cf-accent)] text-[var(--cf-accent-fg)] text-[10px]"
              title="Add comment"
            >
              +
            </button>
          )}
        </span>
        <span className="w-4 select-none text-center">{sign}</span>
        <span className="flex-1 whitespace-pre">{row.text}</span>
      </div>
      {newSide && <CommentThread comments={newSide} />}
      {oldSide && <CommentThread comments={oldSide} />}
      {composerForRow}
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
