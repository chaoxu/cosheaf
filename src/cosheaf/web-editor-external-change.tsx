import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceApiPath } from "../../shared/url";
import { ApiError, api } from "./api";
import type { DraftScope, EditorDraft } from "./editor-draft";
import { writeDraft } from "./editor-draft";
import { liveEditorSource } from "./editor-change-routing";
import type { IncrementalSourceCache } from "./editor-change-routing";
import { editorExternalDiffHasVisibleChanges, editorExternalDiffRows, type EditorExternalDiffRow } from "./editor-external-diff";
import type { MountedEditor } from "./editor";
import { toast } from "./web-editor-helpers";

// External-file-change concern for the page editor (#162, external-edit hunk
// diff), extracted from web-editor.tsx. Owns the SSE `/events` subscription that
// notices out-of-editor writes/removes to the current file, the buffer-vs-latest
// comparison, and the "load latest / keep editing" recovery affordances. This is
// the save-conflict surface, so the setter and the own-change ignore ref are also
// driven from OUTSIDE the hook (commitSource's 409 path, checkpointSuggestingFile,
// revertSuggestingHunk): the controller returns setExternalFileChange and
// ignoreOwnChangeEvents so those callers keep poking the same state.
export type ExternalFileChange = {
  path: string;
  type: "change" | "remove";
  compareOpen: boolean;
  loading: boolean;
  latestContent?: string;
  latestSha?: string | null;
  error?: string;
  staleSave?: boolean;
};

interface ExternalFileChangeOptions {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  content: string;
  busy: boolean;
  uncommitted: boolean;
  pathDirty: boolean;
  draftScope?: DraftScope;
  editorRef: { current: MountedEditor | null };
  sourceCacheRef: { current: IncrementalSourceCache };
  branchRef: { current: string };
  savedReadBranchRef: { current: string };
  currentPathRef: { current: string };
  savedPathRef: { current: string };
  savedShaRef: { current: string | null | undefined };
  sourceShaRef: { current: string | undefined };
  pathDirtyRef: { current: boolean };
  setSaveError: (error: string | null) => void;
  setUncommitted: (uncommitted: boolean) => void;
  setBusy: (busy: boolean) => void;
  setCurrentPath: (path: string) => void;
  setSavedPath: (path: string) => void;
  setPathDirty: (dirty: boolean) => void;
  replaceEditorDocument: (next: string) => void;
  localDraftForSource: (source: string) => EditorDraft;
  setPendingDraft: (draft: EditorDraft | null) => void;
  reloadSuggestingBase: (path: string) => void;
  copyCurrentBuffer: () => void;
}

export interface ExternalFileChangeController {
  externalFileChange: ExternalFileChange | null;
  setExternalFileChange: (
    next: ExternalFileChange | null | ((current: ExternalFileChange | null) => ExternalFileChange | null),
  ) => void;
  ignoreOwnChangeEvents: (paths: string[]) => void;
  loadLatestFile: () => void;
  compareRows: EditorExternalDiffRow[];
  banner: ReactNode;
}

function renderExternalCompareCell(
  line: number | "",
  text: string,
  marker: "+" | "-" | "",
  note?: string,
): ReactNode {
  const markerLabel = marker === "+" ? "Added line" : marker === "-" ? "Removed line" : undefined;
  return (
    <>
      <span className="editor-external-compare-line-number">{line}</span>
      <span
        className="editor-external-compare-marker"
        {...(markerLabel ? { "aria-label": markerLabel } : { "aria-hidden": true })}
      >
        {marker || " "}
      </span>
      <span>{text}</span>
      {note ? <em className="editor-external-compare-note">{note}</em> : null}
    </>
  );
}

export function useExternalFileChange(options: ExternalFileChangeOptions): ExternalFileChangeController {
  const {
    owner,
    repo,
    path,
    branch,
    content,
    busy,
    uncommitted,
    pathDirty,
    draftScope,
    editorRef,
    sourceCacheRef,
    branchRef,
    savedReadBranchRef,
    currentPathRef,
    savedPathRef,
    savedShaRef,
    sourceShaRef,
    pathDirtyRef,
    setSaveError,
    setUncommitted,
    setBusy,
    setCurrentPath,
    setSavedPath,
    setPathDirty,
    replaceEditorDocument,
    localDraftForSource,
    setPendingDraft,
    reloadSuggestingBase,
    copyCurrentBuffer,
  } = options;

  const [externalFileChange, setExternalFileChange] = useState<ExternalFileChange | null>(null);
  const ignoredChangePathsRef = useRef(new Set<string>());
  const ignoredChangeTimersRef = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of ignoredChangeTimersRef.current) window.clearTimeout(timer);
      ignoredChangeTimersRef.current = [];
    },
    [],
  );

  const ignoreOwnChangeEvents = useCallback((paths: string[]) => {
    for (const path of paths) {
      if (!path) continue;
      ignoredChangePathsRef.current.add(path);
    }
    const timer = window.setTimeout(() => {
      for (const path of paths) ignoredChangePathsRef.current.delete(path);
      ignoredChangeTimersRef.current = ignoredChangeTimersRef.current.filter((item) => item !== timer);
    }, 5_000);
    ignoredChangeTimersRef.current.push(timer);
  }, []);

  const resolveIdenticalWorkspaceContent = useCallback((changePath: string, latest: { content: string; sha: string | null }): boolean => {
    const source = liveEditorSource(editorRef.current, sourceCacheRef.current.source());
    if (editorExternalDiffHasVisibleChanges(editorExternalDiffRows(source, latest.content))) return false;
    savedShaRef.current = latest.sha;
    sourceShaRef.current = undefined;
    if (changePath === currentPathRef.current) {
      setSaveError(null);
      if (!pathDirtyRef.current) setUncommitted(false);
    }
    setExternalFileChange(null);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource(`${workspaceApiPath(owner, repo)}/events`);
    stream.onmessage = (event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch (_err) {
        return;
      }
      if (!data || typeof data !== "object") return;
      const payload = data as { type?: unknown; action?: unknown; path?: unknown; previous_path?: unknown };
      if (typeof payload.path !== "string") return;
      let type: ExternalFileChange["type"] | null = null;
      if (payload.type === "change") type = "change";
      if (payload.type === "remove") type = "remove";
      if (payload.type === "file_changed") {
        if (payload.action === "changed" || payload.action === "moved") type = "change";
        if (payload.action === "removed") type = "remove";
      }
      if (!type) return;
      const current = currentPathRef.current.trim() || path;
      const saved = savedPathRef.current;
      const previousPath = typeof payload.previous_path === "string" ? payload.previous_path : null;
      if (payload.path !== current && payload.path !== saved && previousPath !== current && previousPath !== saved) return;
      const ignoredPath = ignoredChangePathsRef.current.has(payload.path)
        ? payload.path
        : previousPath && ignoredChangePathsRef.current.has(previousPath) ? previousPath : null;
      if (ignoredPath) {
        ignoredChangePathsRef.current.delete(payload.path);
        if (previousPath) ignoredChangePathsRef.current.delete(previousPath);
        return;
      }
      setExternalFileChange({
        path: payload.path,
        type,
        compareOpen: false,
        loading: type === "change",
      });
    };
    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, path, repo]);

  useEffect(() => {
    if (!externalFileChange || externalFileChange.type !== "change" || !externalFileChange.loading) return;
    let cancelled = false;
    const readBranch = branchRef.current || savedReadBranchRef.current || branch;
    void api.getFile(owner, repo, externalFileChange.path, readBranch).then((latest) => {
      if (cancelled) return;
      if (resolveIdenticalWorkspaceContent(externalFileChange.path, latest)) return;
      setExternalFileChange((current) => current && current.path === externalFileChange.path
        ? {
            ...current,
            loading: false,
            latestContent: latest.content,
            latestSha: latest.sha,
            error: undefined,
          }
        : current);
    }).catch((err) => {
      if (cancelled) return;
      setExternalFileChange((current) => current && current.path === externalFileChange.path
        ? {
            ...current,
            loading: false,
            error: err instanceof Error ? err.message : "Unable to read latest file",
          }
        : current);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, owner, repo, externalFileChange, resolveIdenticalWorkspaceContent]);

  const loadLatestFile = useCallback(() => {
    const change = externalFileChange;
    if (!change || change.type !== "change" || busy) return;
    const hasLocalEdits = uncommitted || pathDirty;
    if (hasLocalEdits && !window.confirm("Load the latest workspace file and keep your current editor buffer as a local draft?")) return;
    const recoveryDraft = hasLocalEdits ? localDraftForSource(liveEditorSource(editorRef.current, content)) : null;
    if (recoveryDraft) {
      writeDraft(owner, repo, branchRef.current, savedPathRef.current, recoveryDraft, draftScope);
    }
    setBusy(true);
    setSaveError(null);
    const readBranch = branchRef.current || savedReadBranchRef.current || branch;
    const load = change.latestContent !== undefined
      ? Promise.resolve({ content: change.latestContent, sha: change.latestSha })
      : api.getFile(owner, repo, change.path, readBranch).then((latest) => ({
          content: latest.content,
          sha: latest.sha,
        }));
    void load.then((latest) => {
      replaceEditorDocument(latest.content);
      setCurrentPath(change.path);
      setSavedPath(change.path);
      currentPathRef.current = change.path;
      savedPathRef.current = change.path;
      savedShaRef.current = latest.sha;
      sourceShaRef.current = undefined;
      setPathDirty(false);
      setUncommitted(false);
      setExternalFileChange(null);
      if (recoveryDraft) setPendingDraft(recoveryDraft);
      reloadSuggestingBase(change.path);
      toast("Loaded latest workspace file");
    }).catch((err) => {
      const error = err instanceof ApiError ? err.message : "Unable to load latest file";
      setExternalFileChange((current) => current && current.path === change.path ? { ...current, loading: false, error } : current);
      setSaveError(error);
      toast(error, "error");
    }).finally(() => {
      setBusy(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, branch, owner, repo, content, draftScope, externalFileChange, localDraftForSource, pathDirty, replaceEditorDocument, reloadSuggestingBase, uncommitted]);

  const compareRows = externalFileChange?.latestContent !== undefined
    ? editorExternalDiffRows(liveEditorSource(editorRef.current, content), externalFileChange.latestContent)
    : [];
  const compareHasVisibleChanges = editorExternalDiffHasVisibleChanges(compareRows);

  const banner = externalFileChange ? (
    <>
      <div className="editor-draft-banner editor-external-change-banner" data-testid="editor-external-change-banner" role="alert">
        <span>
          {externalFileChange.staleSave
            ? "Save blocked because this editor buffer is stale."
            : externalFileChange.type === "remove" ? "This file was removed outside this editor." : "This file changed outside this editor."}
          {externalFileChange.type === "remove" ? " Copy the buffer before leaving this editor." : " Compare or load the latest file before saving."}
        </span>
        {externalFileChange.type === "change" ? (
          <button
            type="button"
            className="button small"
            data-testid="editor-external-change-compare"
            onClick={() => setExternalFileChange((current) => current ? { ...current, compareOpen: !current.compareOpen } : current)}
          >
            {externalFileChange.compareOpen ? "Hide compare" : "Compare"}
          </button>
        ) : null}
        {externalFileChange.type === "change" ? (
          <button type="button" className="button small" data-testid="editor-external-change-reload" onClick={loadLatestFile} disabled={busy}>
            Load latest
          </button>
        ) : null}
        <button type="button" className="button small subtle" data-testid="editor-external-change-copy" onClick={copyCurrentBuffer}>
          Copy buffer
        </button>
        <button
          type="button"
          className="button small subtle"
          data-testid="editor-external-change-keep-editing"
          onClick={() => setExternalFileChange((current) => current ? { ...current, compareOpen: false } : current)}
        >
          Keep editing stale buffer
        </button>
      </div>
      {externalFileChange.compareOpen ? (
        <section className="editor-external-compare" data-testid="editor-external-compare" aria-label="External change compare">
          <header>
            <strong>Editor buffer vs latest workspace file</strong>
            <span>{externalFileChange.path}</span>
          </header>
          {externalFileChange.loading ? (
            <p>Loading latest file...</p>
          ) : externalFileChange.error ? (
            <p>{externalFileChange.error}</p>
          ) : externalFileChange.type === "remove" ? (
            <p>The workspace file no longer exists. Copy the buffer before leaving this editor.</p>
          ) : !compareHasVisibleChanges ? (
            <p>The latest workspace file has the same content as the editor buffer.</p>
          ) : (
            <div className="editor-external-compare-grid">
              <div className="editor-external-compare-heading">Current editor buffer</div>
              <div className="editor-external-compare-heading">Latest workspace file</div>
              {compareRows.map((row) => (
                <div className={`editor-external-compare-row editor-external-compare-row--${row.kind}`} key={row.key}>
                  <pre>
                    {row.kind === "add"
                      ? renderExternalCompareCell("", " ", "")
                      : renderExternalCompareCell(row.bufferLine, row.buffer, row.kind === "remove" ? "-" : "", row.kind === "remove" ? row.bufferNote : undefined)}
                  </pre>
                  <pre>
                    {row.kind === "remove"
                      ? renderExternalCompareCell("", " ", "")
                      : renderExternalCompareCell(row.latestLine, row.latest, row.kind === "add" ? "+" : "", row.kind === "add" ? row.latestNote : undefined)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </>
  ) : null;

  return {
    externalFileChange,
    setExternalFileChange,
    ignoreOwnChangeEvents,
    loadLatestFile,
    compareRows,
    banner,
  };
}
