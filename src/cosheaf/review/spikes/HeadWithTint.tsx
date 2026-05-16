// Rich "After only" view: the head version of the file rendered through
// coflat-editor in rich mode, with added lines tinted. The math-verification
// view — "does this page now read correctly as a reader will see it?".
//
// Source mode for After-only is handled separately (SourceAfterOnly.tsx),
// not via this component. This file is rich-only.

import { useMemo } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { diffLineNumbers } from "../diff-lines";
import { lineTintExtension } from "../cm-line-tint";
import { commentThreadExtension } from "../cm-comment-widgets";
import { useFileSide } from "../use-file-side";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function HeadWithTint({
  file,
  loadContent,
  comments,
  currentForgejoUsername,
  onEditComment,
  onDeleteComment,
}: SpikeProps): ReactElement {
  const { content, error } = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const extensions = useMemo(
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

  return (
    <div data-testid="diff-pane-after" className="min-h-0 flex flex-col">
      <MarkdownEditor
        key={`after-rich-${file.path}`}
        value={content}
        mode="rich"
        onChange={() => undefined}
        readOnly
        extensions={extensions}
      />
    </div>
  );
}
