// Rich "After only" review view: the head version of the file rendered as
// HTML via the coflat reader, with added lines tinted and inline comment
// threads attached to the matching block elements via `data-source-line`.
// The renderer no longer hosts CodeMirror; tints and comments are pure DOM.

import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { RichDiffRender } from "../RichDiffRender";
import { diffLineNumbers } from "../diff-lines";
import { useFileSide } from "../use-file-side";
import type { DiffRendererProps } from "../diff-renderer-types";

const muted = "text-[var(--cf-muted)]";

export function HeadWithTint({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: DiffRendererProps): ReactElement {
  const { content, error } = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;
  if (file.status === "deleted") return <div className={cn("p-3 text-sm", muted)}>(file deleted)</div>;
  if (content === null) return <div className={cn("p-3 text-sm", muted)}>Loading…</div>;

  return (
    <div data-testid="diff-pane-after" className="min-h-0 flex flex-col">
      <RichDiffRender
        source={content}
        addedLines={diffLineNumbers(file.patch, "added")}
        comments={comments}
        side="head"
        actions={{ currentForgejoUsername, onEdit: onEditComment, onDelete: onDeleteComment }}
      />
    </div>
  );
}
