import { Text } from "@codemirror/state";
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

export function textFromSource(source: string): Text {
  return Text.of(source.split("\n"));
}

export function applyDocumentChangeText(source: Text, change: Pick<MountedDocumentChange, "changes">): Text {
  return change.changes.apply(source);
}

export class IncrementalSourceCache {
  private sourceText: Text;
  private sourceVersion = 0;

  constructor(source: string) {
    this.sourceText = textFromSource(source);
  }

  version(): number {
    return this.sourceVersion;
  }

  source(): string {
    return this.sourceText.toString();
  }

  reset(source: string): void {
    this.sourceVersion += 1;
    this.sourceText = textFromSource(source);
  }

  apply(change: Pick<MountedDocumentChange, "changes">): void {
    this.sourceVersion += 1;
    this.sourceText = applyDocumentChangeText(this.sourceText, change);
  }

  isCurrent(version: number): boolean {
    return version === this.sourceVersion;
  }
}
