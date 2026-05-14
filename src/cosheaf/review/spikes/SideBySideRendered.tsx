import { useMemo } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import type { LineComment } from "../../api";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: SpikeProps): ReactElement {
  const base = useFileSide(loadContent, "base", file.status !== "added", file.path);
  const head = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const error = base.error ?? head.error;

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  return (
    <div
      data-testid="spike-split-pane"
      // Zero out coflat's sidenote gutter so each pane's rich content fills
      // its column width.
      style={{ ["--cf-sidenote-width" as never]: "0px", ["--cf-content-max-width" as never]: "none" }}
      className="grid grid-cols-2 h-full divide-x divide-[var(--cf-border)]"
    >
      <Pane label="base" content={base.content} emptyLabel={file.status === "added" ? "(new file)" : null} comments={comments} side="old" filePath={file.path} currentForgejoUsername={currentForgejoUsername} onEditComment={onEditComment} onDeleteComment={onDeleteComment} />
      <Pane label="head" content={head.content} emptyLabel={file.status === "deleted" ? "(deleted)" : null} comments={comments} side="new" filePath={file.path} currentForgejoUsername={currentForgejoUsername} onEditComment={onEditComment} onDeleteComment={onDeleteComment} />
    </div>
  );
}

function Pane({
  label,
  content,
  emptyLabel,
  comments,
  side,
  filePath,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: {
  label: "base" | "head";
  content: string | null;
  emptyLabel: string | null;
  comments: readonly LineComment[];
  side: "new" | "old";
  filePath: string;
  currentForgejoUsername?: string;
  onEditComment?: (id: number, body: string) => Promise<void>;
  onDeleteComment?: (id: number, reviewId: number) => Promise<void>;
}): ReactElement {
  const extensions = useMemo(
    () => [commentThreadExtension(comments, side, {
      currentForgejoUsername,
      onEdit: onEditComment,
      onDelete: onDeleteComment,
    })],
    [comments, side, currentForgejoUsername, onEditComment, onDeleteComment],
  );
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn("px-3 py-1 text-xs border-b border-[var(--cf-border)]", muted)}>{label}</div>
      <div className="flex-1 min-h-0 flex flex-col">
        {emptyLabel ? (
          <div className={cn("p-3 text-sm", muted)}>{emptyLabel}</div>
        ) : content === null ? (
          <div className={cn("p-3 text-sm", muted)}>Loading…</div>
        ) : (
          <MarkdownEditor
            key={`${label}-${filePath}`}
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
