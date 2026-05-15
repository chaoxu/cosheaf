// Read-only DOM rendering of a markdown source file, with optional line
// tints, inline comment threads, and a gutter "+" affordance. Used by the
// Source-mode After-only and Side-by-side views — no CodeMirror needed
// since we're never editing.

import { useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { CommentThread } from "../CommentThread";
import { InlineComposer } from "../InlineComposer";
import { groupCommentsByLine } from "../comment-anchors";
import type { AddCommentTarget } from "../spike-types";
import type { CommentSide, LineComment } from "../../api";

const muted = "text-[var(--cf-muted)]";

export interface SourceLineViewProps {
  content: string;
  addedLines: Iterable<number>;
  filePath: string;
  comments: readonly LineComment[];
  side: CommentSide;
  currentForgejoUsername?: string;
  onAddComment?: (target: AddCommentTarget, body: string) => Promise<void>;
  onEditComment?: (commentId: number, body: string) => Promise<void>;
  onDeleteComment?: (commentId: number, reviewId: number) => Promise<void>;
}

export function SourceLineView({
  content,
  addedLines,
  filePath,
  comments,
  side,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: SourceLineViewProps): ReactElement {
  const [composerAt, setComposerAt] = useState<AddCommentTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const added = new Set(addedLines);
  const lines = content.length === 0 ? [""] : content.split("\n");
  // git produces a trailing empty entry when content ends with \n; drop it.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const byLine = groupCommentsByLine(comments);
  const lineNumWidth = `${String(lines.length).length + 1}ch`;

  return (
    <div className="cf-source-view text-[12.5px] font-mono leading-[1.4]">
      {lines.map((text, i) => {
        const lineNo = i + 1;
        const isAdded = added.has(lineNo);
        const thread = byLine.get(`${side}:${lineNo}`);
        const composerHere =
          composerAt && composerAt.line === lineNo && composerAt.side === side;
        return (
          <div key={lineNo}>
            <div
              className={cn(
                "group flex items-stretch hover:bg-[var(--cf-hover)]/40",
                isAdded && "bg-green-500/[0.07]",
              )}
            >
              <div
                className={cn("shrink-0 select-none text-right pr-2 pl-2 py-px relative", muted)}
                style={{ minWidth: lineNumWidth }}
              >
                {lineNo}
                {onAddComment && (
                  <button
                    type="button"
                    data-testid={`comment-add-${side}-${lineNo}`}
                    onClick={() => setComposerAt({ path: filePath, line: lineNo, side })}
                    className="cf-source-gutter-add opacity-0 group-hover:opacity-100 focus:opacity-100"
                    title="Add comment"
                  >
                    +
                  </button>
                )}
              </div>
              <pre
                className="whitespace-pre-wrap break-words flex-1 py-px pl-1 pr-2"
                style={{ margin: 0 }}
              >
                {text || " "}
              </pre>
            </div>
            {thread && (
              <CommentThread
                comments={thread}
                currentForgejoUsername={currentForgejoUsername}
                onEdit={onEditComment}
                onDelete={onDeleteComment}
              />
            )}
            {composerHere && onAddComment && (
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
      })}
    </div>
  );
}
