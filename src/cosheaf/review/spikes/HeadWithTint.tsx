import { useMemo } from "react";
import type { ReactElement } from "react";
import type { StandaloneEditorMode } from "@chaoxu/coflat-editor";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { diffLineNumbers } from "../diff-lines";
import { lineTintExtension } from "../cm-line-tint";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import { SourceLineView } from "./SourceLineView";
import "./unified.css";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

// "After only": the head version of the file with added lines tinted.
// - Source mode → plain DOM render (no CodeMirror; we're read-only).
// - Rich mode → CodeMirror + coflat for actual markdown rendering.
export function HeadWithTint({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onAddComment,
  onEditComment,
  onDeleteComment,
  mode,
}: SpikeProps & { mode: StandaloneEditorMode }): ReactElement {
  const { content, error } = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const richExtensions = useMemo(
    () => [
      ...lineTintExtension(diffLineNumbers(file.patch, "added")),
      commentThreadExtension(comments, "new", {
        currentForgejoUsername,
        onEdit: onEditComment,
        onDelete: onDeleteComment,
      }),
    ],
    [file.patch, comments, currentForgejoUsername, onEditComment, onDeleteComment],
  );

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;
  if (file.status === "deleted") return <div className={cn("p-3 text-sm", muted)}>(file deleted)</div>;
  if (content === null) return <div className={cn("p-3 text-sm", muted)}>Loading…</div>;

  if (mode === "source") {
    return (
      <div data-testid="diff-pane-after" className="h-full min-h-0 overflow-auto">
        <SourceLineView
          content={content}
          addedLines={diffLineNumbers(file.patch, "added")}
          filePath={file.path}
          comments={comments}
          side="new"
          currentForgejoUsername={currentForgejoUsername}
          onAddComment={onAddComment}
          onEditComment={onEditComment}
          onDeleteComment={onDeleteComment}
        />
      </div>
    );
  }

  return (
    <div data-testid="diff-pane-after" className="h-full min-h-0 flex flex-col">
      <MarkdownEditor
        key={`after-rich-${file.path}`}
        value={content}
        mode="rich"
        onChange={() => undefined}
        readOnly
        extensions={richExtensions}
      />
    </div>
  );
}
