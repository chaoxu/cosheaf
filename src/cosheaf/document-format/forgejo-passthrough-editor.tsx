import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AutocompleteSource,
  AssetUploader,
  SaveHandler,
  StatusEvents,
} from "../editor";
import type { MountedEditor } from "./coflat-editor";

interface Props {
  value: string;
  mode: "rich" | "source";
  onChange: (value: string) => void;
  onReady?: (editor: MountedEditor) => void;
  testId?: string;
  readOnly?: boolean;
  from?: string;
  saveHandler?: SaveHandler;
  statusEvents?: StatusEvents;
  assetUploader?: AssetUploader;
  autocompleteSources?: readonly AutocompleteSource[];
}

export function MarkdownEditor({
  value,
  onChange,
  onReady,
  testId,
  readOnly,
  saveHandler,
  statusEvents,
}: Props): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [localValue, setLocalValue] = useState(value);
  const localValueRef = useRef(localValue);
  const savedValueRef = useRef(value);
  const saveHandlerRef = useRef(saveHandler);
  const statusEventsRef = useRef(statusEvents);
  const onReadyRef = useRef(onReady);
  const outlineListenersRef = useRef(new Set<(value: ReturnType<typeof extractOutline>) => void>());
  localValueRef.current = localValue;
  saveHandlerRef.current = saveHandler;
  statusEventsRef.current = statusEvents;
  onReadyRef.current = onReady;

  const outline = useMemo(
    () => ({
      get: () => extractOutline(localValueRef.current),
      subscribe: (fn: (value: ReturnType<typeof extractOutline>) => void) => {
        outlineListenersRef.current.add(fn);
        return () => {
          outlineListenersRef.current.delete(fn);
        };
      },
    }),
    [],
  );

  useEffect(() => {
    setLocalValue(value);
    localValueRef.current = value;
    savedValueRef.current = value;
    statusEventsRef.current?.onDirtyChange?.(false);
  }, [value]);

  useEffect(() => {
    async function triggerSave(reason: "manual" | "command" | "autosave" = "manual"): Promise<void> {
      const source = localValueRef.current;
      statusEventsRef.current?.onSaveStart?.();
      const result = await saveHandlerRef.current?.save({ source, reason });
      if (result?.ok) {
        savedValueRef.current = source;
        statusEventsRef.current?.onDirtyChange?.(false);
        statusEventsRef.current?.onSaveSucceeded?.();
      } else {
        statusEventsRef.current?.onSaveFailed?.({ error: result?.error ?? "no save handler" });
      }
    }
    const mounted: MountedEditor = {
      outline,
      scrollToLine(line) {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const offset = offsetForLine(localValueRef.current, line);
        textarea.focus();
        textarea.setSelectionRange(offset, offset);
      },
      triggerSave: (reason) => triggerSave(reason),
    };
    onReadyRef.current?.(mounted);
  }, [outline]);

  return (
    <textarea
      ref={textareaRef}
      data-testid={testId}
      value={localValue}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        setLocalValue(next);
        onChange(next);
        const nextOutline = extractOutline(next);
        for (const listener of outlineListenersRef.current) listener(nextOutline);
        statusEventsRef.current?.onDirtyChange?.(next !== savedValueRef.current);
      }}
      onBlur={() => {
        if (localValueRef.current !== savedValueRef.current) {
          statusEventsRef.current?.onSaveStart?.();
          void saveHandlerRef.current?.save({ source: localValueRef.current, reason: "autosave" }).then((result) => {
            if (result?.ok) {
              savedValueRef.current = localValueRef.current;
              statusEventsRef.current?.onDirtyChange?.(false);
              statusEventsRef.current?.onSaveSucceeded?.();
            } else {
              statusEventsRef.current?.onSaveFailed?.({ error: result?.error ?? "no save handler" });
            }
          });
        }
      }}
      className="cm-host min-h-0 flex-1 resize-none border-0 bg-[var(--cf-bg)] p-4 font-mono text-sm outline-none"
    />
  );
}

function extractOutline(source: string) {
  const out: Array<{ level: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number; key: string }> = [];
  const lines = source.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (!match) continue;
    out.push({
      level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6,
      text: match[2],
      line: i + 1,
      key: `${i + 1}:${match[2]}`,
    });
  }
  return out;
}

function offsetForLine(source: string, line: number): number {
  if (line <= 1) return 0;
  let currentLine = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      currentLine++;
      if (currentLine === line) return i + 1;
    }
  }
  return source.length;
}

export default MarkdownEditor;
