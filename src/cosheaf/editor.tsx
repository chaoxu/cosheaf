import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
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
}

export function MarkdownEditor({ value, mode, onChange, onReady, testId }: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MountedEditor | null>(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = mountEditor({
      parent: containerRef.current,
      doc: value,
      mode,
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
