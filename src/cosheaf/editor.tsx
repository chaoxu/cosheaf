import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type MountedEditor,
  type SaveHandler,
  type StandaloneEditorMode,
  type StatusEvents,
  type AssetUploader,
  type AutocompleteSource,
  mountEditor,
} from "@chaoxu/coflat";
import type { DocumentContext } from "@chaoxu/coflat/reader";
export type { SaveHandler, StatusEvents, AssetUploader, AutocompleteSource };

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
  /** Reader-compatible link/ref/citation resolver context. */
  documentContext?: DocumentContext;
  /** Cmd-S / autosave / triggerSave dispatch. */
  saveHandler?: SaveHandler;
  /** Fire-and-forget lifecycle events (save, dirty, asset upload). */
  statusEvents?: StatusEvents;
  /** Paste/drop binary handler. */
  assetUploader?: AssetUploader;
  /** Trigger-based suggestion sources, e.g. `[@`. */
  autocompleteSources?: readonly AutocompleteSource[];
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
  documentContext,
  saveHandler,
  statusEvents,
  assetUploader,
  autocompleteSources,
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MountedEditor | null>(null);
  const onChangeRef = useRef(onChange);
  // Host APIs are captured by refs and dispatched through stable wrappers,
  // so prop updates don't force a remount of the underlying editor.
  const saveRef = useRef(saveHandler);
  const statusRef = useRef(statusEvents);
  const assetRef = useRef(assetUploader);
  const autocompleteRef = useRef(autocompleteSources);
  onChangeRef.current = onChange;
  saveRef.current = saveHandler;
  statusRef.current = statusEvents;
  assetRef.current = assetUploader;
  autocompleteRef.current = autocompleteSources;

  useEffect(() => {
    if (!containerRef.current) return;
    const mountExtensions: Extension[] = [...(extensions ?? [])];
    if (readOnly) mountExtensions.push(EditorView.editable.of(false));

    // Stable host-API wrappers that always read the latest prop value via ref.
    const stableSaveHandler: SaveHandler = {
      save: (payload) =>
        saveRef.current?.save(payload) ??
        Promise.resolve({ ok: false as const, error: "no save handler" }),
      isBusy: () => saveRef.current?.isBusy?.() ?? false,
      autosaveDebounceMs: saveRef.current?.autosaveDebounceMs,
    };
    const stableStatusEvents: StatusEvents = {
      onSaveStart: () => statusRef.current?.onSaveStart?.(),
      onSaveSucceeded: () => statusRef.current?.onSaveSucceeded?.(),
      onSaveFailed: (e) => statusRef.current?.onSaveFailed?.(e),
      onDirtyChange: (d) => statusRef.current?.onDirtyChange?.(d),
      onAssetUploading: (e) => statusRef.current?.onAssetUploading?.(e),
      onAssetUploadSucceeded: (e) => statusRef.current?.onAssetUploadSucceeded?.(e),
      onAssetUploadFailed: (e) => statusRef.current?.onAssetUploadFailed?.(e),
    };
    const stableAssetUploader: AssetUploader = {
      upload: (file, env) =>
        assetRef.current?.upload(file, env) ??
        Promise.resolve({ error: "no uploader" as const }),
      accept: (file) => assetRef.current?.accept?.(file) ?? null,
      cancel: (file) => assetRef.current?.cancel?.(file),
    };

    const editor = mountEditor({
      parent: containerRef.current,
      doc: value,
      mode,
      extensions: mountExtensions,
      onChange: (next) => onChangeRef.current(next),
      ...(from ? { from } : {}),
      ...(documentContext ? { context: documentContext } : {}),
      ...(saveHandler ? { saveHandler: stableSaveHandler } : {}),
      ...(statusEvents ? { statusEvents: stableStatusEvents } : {}),
      ...(assetUploader ? { assetUploader: stableAssetUploader } : {}),
      ...(autocompleteSources && autocompleteSources.length > 0
        ? { autocompleteSources: autocompleteSources }
        : {}),
    });
    editorRef.current = editor;
    onReady?.(editor);
    return () => {
      editor.unmount();
      editorRef.current = null;
    };
  // Mount-time only. Host APIs use refs to avoid remount churn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !documentContext) return;
    editor.setContext(documentContext);
  }, [documentContext]);

  return <div ref={containerRef} data-testid={testId} className="cm-host" />;
}
