import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button";

export function InlineComposer({
  onSubmit,
  onCancel,
  busy,
  testId,
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  testId?: string;
}): ReactElement {
  const [body, setBody] = useState("");
  // Programmatic focus instead of the autoFocus attribute: AT users still
  // expect focus to land here because the user just opened the composer,
  // but `autoFocus` triggers it during render (before SR landmarks settle).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  return (
    <div
      data-testid={testId ?? "inline-composer"}
      className="mx-2 my-1 p-2 border rounded border-[var(--cf-border)] bg-[var(--cf-bg)] text-[13px]"
    >
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment…"
        rows={2}
        disabled={busy}
        className="w-full resize-y rounded border border-[var(--cf-border)] bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--cf-accent)]"
      />
      <div className="flex items-center gap-2 mt-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || body.trim().length === 0}
          onClick={async () => {
            await onSubmit(body.trim());
          }}
        >
          Add comment
        </Button>
      </div>
    </div>
  );
}
