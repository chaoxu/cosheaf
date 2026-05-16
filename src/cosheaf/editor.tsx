import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type MountedEditor,
  type StandaloneEditorMode,
  mountEditor,
} from "@chaoxu/coflat-editor";
import "@chaoxu/coflat-editor/style.css";

interface Props {
  value: string;
  mode: StandaloneEditorMode;
  onChange: (value: string) => void;
  onReady?: (editor: MountedEditor) => void;
  testId?: string;
  // Mount-time only — changes after mount are ignored. The component must
  // unmount/remount to pick up new extensions (typically via key=...).
  extensions?: readonly Extension[];
  readOnly?: boolean;
  /** Source-file path for relative-ref resolution (forwarded to coflat). */
  from?: string;
}

export function MarkdownEditor({
  value,
  mode,
  onChange,
  onReady,
  testId,
  extensions,
  readOnly,
  from,
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MountedEditor | null>(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const mountExtensions: Extension[] = [...(extensions ?? [])];
    if (readOnly) mountExtensions.push(EditorView.editable.of(false));
    // `from` is accepted as a prop so call sites can declare the source-file
    // path, but coflat 0.2.0's MountEditorOptions doesn't expose it yet.
    // Plumb-through is a no-op until coflat re-exports documentContextFacet
    // or surfaces a documentContext option on mountEditor.
    void from;
    const editor = mountEditor({
      parent: containerRef.current,
      doc: value,
      mode,
      extensions: mountExtensions,
      onChange: (next) => onChangeRef.current(next),
    });
    editorRef.current = editor;
    onReady?.(editor);
    return () => {
      editor.unmount();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getDoc() === value) return;
    editor.setDoc(value);
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getMode() !== mode) editor.setMode(mode);
  }, [mode]);

  return <div ref={containerRef} data-testid={testId} className="cm-host" />;
}
