import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { insertTab } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { type Diagnostic, linter } from "@codemirror/lint";
import { frontmatterField } from "@chaoxu/coflat";
import {
  type MountedLazyEditor,
  type LazyEditorDocumentChange as MountedDocumentChange,
  type SaveHandler,
  type LazyEditorMode as StandaloneEditorMode,
  type StatusEvents,
  type AssetUploader,
  type AutocompleteSource,
  type RequestHandler,
  mountLazyEditor,
} from "@chaoxu/coflat/editor-lazy";
import type { DocumentContext, FileSystem } from "@chaoxu/coflat/reader";
export type { SaveHandler, StatusEvents, AssetUploader, AutocompleteSource, MountedDocumentChange };
export type MountedEditor = MountedLazyEditor;

interface Props {
  value: string;
  mode: StandaloneEditorMode;
  onChange?: (value: string) => void;
  onDocumentChange?: (change: MountedDocumentChange) => void;
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
  /** Repository-backed file I/O for local media previews. */
  fileSystem?: FileSystem;
  /** Cmd-S / autosave / triggerSave dispatch. */
  saveHandler?: SaveHandler;
  /** Fire-and-forget lifecycle events (save, dirty, asset upload). */
  statusEvents?: StatusEvents;
  /** Paste/drop binary handler. */
  assetUploader?: AssetUploader;
  /** Trigger-based suggestion sources, e.g. `[@`. */
  autocompleteSources?: readonly AutocompleteSource[];
  /** Request/response host UI (e.g. the document-properties bibliography picker). */
  requestHandler?: RequestHandler;
  sidenotesCollapsed?: boolean;
}

export function coflatEditorMode(mode: StandaloneEditorMode, readOnly?: boolean): StandaloneEditorMode {
  return readOnly && mode === "rich" ? "rich-readonly" : mode;
}

const FRONTMATTER_TAB = "  ";

function selectionInsideFrontmatter(state: EditorState): boolean {
  const frontmatter = state.field(frontmatterField, false);
  if (!frontmatter || frontmatter.end <= 0) return false;
  return state.selection.ranges.every((range) => range.from < frontmatter.end && range.to <= frontmatter.end);
}

export function insertFrontmatterSpaces(view: EditorView): boolean {
  const transaction = view.state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: FRONTMATTER_TAB },
    range: EditorSelection.cursor(range.from + FRONTMATTER_TAB.length),
  }));
  view.dispatch(transaction, {
    scrollIntoView: true,
    userEvent: "input.indent",
  });
  return true;
}

export function sourceModeTab(view: EditorView): boolean {
  if (!selectionInsideFrontmatter(view.state)) return insertTab(view);
  return insertFrontmatterSpaces(view);
}

export function frontmatterYamlDiagnostics(state: EditorState): Diagnostic[] {
  const frontmatter = state.field(frontmatterField, false);
  if (!frontmatter || frontmatter.status.state !== "error") return [];
  return [{
    from: frontmatter.status.from,
    to: Math.max(frontmatter.status.from + 1, frontmatter.status.to),
    severity: "error",
    source: "YAML frontmatter",
    message: frontmatter.status.message,
  }];
}

export function MarkdownEditor({
  value,
  mode,
  onChange,
  onDocumentChange,
  onReady,
  testId,
  extensions,
  readOnly,
  from,
  documentContext,
  fileSystem,
  saveHandler,
  statusEvents,
  assetUploader,
  autocompleteSources,
  requestHandler,
  sidenotesCollapsed,
}: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MountedLazyEditor | null>(null);
  const lastValueRef = useRef(value);
  const modeRef = useRef(mode);
  const onChangeRef = useRef(onChange);
  const onDocumentChangeRef = useRef(onDocumentChange);
  // Host APIs are captured by refs and dispatched through stable wrappers,
  // so prop updates don't force a remount of the underlying editor.
  const saveRef = useRef(saveHandler);
  const statusRef = useRef(statusEvents);
  const assetRef = useRef(assetUploader);
  const requestHandlerRef = useRef(requestHandler);
  onChangeRef.current = onChange;
  onDocumentChangeRef.current = onDocumentChange;
  const effectiveMode = coflatEditorMode(mode, readOnly);
  modeRef.current = effectiveMode;
  saveRef.current = saveHandler;
  statusRef.current = statusEvents;
  requestHandlerRef.current = requestHandler;
  assetRef.current = assetUploader;

  useEffect(() => {
    if (!containerRef.current) return;
    const sourceModeTabExtension = Prec.highest(keymap.of([
      {
        key: "Tab",
        run: (view) => modeRef.current === "source" && sourceModeTab(view),
      },
    ]));
    const mountExtensions: Extension[] = [
      sourceModeTabExtension,
      linter((view) => frontmatterYamlDiagnostics(view.state)),
      ...(extensions ?? []),
    ];

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

    const stableRequestHandler: RequestHandler | undefined = requestHandler
      ? {
          openBibliographyPicker: (req) =>
            requestHandlerRef.current?.openBibliographyPicker?.(req) ?? Promise.resolve(null),
        }
      : undefined;

    const editor = mountLazyEditor({
      parent: containerRef.current,
      doc: value,
      mode: effectiveMode,
      pluginPreset: "workbench",
      extensions: mountExtensions,
      ...(onChange ? { onChange: (next) => onChangeRef.current?.(next) } : {}),
      ...(onDocumentChange
        ? { onDocumentChange: (change) => onDocumentChangeRef.current?.(change) }
        : {}),
      ...(from ? { from } : {}),
      ...(documentContext ? { context: documentContext } : {}),
      ...(fileSystem ? { fileSystem } : {}),
      ...(saveHandler ? { saveHandler: stableSaveHandler } : {}),
      ...(statusEvents ? { statusEvents: stableStatusEvents } : {}),
      ...(assetUploader ? { assetUploader: stableAssetUploader } : {}),
      ...(autocompleteSources && autocompleteSources.length > 0
        ? { autocompleteSources: autocompleteSources }
        : {}),
      ...(stableRequestHandler ? { requestHandler: stableRequestHandler } : {}),
      ...(sidenotesCollapsed !== undefined ? { sidenotesCollapsed } : {}),
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
    if (lastValueRef.current === value) return;
    lastValueRef.current = value;
    editor.setDoc(value);
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getMode() !== effectiveMode) editor.setMode(effectiveMode);
  }, [effectiveMode]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !documentContext) return;
    editor.setContext(documentContext);
  }, [documentContext]);

  return <div ref={containerRef} data-testid={testId} className="cm-host" />;
}
