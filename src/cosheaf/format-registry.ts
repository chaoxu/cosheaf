import type { ComponentType } from "react";
import type { DocumentContext, FileSystem } from "@chaoxu/coflat/reader";
import type { RequestHandler } from "@chaoxu/coflat/editor-lazy";
import {
  COFLAT_FORMAT_ID,
  DEFAULT_DOCUMENT_FORMAT_ID,
  FORGEJO_PASSTHROUGH_FORMAT_ID,
  type DocumentFormatId,
} from "../../shared/document-format";
import type {
  EditorAssetUploader,
  EditorAutocompleteSource,
  EditorDocumentChange,
  EditorSaveHandler,
  EditorStatusEvents,
  MountedEditor,
} from "./document-format/coflat";

interface EditorProps {
  value: string;
  mode: "rich" | "source";
  onChange?: (value: string) => void;
  onDocumentChange?: (change: EditorDocumentChange) => void;
  onReady?: (editor: MountedEditor) => void;
  testId?: string;
  readOnly?: boolean;
  from?: string;
  documentContext?: DocumentContext;
  fileSystem?: FileSystem;
  saveHandler?: EditorSaveHandler;
  statusEvents?: EditorStatusEvents;
  assetUploader?: EditorAssetUploader;
  autocompleteSources?: readonly EditorAutocompleteSource[];
  requestHandler?: RequestHandler;
  sidenotesCollapsed?: boolean;
}

interface ClientDocumentFormat {
  id: DocumentFormatId;
  displayName: string;
  supportsRichDiff: boolean;
  editor(): Promise<{ default: ComponentType<EditorProps> }>;
}

const formats = new Map<DocumentFormatId, ClientDocumentFormat>();

function register(format: ClientDocumentFormat): void {
  formats.set(format.id, format);
}

register({
  id: COFLAT_FORMAT_ID,
  displayName: "Coflat Markdown",
  supportsRichDiff: true,
  editor: () =>
    import("./document-format/coflat").then((m) => ({
      default: m.MarkdownEditor as unknown as ComponentType<EditorProps>,
    })),
});

register({
  id: FORGEJO_PASSTHROUGH_FORMAT_ID,
  displayName: "Forgejo Markdown",
  supportsRichDiff: false,
  editor: () => import("./document-format/forgejo-passthrough-editor").then((m) => ({ default: m.MarkdownEditor })),
});

export function getClientDocumentFormat(formatId: DocumentFormatId): ClientDocumentFormat {
  const format = formats.get(formatId) ?? formats.get(DEFAULT_DOCUMENT_FORMAT_ID) ?? formats.get(COFLAT_FORMAT_ID);
  if (!format) throw new Error("no document formats registered");
  return format;
}
