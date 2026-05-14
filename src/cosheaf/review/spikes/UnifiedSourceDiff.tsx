// Unified diff via react-diff-view. The library handles patch parsing,
// gutter line numbers, +/-/normal styling; we override colors to match
// cosheaf's theme, render the "+ add comment" affordance inside the gutter
// on hover (via renderGutter), and inject comment threads + inline composer
// through the library's `widgets` map.

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Diff, Hunk, getChangeKey, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { InlineComposer } from "../InlineComposer";
import { groupCommentsByLine } from "../comment-anchors";
import type { AddCommentTarget, SpikeProps } from "../spike-types";
import "./unified.css";

const muted = "text-[var(--cf-muted)]";

interface ParsedChange {
  type: "normal" | "insert" | "delete";
  lineNumber?: number;
  newLineNumber?: number;
  oldLineNumber?: number;
}

function lineFor(change: ParsedChange): { newLine?: number; oldLine?: number } {
  if (change.type === "insert") return { newLine: change.lineNumber };
  if (change.type === "delete") return { oldLine: change.lineNumber };
  return { newLine: change.newLineNumber, oldLine: change.oldLineNumber };
}

export function UnifiedSourceDiff({
  file,
  comments,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: SpikeProps): ReactElement {
  const [composerAt, setComposerAt] = useState<AddCommentTarget | null>(null);
  const [busy, setBusy] = useState(false);

  if (!file.patch) {
    return <div className={cn("p-3 text-sm", muted)}>(no textual diff)</div>;
  }

  // Forgejo gives body-only patches; react-diff-view wants the `diff --git`
  // header. Synthesize one when missing.
  const withHeader = file.patch.startsWith("diff --git")
    ? file.patch
    : `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${file.patch}`;
  const parsed = parseDiff(withHeader)[0];
  if (!parsed) return <div className={cn("p-3 text-sm", muted)}>(could not parse diff)</div>;

  const byLine = groupCommentsByLine(comments);

  // Build a widgets map keyed by change. Each entry is a column-spanning row
  // appended right under its anchor change.
  const widgets: Record<string, ReactNode> = {};
  for (const hunk of parsed.hunks) {
    for (const change of hunk.changes) {
      const pc = change as unknown as ParsedChange;
      const { newLine, oldLine } = lineFor(pc);
      const newThread = newLine !== undefined ? byLine.get(`new:${newLine}`) : undefined;
      const oldThread = oldLine !== undefined ? byLine.get(`old:${oldLine}`) : undefined;
      const target =
        newLine !== undefined
          ? { line: newLine, side: "new" as const }
          : oldLine !== undefined
            ? { line: oldLine, side: "old" as const }
            : null;
      const composerHere =
        composerAt && target && composerAt.line === target.line && composerAt.side === target.side;
      if (!newThread && !oldThread && !composerHere) continue;
      widgets[getChangeKey(change)] = (
        <div className="bg-[var(--cf-bg)] border-t border-[var(--cf-border)]">
          {newThread && (
            <CommentThread
              comments={newThread}
              currentForgejoUsername={currentForgejoUsername}
              onEdit={onEditComment}
              onDelete={onDeleteComment}
            />
          )}
          {oldThread && (
            <CommentThread
              comments={oldThread}
              currentForgejoUsername={currentForgejoUsername}
              onEdit={onEditComment}
              onDelete={onDeleteComment}
            />
          )}
          {composerHere && composerAt && onAddComment && (
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
          )}
        </div>
      );
    }
  }

  return (
    <div data-testid="spike-unified-pane" className="cf-unified-diff text-[12.5px]">
      <Diff
        viewType="unified"
        diffType={parsed.type}
        hunks={parsed.hunks}
        widgets={widgets}
        renderGutter={({ change, renderDefault }) => {
          const c = change as unknown as ParsedChange;
          const { newLine, oldLine } = lineFor(c);
          const target =
            newLine !== undefined
              ? { line: newLine, side: "new" as const }
              : oldLine !== undefined
                ? { line: oldLine, side: "old" as const }
                : null;
          if (!onAddComment || !target) return renderDefault();
          // The button is always present in the DOM (so tests and keyboard
          // users can reach it) but visually hidden until the row is hovered.
          return (
            <span className="cf-gutter-with-add">
              {renderDefault()}
              <button
                type="button"
                data-testid={`comment-add-${target.side}-${target.line}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setComposerAt({ ...target, path: file.path });
                }}
                className="cf-gutter-add"
                title="Add comment"
              >
                +
              </button>
            </span>
          );
        }}
      >
        {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </div>
  );
}
