import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AutocompleteSource,
  AssetUploader,
  SaveHandler,
  StatusEvents,
} from "../editor";
import type { MountedEditor } from "./coflat";

type Outline = ReturnType<typeof extractForgejoPassthroughOutline>;
type Store<T> = {
  get(): T;
  subscribe(fn: (value: T) => void): () => void;
};

export function saveReasonCommits(reason: "manual" | "command" | "autosave"): boolean {
  return reason !== "autosave";
}

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
  const outlineListenersRef = useRef(new Set<(value: Outline) => void>());
  localValueRef.current = localValue;
  saveHandlerRef.current = saveHandler;
  statusEventsRef.current = statusEvents;
  onReadyRef.current = onReady;

  const outline = useMemo<Store<Outline>>(
    () => ({
      get: () => extractForgejoPassthroughOutline(localValueRef.current),
      subscribe: (fn: (value: Outline) => void) => {
        outlineListenersRef.current.add(fn);
        return () => {
          outlineListenersRef.current.delete(fn);
        };
      },
    }),
    [],
  );

  useEffect(() => {
    if (value === localValueRef.current) return;
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
        if (saveReasonCommits(reason)) {
          savedValueRef.current = source;
          statusEventsRef.current?.onDirtyChange?.(false);
        }
        statusEventsRef.current?.onSaveSucceeded?.();
      } else {
        statusEventsRef.current?.onSaveFailed?.({ error: result?.error ?? "no save handler" });
      }
    }
    const mounted: MountedEditor = {
      getDoc: () => localValueRef.current,
      setDoc(doc) {
        localValueRef.current = doc;
        savedValueRef.current = doc;
        setLocalValue(doc);
        for (const listener of outlineListenersRef.current) listener(extractForgejoPassthroughOutline(doc));
      },
      setContext: () => undefined,
      getMode: () => "source",
      setMode: () => undefined,
      outline,
      counts: store(() => countDocument(localValueRef.current)),
      cursorContext: store(() => ({
        line: 1,
        column: 1,
        from: 0,
        currentHeadingPath: [],
      })),
      scrollToLine(line) {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const offset = offsetForLine(localValueRef.current, line);
        textarea.focus();
        textarea.setSelectionRange(offset, offset);
      },
      scrollToPosition(from) {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(from, from);
      },
      focus: () => textareaRef.current?.focus(),
      unmount: () => undefined,
      isSaved: () => localValueRef.current === savedValueRef.current,
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
        localValueRef.current = next;
        setLocalValue(next);
        onChange(next);
        const nextOutline = extractForgejoPassthroughOutline(next);
        for (const listener of outlineListenersRef.current) listener(nextOutline);
        statusEventsRef.current?.onDirtyChange?.(next !== savedValueRef.current);
      }}
      onBlur={() => {
        if (localValueRef.current !== savedValueRef.current) {
          statusEventsRef.current?.onSaveStart?.();
          void saveHandlerRef.current?.save({ source: localValueRef.current, reason: "autosave" }).then((result) => {
            if (result?.ok) {
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

function store<T>(get: () => T): Store<T> {
  return {
    get,
    subscribe: () => () => undefined,
  };
}

export function extractForgejoPassthroughOutline(source: string) {
  const out: Array<{ id: string; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; markdown: string; html: string; line: number; from: number; key: string }> = [];
  const lines = source.split(/\n/);
  const usedIds = new Set<string>();
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (match) {
      const text = match[2];
      out.push({
        id: uniqueHeadingId(text, usedIds),
        level: match[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text,
        markdown: text,
        html: escapeHtml(text),
        line: i + 1,
        from,
        key: `${i + 1}:${text}`,
      });
    }
    from += (lines[i]?.length ?? 0) + 1;
  }
  return out;
}

function uniqueHeadingId(text: string, usedIds: Set<string>): string {
  const root = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
  let id = root;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${root}-${suffix++}`;
  }
  usedIds.add(id);
  return id;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

function countDocument(source: string) {
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const paragraphs = body.split(/\n{2,}/).filter((part) => part.trim().length > 0).length;
  return { words, chars: body.length, paragraphs };
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
