import { keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import {
  type MountedEditor,
  type StandaloneEditorMode,
  mountEditor,
} from "cosheaf/editor";
import "cosheaf/editor/style.css";

interface Props {
  value: string;
  mode: StandaloneEditorMode;
  onChange: (value: string) => void;
  onSave?: () => void;
}

export function MarkdownEditor({ value, mode, onChange, onSave }: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MountedEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = mountEditor({
      parent: containerRef.current,
      doc: value,
      mode,
      onChange: (next) => onChangeRef.current(next),
      extensions: [
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
        ]),
      ],
    });
    editorRef.current = editor;
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

  return <div ref={containerRef} className="cm-host" />;
}
