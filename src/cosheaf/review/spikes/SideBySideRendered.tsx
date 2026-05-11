import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { useFileSide } from "../use-file-side";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({ file, loadContent }: SpikeProps): ReactElement {
  const base = useFileSide(loadContent, "base", file.status !== "added", file.path);
  const head = useFileSide(loadContent, "head", file.status !== "deleted", file.path);
  const error = base.error ?? head.error;

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  return (
    <div data-testid="spike-split-pane" className="grid grid-cols-2 h-full divide-x divide-[var(--cf-border)]">
      <Pane label="base" content={base.content} emptyLabel={file.status === "added" ? "(new file)" : null} />
      <Pane label="head" content={head.content} emptyLabel={file.status === "deleted" ? "(deleted)" : null} />
    </div>
  );
}

function Pane({
  label,
  content,
  emptyLabel,
}: {
  label: "base" | "head";
  content: string | null;
  emptyLabel: string | null;
}): ReactElement {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn("px-3 py-1 text-xs border-b border-[var(--cf-border)]", muted)}>{label}</div>
      <div className="flex-1 min-h-0 overflow-auto">
        {emptyLabel ? (
          <div className={cn("p-3 text-sm", muted)}>{emptyLabel}</div>
        ) : content === null ? (
          <div className={cn("p-3 text-sm", muted)}>Loading…</div>
        ) : (
          <MarkdownEditor
            key={`${label}-${content.length}`}
            value={content}
            mode="rich"
            onChange={() => undefined}
            readOnly
          />
        )}
      </div>
    </div>
  );
}
