// Spike #5: unified diff via react-diff-view. The library handles patch
// parsing, line gutters, +/-/normal styling, and exposes a `widgets` map
// keyed by change for inline thread + composer rendering.

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Diff, Hunk, getChangeKey, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { InlineComposer } from "../InlineComposer";
import { groupCommentsByLine } from "../comment-anchors";
import type { AddCommentTarget, SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function LibraryUnified({
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

  // Forgejo gives us a body-only patch; react-diff-view wants the full
  // `diff --git` header. Synthesize one when missing.
  const withHeader = file.patch.startsWith("diff --git")
    ? file.patch
    : `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${file.patch}`;
  const files = parseDiff(withHeader);
  const parsed = files[0];
  if (!parsed) return <div className={cn("p-3 text-sm", muted)}>(could not parse diff)</div>;

  const byLine = groupCommentsByLine(comments);

  // Build a widgets map keyed by change. Each entry can hold the thread,
  // the inline composer (when this change is targeted), and a "+ add"
  // affordance when nothing else is there.
  const widgets: Record<string, ReactNode> = {};
  for (const hunk of parsed.hunks) {
    for (const change of hunk.changes) {
      const c = change as {
        type: "normal" | "insert" | "delete";
        lineNumber?: number;
        newLineNumber?: number;
        oldLineNumber?: number;
      };
      const newLine =
        c.type === "insert" ? c.lineNumber : c.type === "normal" ? c.newLineNumber : undefined;
      const oldLine =
        c.type === "delete" ? c.lineNumber : c.type === "normal" ? c.oldLineNumber : undefined;
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
      const showAdd =
        onAddComment && target && !composerHere && !newThread && !oldThread;
      if (!newThread && !oldThread && !composerHere && !showAdd) continue;
      const key = getChangeKey(change);
      widgets[key] = (
        <div className="bg-[var(--cf-bg)]">
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
          {showAdd && target && (
            <div className="px-2 py-0.5">
              <button
                type="button"
                data-testid={`library-comment-add-${target.side}-${target.line}`}
                onClick={() => setComposerAt({ ...target, path: file.path })}
                className="text-[11px] text-[var(--cf-accent)] hover:underline"
              >
                + add comment
              </button>
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div data-testid="spike-library-pane" className="text-[13px] font-mono">
      <Diff viewType="unified" diffType={parsed.type} hunks={parsed.hunks} widgets={widgets}>
        {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </div>
  );
}
