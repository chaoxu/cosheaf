import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { suggestingHunkFingerprint, suggestingHunks, type SuggestingHunk } from "../../shared/suggesting-diff";
import { ApiError, api } from "./api";
import { liveEditorSource } from "./editor-change-routing";
import type { IncrementalSourceCache } from "./editor-change-routing";
import type { MountedEditor } from "./editor";
import { createSuggestingModeController, type SuggestingModeController } from "./suggesting-mode";
import { toast } from "./web-editor-helpers";
import type { ExternalFileChange } from "./web-editor-external-change";

// Suggesting-mode concern for the page editor (local Workbench), extracted from
// web-editor.tsx. This is the deepest commit/Cmd-S coupling: it owns the
// suggesting base/accepted-hunk/error/source state, the checkpoint + accept +
// revert flows, and the createSuggestingModeController ref-indirection wiring.
// The commit path is NOT duplicated here — the hook takes commitSource and the
// external-change surface (setExternalFileChange/ignoreOwnChangeEvents) as
// inputs and threads them, so commitManualSource chains commitSource ->
// checkpointSuggestingFile and revertSuggestingHunk pokes the same external
// state. The controller wiring stays identity-stable so the editor is never
// remounted when the base text changes.

export interface SuggestingBase {
  path: string;
  baseText: string;
  headSha: string;
  currentSha: string | null;
}

type CommitResult = { ok: true; branch: string; path: string } | { ok: false; error: string };
type CheckpointResult = { ok: true; commitSha: string | null } | { ok: false; error: string };

function acceptedSuggestingHunkKey(baseText: string, currentText: string, hunk: SuggestingHunk): string {
  return `${hunk.id}\0${suggestingHunkFingerprint(baseText, currentText, hunk)}`;
}

interface SuggestingModeOptions {
  enabled: boolean;
  owner: string;
  repo: string;
  initialContent: string;
  savedPath: string;
  content: string;
  busy: boolean;
  uncommitted: boolean;
  pathDirty: boolean;
  editorRef: { current: MountedEditor | null };
  sourceCacheRef: { current: IncrementalSourceCache };
  savedShaRef: { current: string | null | undefined };
  sourceShaRef: { current: string | undefined };
  savedPathRef: { current: string };
  currentPathRef: { current: string };
  setSaveError: (error: string | null) => void;
  setBusy: (busy: boolean) => void;
  setSavedPath: (path: string) => void;
  setCurrentPath: (path: string) => void;
  setPathDirty: (dirty: boolean) => void;
  setUncommitted: (uncommitted: boolean) => void;
  replaceEditorDocument: (next: string) => void;
  commitSource: (source: string) => Promise<CommitResult>;
  setExternalFileChange: (
    next: ExternalFileChange | null | ((current: ExternalFileChange | null) => ExternalFileChange | null),
  ) => void;
  ignoreOwnChangeEvents: (paths: string[]) => void;
  onCheckpoint: () => void;
}

export interface SuggestingModeHook {
  suggestingBase: SuggestingBase | null;
  suggestingError: string | null;
  applySource: (next: string) => void;
  loadSuggestingBase: (path: string) => Promise<SuggestingBase | null>;
  checkpointSuggestingFile: (path: string) => Promise<CheckpointResult>;
  commitManualSource: (source: string) => Promise<CommitResult>;
  suggestingHunksForSource: readonly SuggestingHunk[];
  unresolvedSuggestingHunkCount: number;
  hasCheckpointChanges: boolean;
  suggestingController: SuggestingModeController | null;
}

export function useSuggestingMode(options: SuggestingModeOptions): SuggestingModeHook {
  const {
    enabled,
    owner,
    repo,
    initialContent,
    savedPath,
    content,
    busy,
    uncommitted,
    pathDirty,
    editorRef,
    sourceCacheRef,
    savedShaRef,
    sourceShaRef,
    savedPathRef,
    currentPathRef,
    setSaveError,
    setBusy,
    setSavedPath,
    setCurrentPath,
    setPathDirty,
    setUncommitted,
    replaceEditorDocument,
    commitSource,
    setExternalFileChange,
    ignoreOwnChangeEvents,
    onCheckpoint,
  } = options;

  const [suggestingBase, setSuggestingBase] = useState<SuggestingBase | null>(null);
  const [acceptedSuggestingHunks, setAcceptedSuggestingHunks] = useState<ReadonlySet<string>>(() => new Set());
  const [suggestingError, setSuggestingError] = useState<string | null>(null);
  const [suggestingSource, setSuggestingSource] = useState(initialContent);

  const suggestingBaseRef = useRef(suggestingBase);
  suggestingBaseRef.current = suggestingBase;

  const applySource = useCallback((next: string) => {
    if (enabled && suggestingBaseRef.current) setSuggestingSource(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const loadSuggestingBase = useCallback(async (path: string) => {
    if (!enabled) return null;
    try {
      const base = await api.suggestingBase(owner, repo, path);
      const next = {
        path: base.path,
        baseText: base.base_text,
        headSha: base.head_sha,
        currentSha: base.current_sha,
      };
      setSuggestingBase(next);
      setSuggestingSource(sourceCacheRef.current.source());
      setAcceptedSuggestingHunks(new Set());
      setSuggestingError(null);
      return next;
    } catch (err) {
      setSuggestingBase(null);
      setAcceptedSuggestingHunks(new Set());
      setSuggestingError(err instanceof ApiError ? err.message : "Suggesting mode unavailable");
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void loadSuggestingBase(savedPathRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSuggestingBase, savedPath, enabled]);

  const checkpointSuggestingFile = useCallback(async (path: string): Promise<CheckpointResult> => {
    if (!enabled) return { ok: true, commitSha: null };
    try {
      if (!suggestingBase || suggestingBase.path !== path) {
        return { ok: false, error: "suggesting base unavailable; reload and retry" };
      }
      const checkpoint = await api.checkpointSuggestingFile(owner, repo, path, {
        headSha: suggestingBase.headSha,
        currentSha: savedShaRef.current ?? suggestingBase.currentSha,
      });
      setSuggestingBase({
        path: checkpoint.path,
        baseText: checkpoint.base_text,
        headSha: checkpoint.head_sha,
        currentSha: checkpoint.current_sha,
      });
      savedShaRef.current = checkpoint.current_sha;
      setAcceptedSuggestingHunks(new Set());
      setSuggestingError(null);
      return { ok: true, commitSha: checkpoint.commit_sha };
    } catch (err) {
      const error = err instanceof ApiError ? err.message : "checkpoint failed";
      if (err instanceof ApiError && err.status === 409) {
        setExternalFileChange({
          path,
          type: "change",
          compareOpen: true,
          loading: true,
          staleSave: true,
        });
      }
      setSuggestingError(error);
      return { ok: false, error };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, suggestingBase, enabled]);

  const commitManualSource = useCallback(
    async (source: string): Promise<CommitResult> => {
      const committed = await commitSource(source);
      if (!committed.ok) return committed;
      if (!enabled || !suggestingBase || suggestingBase.path !== committed.path) return committed;
      const checkpoint = await checkpointSuggestingFile(committed.path);
      if (!checkpoint.ok) return { ok: false, error: checkpoint.error };
      return committed;
    },
    [commitSource, checkpointSuggestingFile, suggestingBase, enabled],
  );

  const suggestingHunksForSource = useMemo(
    () => suggestingBase ? suggestingHunks(suggestingBase.baseText, suggestingSource) : [],
    [suggestingBase, suggestingSource],
  );
  const unresolvedSuggestingHunkCount = useMemo(
    () => suggestingBase
      ? suggestingHunksForSource.filter((hunk) =>
          !acceptedSuggestingHunks.has(acceptedSuggestingHunkKey(suggestingBase.baseText, suggestingSource, hunk))
        ).length
      : 0,
    [acceptedSuggestingHunks, suggestingBase, suggestingHunksForSource, suggestingSource],
  );
  const hasCheckpointChanges = enabled && suggestingHunksForSource.length > 0;

  const acceptSuggestingHunk = useCallback((hunk: SuggestingHunk) => {
    const base = suggestingBase;
    if (!base) return;
    const source = liveEditorSource(editorRef.current, suggestingSource);
    const key = acceptedSuggestingHunkKey(base.baseText, source, hunk);
    setSuggestingSource(source);
    setAcceptedSuggestingHunks((previous) => {
      const next = new Set(previous);
      next.add(key);
      return next;
    });
    toast("Hunk kept for the next checkpoint");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestingBase, suggestingSource]);

  const revertSuggestingHunk = useCallback(async (hunk: SuggestingHunk) => {
    if (busy) return;
    if (pathDirty) {
      const error = "Rename pending: save or cancel the path change before reverting a hunk.";
      setSaveError(error);
      toast(error, "error");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      if (uncommitted) {
        const committed = await commitSource(liveEditorSource(editorRef.current, content));
        if (!committed.ok) throw new Error(committed.error);
      }
      const targetPath = savedPathRef.current;
      ignoreOwnChangeEvents([targetPath]);
      if (!suggestingBase || suggestingBase.path !== targetPath) {
        throw new Error("suggesting base unavailable; reload and retry");
      }
      const result = await api.revertSuggestingHunk(owner, repo, targetPath, hunk, {
        headSha: suggestingBase.headSha,
        currentSha: savedShaRef.current ?? suggestingBase.currentSha,
      });
      replaceEditorDocument(result.content);
      setSavedPath(result.path);
      setCurrentPath(result.path);
      savedPathRef.current = result.path;
      currentPathRef.current = result.path;
      savedShaRef.current = result.sha;
      sourceShaRef.current = undefined;
      setPathDirty(false);
      setUncommitted(false);
      setExternalFileChange(null);
      setSuggestingBase({
        path: result.path,
        baseText: result.base_text,
        headSha: result.head_sha,
        currentSha: result.current_sha,
      });
      setAcceptedSuggestingHunks(new Set());
      setSuggestingError(null);
      toast("Reverted hunk");
    } catch (err) {
      const error = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "revert failed";
      if (err instanceof ApiError && err.status === 409) {
        setExternalFileChange({
          path: savedPathRef.current,
          type: "change",
          compareOpen: true,
          loading: true,
          staleSave: true,
        });
      }
      setSaveError(error);
      toast(`Revert failed: ${error}`, "error");
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, uncommitted, pathDirty, commitSource, content, owner, repo, ignoreOwnChangeEvents, replaceEditorDocument, suggestingBase]);

  const acceptSuggestingHunkRef = useRef(acceptSuggestingHunk);
  const revertSuggestingHunkRef = useRef(revertSuggestingHunk);
  acceptSuggestingHunkRef.current = acceptSuggestingHunk;
  revertSuggestingHunkRef.current = revertSuggestingHunk;

  const suggestingController = useMemo(
    () =>
      enabled
        ? createSuggestingModeController({
            baseText: null,
            onAccept: (hunk) => acceptSuggestingHunkRef.current(hunk),
            onRevert: (hunk) => revertSuggestingHunkRef.current(hunk),
            onCheckpoint: () => onCheckpoint(),
          })
        : null,
    [enabled, onCheckpoint],
  );

  useEffect(() => {
    suggestingController?.setBaseText(suggestingBase?.baseText ?? null);
  }, [suggestingBase?.baseText, suggestingController]);

  return {
    suggestingBase,
    suggestingError,
    applySource,
    loadSuggestingBase,
    checkpointSuggestingFile,
    commitManualSource,
    suggestingHunksForSource,
    unresolvedSuggestingHunkCount,
    hasCheckpointChanges,
    suggestingController,
  };
}
