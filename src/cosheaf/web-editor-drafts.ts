import { useCallback, useEffect, useState } from "react";
import { clearDraft, type DraftScope, type EditorDraft, readDraft, restoredDraftFreshness, writeDraft } from "./editor-draft";
import { toast } from "./web-editor-helpers";

// Local-draft autosave concern for the page editor (#162), extracted from
// web-editor.tsx. Wraps editor-draft.ts localStorage persistence only — no
// network, no commit, no branch creation. The controller owns the pending-draft
// banner state and the restore/discard/write helpers; applying a restored draft
// to the editor is delegated back through the passed-in editor callbacks/refs so
// this stays a pure storage concern.
interface LocalDraftsOptions {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  draftScope?: DraftScope;
  initialContent: string;
  getLiveSource: () => string;
  uncommitted: boolean;
  pathDirty: boolean;
  savedShaRef: { current: string | null | undefined };
  sourceShaRef: { current: string | undefined };
  currentPathRef: { current: string };
  savedPathRef: { current: string };
  branchRef: { current: string };
  replaceEditorDocument: (next: string) => void;
  setCurrentPath: (path: string) => void;
  setPathDirty: (dirty: boolean) => void;
  setUncommitted: (uncommitted: boolean) => void;
  setSaveError: (error: string | null) => void;
}

export interface LocalDraftsController {
  pendingDraft: EditorDraft | null;
  setPendingDraft: (draft: EditorDraft | null) => void;
  localDraftForSource: (source: string) => EditorDraft;
  writeLocalDraft: (source: string) => void;
  saveDraft: (source: string) => { ok: true };
  restoreDraft: () => void;
  discardDraft: () => void;
}

export function useLocalDrafts(options: LocalDraftsOptions): LocalDraftsController {
  const {
    owner,
    repo,
    branch,
    path,
    draftScope,
    initialContent,
    getLiveSource,
    uncommitted,
    pathDirty,
    savedShaRef,
    sourceShaRef,
    currentPathRef,
    savedPathRef,
    branchRef,
    replaceEditorDocument,
    setCurrentPath,
    setPathDirty,
    setUncommitted,
    setSaveError,
  } = options;

  const [pendingDraft, setPendingDraft] = useState<EditorDraft | null>(null);

  const localDraftForSource = useCallback((source: string): EditorDraft => {
    const baseSha = savedShaRef.current;
    const sourceSha = sourceShaRef.current;
    return {
      source,
      path: currentPathRef.current,
      ...(baseSha === undefined ? {} : { baseSha, baseShaKnown: true as const }),
      ...(sourceSha === undefined ? {} : { sourceSha, sourceShaKnown: true as const }),
      savedAt: Date.now(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeLocalDraft = useCallback((source: string): void => {
    writeDraft(owner, repo, branchRef.current, savedPathRef.current, localDraftForSource(source), draftScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, draftScope, localDraftForSource]);

  const writeLiveLocalDraft = useCallback(() => {
    writeLocalDraft(getLiveSource());
  }, [getLiveSource, writeLocalDraft]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!uncommitted && !pathDirty) return;
      writeLiveLocalDraft();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pathDirty, uncommitted, writeLiveLocalDraft]);

  useEffect(() => {
    const flush = () => {
      if (uncommitted || pathDirty) writeLiveLocalDraft();
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [pathDirty, uncommitted, writeLiveLocalDraft]);

  // Offer a local draft from a previous session if it differs from the loaded
  // file (#162). Runs once on mount; the banner lets the user restore or discard
  // so the committed file is never silently overwritten.
  useEffect(() => {
    const draft = readDraft(owner, repo, branch, path, draftScope);
    if (draft && (draft.source !== initialContent || (draft.path && draft.path !== path))) setPendingDraft(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (#162): persist the in-progress source to a local draft. No
  // network, no commit, no branch creation — so it can never clobber the
  // selection (#161) or produce commit noise. Synchronous, so it returns ok.
  const saveDraft = useCallback(
    (source: string): { ok: true } => {
      writeLocalDraft(source);
      return { ok: true };
    },
    [writeLocalDraft],
  );

  const restoreDraft = useCallback(() => {
    if (!pendingDraft) return;
    const freshness = restoredDraftFreshness(
      { baseSha: savedShaRef.current, sourceSha: sourceShaRef.current },
      pendingDraft,
    );
    savedShaRef.current = freshness.baseSha;
    sourceShaRef.current = freshness.sourceSha;
    if (pendingDraft.path && pendingDraft.path !== currentPathRef.current) {
      setCurrentPath(pendingDraft.path);
      setPathDirty(pendingDraft.path !== savedPathRef.current);
    }
    replaceEditorDocument(pendingDraft.source);
    setUncommitted(true);
    setSaveError(null);
    toast("Restored local draft");
    setPendingDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft, replaceEditorDocument]);

  const discardDraft = useCallback(() => {
    clearDraft(owner, repo, branch, path, draftScope);
    clearDraft(owner, repo, branchRef.current, savedPathRef.current, draftScope);
    if (pendingDraft?.path) clearDraft(owner, repo, branchRef.current, pendingDraft.path, draftScope);
    setPendingDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, branch, path, draftScope, pendingDraft?.path]);

  return {
    pendingDraft,
    setPendingDraft,
    localDraftForSource,
    writeLocalDraft,
    saveDraft,
    restoreDraft,
    discardDraft,
  };
}
