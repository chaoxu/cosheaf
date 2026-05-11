import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function SideBySideRendered({ file, loadContent }: SpikeProps): ReactElement {
  const [base, setBase] = useState<string | null>(file.status === "added" ? "" : null);
  const [head, setHead] = useState<string | null>(file.status === "deleted" ? "" : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBase(file.status === "added" ? "" : null);
    setHead(file.status === "deleted" ? "" : null);

    const tasks: Array<Promise<void>> = [];
    if (file.status !== "added") {
      tasks.push(
        loadContent("base").then((c) => {
          if (!cancelled) setBase(c);
        }),
      );
    }
    if (file.status !== "deleted") {
      tasks.push(
        loadContent("head").then((c) => {
          if (!cancelled) setHead(c);
        }),
      );
    }
    Promise.all(tasks).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [file.path, file.status, loadContent]);

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;

  return (
    <div data-testid="spike-split-pane" className="grid grid-cols-2 h-full divide-x divide-[var(--cf-border)]">
      <Pane label="base" content={base} placeholder={file.status === "added" ? "(new file)" : "Loading…"} />
      <Pane label="head" content={head} placeholder={file.status === "deleted" ? "(deleted)" : "Loading…"} />
    </div>
  );
}

function Pane({
  label,
  content,
  placeholder,
}: {
  label: "base" | "head";
  content: string | null;
  placeholder: string;
}): ReactElement {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={cn("px-3 py-1 text-xs border-b border-[var(--cf-border)]", muted)}>{label}</div>
      <div className="flex-1 min-h-0 overflow-auto">
        {content === null ? (
          <div className={cn("p-3 text-sm", muted)}>{placeholder}</div>
        ) : content === "" && placeholder.startsWith("(") ? (
          <div className={cn("p-3 text-sm", muted)}>{placeholder}</div>
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
