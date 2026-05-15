import { useMemo } from "react";
import type { ReactElement } from "react";
import type { StandaloneEditorMode } from "@chaoxu/coflat-editor";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import { SourceLineView } from "./SourceLineView";
import { diffLineNumbers } from "../diff-lines";
import type { LineComment } from "../../api";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
  mode,
}: SpikeProps & { mode: StandaloneEditorMode }): ReactElement {
  const base = useFileSide(loadContent, "base", file.status !== "added", file.path);
  const head = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const error = base.error ?? head.error;

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  const sharedProps = {
    file,
    comments,
    currentForgejoUsername,
    onAddComment,
    onEditComment,
    onDeleteComment,
    mode,
  };

  return (
    <div
      data-testid="diff-pane-split"
      // Zero out coflat's sidenote gutter so rich-mode panes fill their column width.
      style={{ ["--cf-sidenote-width" as never]: "0px", ["--cf-content-max-width" as never]: "none" }}
      className="grid grid-cols-2 h-full divide-x divide-[var(--cf-border)]"
    >
      <Pane
        {...sharedProps}
        label="base"
        side="old"
        content={base.content}
        emptyLabel={file.status === "added" ? "(new file)" : null}
        addedLines={[]}
      />
      <Pane
        {...sharedProps}
        label="head"
        side="new"
        content={head.content}
        emptyLabel={file.status === "deleted" ? "(deleted)" : null}
        addedLines={diffLineNumbers(file.patch, "added")}
      />
    </div>
  );
}

function Pane({
  label,
  mode,
  content,
  emptyLabel,
  comments,
  side,
  file,
  addedLines,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
}: {
  label: "base" | "head";
  mode: StandaloneEditorMode;
  content: string | null;
  emptyLabel: string | null;
  comments: readonly LineComment[];
  side: "new" | "old";
  file: SpikeProps["file"];
  addedLines: Iterable<number>;
  currentForgejoUsername?: string;
  onAddComment?: SpikeProps["onAddComment"];
  onEditComment?: SpikeProps["onEditComment"];
  onDeleteComment?: SpikeProps["onDeleteComment"];
}): ReactElement {
  const extensions = useMemo(
    () => [
      commentThreadExtension(comments, side, {
        currentForgejoUsername,
        onEdit: onEditComment,
        onDelete: onDeleteComment,
      }),
    ],
    [comments, side, currentForgejoUsername, onEditComment, onDeleteComment],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn("px-3 py-1 text-xs border-b border-[var(--cf-border)]", muted)}>
        {label}
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-auto">
        {emptyLabel ? (
          <div className={cn("p-3 text-sm", muted)}>{emptyLabel}</div>
        ) : content === null ? (
          <div className={cn("p-3 text-sm", muted)}>Loading…</div>
        ) : mode === "source" ? (
          <SourceLineView
            content={content}
            addedLines={addedLines}
            filePath={file.path}
            comments={comments}
            side={side}
            currentForgejoUsername={currentForgejoUsername}
            onAddComment={onAddComment}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        ) : (
          <MarkdownEditor
            key={`${label}-rich-${file.path}`}
            value={content}
            mode="rich"
            onChange={() => undefined}
            readOnly
            extensions={extensions}
          />
        )}
      </div>
    </div>
  );
}
