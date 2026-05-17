interface OutlineEntry {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  readonly line: number;
  readonly key: string;
  readonly number?: string;
}

export interface MountedEditor {
  outline: {
    get(): readonly OutlineEntry[];
    subscribe(fn: (value: readonly OutlineEntry[]) => void): () => void;
  };
  scrollToLine(line: number, opts?: { center?: boolean }): void;
  triggerSave(reason?: "manual" | "command"): Promise<void>;
}

export { MarkdownEditor } from "../editor";
export type {
  SaveHandler as EditorSaveHandler,
  StatusEvents as EditorStatusEvents,
  AssetUploader as EditorAssetUploader,
  AutocompleteSource as EditorAutocompleteSource,
} from "../editor";
