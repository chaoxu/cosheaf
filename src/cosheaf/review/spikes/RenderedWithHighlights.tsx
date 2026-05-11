import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { MarkdownEditor } from "../../editor";
import { addedHeadLines } from "../diff-lines";
import { lineTintExtension } from "../cm-line-tint";
import type { SpikeProps } from "../spike-types";

const muted = "text-[var(--cf-muted)]";

export function RenderedWithHighlights({ file, loadContent }: SpikeProps): ReactElement {
  const [head, setHead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (file.status === "deleted") {
      setHead("");
      return;
    }
    let cancelled = false;
    setHead(null);
    setError(null);
    loadContent("head")
      .then((c) => {
        if (!cancelled) setHead(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, loadContent, file.status]);

  const extensions = useMemo(() => lineTintExtension(addedHeadLines(file.patch)), [file.patch]);

  if (error) return <div className={cn("p-3 text-sm", muted)}>Failed to load: {error}</div>;
  if (head === null) return <div className={cn("p-3 text-sm", muted)}>Loading…</div>;
  if (file.status === "deleted") {
    return <div className={cn("p-3 text-sm", muted)}>(file deleted)</div>;
  }
  return (
    <div data-testid="spike-rendered-pane" className="h-full">
      <MarkdownEditor
        key={`rendered-${file.path}`}
        value={head}
        mode="rich"
        onChange={() => undefined}
        readOnly
        extensions={extensions}
      />
    </div>
  );
}
