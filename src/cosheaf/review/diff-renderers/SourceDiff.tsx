// Source-mode diff renderer for all three shapes (unified, split, after only).
// Uses react-diff-view for parsing + rendering + line numbers + +/- styling;
// overlays comment threads via the library's `widgets` slot and the inline
// "+ add comment" gutter button via renderGutter. Same library, different
// `viewType` and patch payload per shape.

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Diff, Hunk, getChangeKey, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { InlineComposer } from "../InlineComposer";
import { groupCommentsByLine } from "../comment-anchors";
import type { AddCommentTarget, DiffRendererProps } from "../diff-renderer-types";
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

export function SourceDiff({
  file,
  comments,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
  viewType = "unified",
  testId,
  patchOverride,
}: DiffRendererProps & {
  viewType?: "unified" | "split";
  testId: string;
  // When set, the renderer uses this patch instead of file.patch. Used by
  // the After-only view to feed a synthesized "whole file with adds marked"
  // patch into the same renderer.
  patchOverride?: string;
}): ReactElement {
  const [composerAt, setComposerAt] = useState<AddCommentTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const rawPatch = patchOverride ?? file.patch;
  if (!rawPatch) {
    return <div className={cn("p-3 text-sm", muted)}>(no textual diff)</div>;
  }

  // Forgejo gives body-only patches; react-diff-view wants the `diff --git`
  // header. Synthesize one when missing.
  const withHeader = rawPatch.startsWith("diff --git")
    ? rawPatch
    : `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${rawPatch}`;
  const parsed = parseDiff(withHeader)[0];
  if (!parsed) return <div className={cn("p-3 text-sm", muted)}>(could not parse diff)</div>;

  const byLine = groupCommentsByLine(comments);

  const widgets: Record<string, ReactNode> = {};
  for (const hunk of parsed.hunks) {
    for (const change of hunk.changes) {
      const pc = change as unknown as ParsedChange;
      const { newLine, oldLine } = lineFor(pc);
      const newThread = newLine !== undefined ? byLine.get(`head:${newLine}`) : undefined;
      const oldThread = oldLine !== undefined ? byLine.get(`base:${oldLine}`) : undefined;
      const target =
        newLine !== undefined
          ? { line: newLine, side: "head" as const }
          : oldLine !== undefined
            ? { line: oldLine, side: "base" as const }
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
    <div data-testid={testId} className="cf-unified-diff text-[12.5px]">
      <Diff
        viewType={viewType}
        diffType={parsed.type}
        hunks={parsed.hunks}
        widgets={widgets}
        renderGutter={({ change, side, renderDefault }) => {
          // react-diff-view calls renderGutter for both gutter columns
          // (old line numbers + new line numbers); we only want one "+".
          if (side !== "new") return renderDefault();
          const c = change as unknown as ParsedChange;
          const { newLine, oldLine } = lineFor(c);
          const target =
            newLine !== undefined
              ? { line: newLine, side: "head" as const }
              : oldLine !== undefined
                ? { line: oldLine, side: "base" as const }
                : null;
          if (!onAddComment || !target) return renderDefault();
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

// Synthesize a unified-patch string that covers the whole head file: every
// line is either a context line (` `) or an addition (`+`), based on the
// addedLines set. Used by the "After only" Source view so the same library
// renders it.
export function synthesizeFullFilePatch(
  content: string,
  addedLineSet: ReadonlySet<number>,
): string {
  const lines = content.split("\n");
  // Drop trailing empty line from a final \n so the patch doesn't over-count.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  // Count context lines (= total - additions) for the hunk header. With
  // diff convention, old-side count = context-line count, new-side = total.
  let contextCount = 0;
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const isAdded = addedLineSet.has(ln);
    if (!isAdded) contextCount += 1;
    body.push((isAdded ? "+" : " ") + lines[i]);
  }
  const header = `@@ -1,${contextCount || 0} +1,${total} @@`;
  return `${header}\n${body.join("\n")}`;
}
