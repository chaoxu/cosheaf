import type { MountedDocumentChange, MountedEditor } from "@chaoxu/coflat";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";

interface EditorChangeHandlers {
  onStringChange: (value: string) => void;
  onDocumentChange: (change: MountedDocumentChange) => void;
}

export type RoutedEditorChangeProps =
  | { onChange: (value: string) => void; onDocumentChange?: never }
  | { onChange?: never; onDocumentChange: (change: MountedDocumentChange) => void };

export function routeEditorChangeHandlers(
  formatId: DocumentFormatId,
  handlers: EditorChangeHandlers,
): RoutedEditorChangeProps {
  return formatId === COFLAT_FORMAT_ID
    ? { onDocumentChange: handlers.onDocumentChange }
    : { onChange: handlers.onStringChange };
}

export function liveEditorSource(editor: Pick<MountedEditor, "getDoc"> | null | undefined, fallback: string): string {
  return editor?.getDoc() ?? fallback;
}
