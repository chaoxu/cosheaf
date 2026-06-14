import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  AssetUploader as EditorAssetUploader,
  AutocompleteSource as EditorAutocompleteSource,
  MountedEditor,
  OutlineEntry,
  SaveHandler as EditorSaveHandler,
  StatusEvents as EditorStatusEvents,
} from "@chaoxu/coflat";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";
import { urlPath } from "../../shared/url";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
  userBranchPrefix,
} from "../../shared/conventions";
import { ApiError, api } from "./api";
import { readAutosave, readDocumentTheme, readEditorMode } from "./document-theme";
import type { DocumentThemeId } from "./document-theme";
import { clearDraft, type EditorDraft, readDraft, writeDraft } from "./editor-draft";
import { getClientDocumentFormat } from "./format-registry";
import {
  type CoflatLocalRefs,
  coflatDocumentContext,
  loadCoflatRefs,
  resolveUnresolvedCoflatReferences,
} from "./coflat-document-context";
import "@chaoxu/coflat/style.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

interface EditorConfig {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  branchExists: boolean;
  username: string;
  role: "admin" | "write" | "read";
  formatId: DocumentFormatId;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readConfig(): { config: EditorConfig; content: string } {
  const mount = document.getElementById("web-editor-root");
  const payload = document.getElementById("web-editor-content");
  if (!mount || !payload) throw new Error("missing web editor mount payload");
  return {
    config: {
      owner: mount.dataset.owner ?? "",
      repo: mount.dataset.repo ?? "",
      path: mount.dataset.path ?? "",
      branch: mount.dataset.branch ?? "",
      branchExists: mount.dataset.branchExists !== "0",
      username: mount.dataset.username ?? "",
      role: (mount.dataset.role ?? "read") as EditorConfig["role"],
      formatId: (mount.dataset.formatId ?? "forgejo-passthrough") as DocumentFormatId,
    },
    content: JSON.parse(payload.textContent || "\"\"") as string,
  };
}

function WebEditor({ config, initialContent }: { config: EditorConfig; initialContent: string }) {
  const ActiveMarkdownEditor = useMemo(
    () => lazy(getClientDocumentFormat(config.formatId).editor),
    [config.formatId],
  );
  const [content, setContent] = useState(initialContent);
  const [currentPath, setCurrentPath] = useState(config.path);
  const [savedPath, setSavedPath] = useState(config.path);
  const [branch, setBranch] = useState(config.branch);
  // Tracks whether the edit branch exists on the forge yet. Starts from the
  // server's check and flips true once a save creates the branch — drives the
  // Cancel target so it never links to a not-yet-created branch (#121).
  const [branchExists, setBranchExists] = useState(config.branchExists);
  const [status, setStatus] = useState<string | null>(null);
  // Uncommitted-to-Forgejo changes (#162). Distinct from a local draft being
  // saved: autosave persists a draft without committing, so the editor stays
  // "uncommitted" until an explicit Save/Cmd-S. Drives the dirty dot, the Save
  // gate, and the unload guard.
  const [uncommitted, setUncommitted] = useState(false);
  const [pathDirty, setPathDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autosave] = useState(() => readAutosave(config.username));
  // A local draft found on mount that differs from the loaded file — offered for
  // restore (don't silently override the committed file).
  const [pendingDraft, setPendingDraft] = useState<EditorDraft | null>(null);
  const lastReasonRef = useRef<"manual" | "command" | "autosave">("manual");
  const [mode, setMode] = useState<"rich" | "source">(() => readEditorMode(config.username));
  const [documentTheme] = useState<DocumentThemeId>(() => readDocumentTheme(config.username));
  const [documentContext, setDocumentContext] = useState<DocumentContext | null>(null);
  const [documentContextReady, setDocumentContextReady] = useState(config.formatId !== COFLAT_FORMAT_ID);
  const [coflatRefs, setCoflatRefs] = useState<CoflatLocalRefs | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const editorRef = useRef<MountedEditor | null>(null);
  const outlineUnsubscribeRef = useRef<(() => void) | null>(null);
  const branchRef = useRef(branch);
  const currentPathRef = useRef(currentPath);
  const savedPathRef = useRef(savedPath);
  branchRef.current = branch;
  currentPathRef.current = currentPath;
  savedPathRef.current = savedPath;

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!uncommitted && !pathDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [uncommitted, pathDirty]);

  // Offer a local draft from a previous session if it differs from the loaded
  // file (#162). Runs once on mount; the banner lets the user restore or discard
  // so the committed file is never silently overwritten.
  useEffect(() => {
    const draft = readDraft(config.owner, config.repo, config.branch, config.path);
    if (draft && draft.source !== initialContent) setPendingDraft(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      outlineUnsubscribeRef.current?.();
      outlineUnsubscribeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (config.formatId !== COFLAT_FORMAT_ID) {
      setDocumentContext(null);
      setCoflatRefs(null);
      setDocumentContextReady(true);
      return;
    }
    let cancelled = false;
    setDocumentContextReady(false);
    void loadCoflatRefs({
      source: initialContent,
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      branchExists: config.branchExists,
      path: config.path,
    }).then((refs) => {
      if (cancelled) return;
      setCoflatRefs(refs);
      setDocumentContext(
        coflatDocumentContext(
          {
            source: initialContent,
            owner: config.owner,
            repo: config.repo,
            branch: config.branch,
            branchExists: config.branchExists,
            path: config.path,
          },
          refs,
        ),
      );
      setDocumentContextReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [config.branch, config.formatId, config.owner, config.path, config.repo, initialContent]);

  useEffect(() => {
    if (!coflatRefs) return;
    const root = document.getElementById("web-editor-root");
    if (!root) return;
    let queued = false;
    const reconcile = () => {
      queued = false;
      resolveUnresolvedCoflatReferences(root, coflatRefs);
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(reconcile);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [coflatRefs]);

  const branchForWrite = useCallback(() => {
    const current = branchRef.current;
    if (current && current !== "main") return current;
    return `${userBranchPrefix(config.username)}wip-${shortId()}`;
  }, [config.username]);

  // Autosave (#162): persist the in-progress source to a local draft. No
  // network, no commit, no branch creation — so it can never clobber the
  // selection (#161) or produce commit noise. Synchronous, so it returns ok.
  const saveDraft = useCallback(
    (source: string): { ok: true } => {
      writeDraft(config.owner, config.repo, config.branch, config.path, { source, baseSha: null, savedAt: Date.now() });
      return { ok: true };
    },
    [config.owner, config.repo, config.branch, config.path],
  );

  // Explicit commit (Save / Cmd-S): the real Forgejo write. Creates the edit
  // branch lazily on this first commit, reconciles the server-injected
  // frontmatter id into the editor, and clears the local draft on success.
  const commitSource = useCallback(
    async (source: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const writeBranch = branchForWrite();
      const nextPath = currentPathRef.current.trim();
      const previousPath = savedPathRef.current;
      if (!nextPath.endsWith(".md")) return { ok: false, error: "path must end with .md" };
      try {
        const result = await api.putFile(
          config.owner,
          config.repo,
          nextPath,
          source,
          writeBranch,
          previousPath !== nextPath ? previousPath : undefined,
        );
        // Reconcile the server's frontmatter id into the controlled editor. This
        // now happens only on an explicit commit (rare), never every autosave
        // tick — so it no longer resets the doc and clobbers the selection (#161).
        if (result.content !== undefined) setContent(result.content);
        setBranch(result.branch);
        setBranchExists(true);
        setSavedPath(nextPath);
        setCurrentPath(nextPath);
        setPathDirty(false);
        setUncommitted(false);
        clearDraft(config.owner, config.repo, config.branch, config.path);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof ApiError ? err.message : "save failed" };
      }
    },
    [branchForWrite, config.owner, config.repo, config.branch, config.path],
  );

  // Route Coflat saves by reason (#162): autosave → local draft (or nothing when
  // disabled, #158); manual/command (Save button, Cmd-S) → real commit.
  const saveHandler = useMemo<EditorSaveHandler>(
    () => ({
      autosaveDebounceMs: autosave.intervalMs,
      isBusy: () => busy,
      save: (payload) => {
        lastReasonRef.current = payload.reason;
        if (payload.reason !== "autosave") return commitSource(payload.source);
        if (!autosave.enabled) return Promise.resolve({ ok: true as const });
        return Promise.resolve(saveDraft(payload.source));
      },
    }),
    [autosave.intervalMs, autosave.enabled, busy, saveDraft, commitSource],
  );

  const statusEvents = useMemo<EditorStatusEvents>(
    () => ({
      onSaveStart: () => {
        setBusy(true);
        setStatus(null);
      },
      onSaveSucceeded: () => {
        setBusy(false);
        if (lastReasonRef.current !== "autosave") setStatus(`committed · ${nowTime()}`);
        // Autosave off still fires a Coflat tick that the handler no-ops; don't
        // claim a "draft saved" when nothing was persisted (#158).
        else if (autosave.enabled) setStatus(`draft saved · ${nowTime()}`);
      },
      onSaveFailed: (event) => {
        setBusy(false);
        setStatus(`save failed: ${event.error}`);
      },
      onAssetUploading: (event) => setStatus(`uploading ${event.file.name}...`),
      onAssetUploadSucceeded: (event) => setStatus(`uploaded ${event.path}`),
      onAssetUploadFailed: (event) => setStatus(`upload failed: ${event.error}`),
    }),
    [autosave.enabled],
  );

  const assetUploader = useMemo<EditorAssetUploader>(
    () => ({
      accept: (file) =>
        file.size > MAX_ASSET_BYTES ? { reject: `asset exceeds ${MAX_ASSET_DISPLAY}` } : null,
      upload: async (file) => {
        const writeBranch = branchForWrite();
        try {
          const result = await api.uploadAsset(config.owner, config.repo, writeBranch, file);
          setBranch(writeBranch);
          return { path: result.path };
        } catch (err) {
          return { error: err instanceof ApiError ? err.message : "upload failed" };
        }
      },
    }),
    [branchForWrite, config.owner, config.repo],
  );

  const autocompleteSources = useMemo<readonly EditorAutocompleteSource[]>(
    () =>
      // `[@id]` cross-refs only resolve in Coflat workspaces; for
      // forgejo-passthrough the syntax is plain text, so don't offer it.
      config.formatId !== COFLAT_FORMAT_ID
        ? []
        : [
            {
              trigger: "[@",
              suggest: async (prefix, env) => {
                if (env.signal.aborted) return [];
                try {
                  const result = await api.suggest(config.owner, config.repo, { trigger: "[@", prefix, limit: 10 });
                  return result.suggestions;
                } catch (_err) {
                  return [];
                }
              },
            },
          ],
    [config.owner, config.repo, config.formatId],
  );

  const save = useCallback(() => {
    if (busy) return;
    // Content changed: route through Coflat so it flushes pending edits, fires
    // the status events, and commits via the manual-reason handler.
    if (uncommitted) {
      void editorRef.current?.triggerSave("manual");
      return;
    }
    // Path-only rename: content is unchanged so Coflat won't fire a save — commit
    // the current content directly to carry the rename through.
    if (!pathDirty) return;
    setBusy(true);
    setStatus(null);
    lastReasonRef.current = "manual";
    void commitSource(content).then((result) => {
      setBusy(false);
      setStatus(result.ok ? `committed · ${nowTime()}` : `save failed: ${result.error}`);
    });
  }, [busy, content, uncommitted, pathDirty, commitSource]);

  const restoreDraft = useCallback(() => {
    if (!pendingDraft) return;
    setContent(pendingDraft.source);
    setUncommitted(true);
    setStatus(`restored local draft · ${nowTime()}`);
    setPendingDraft(null);
  }, [pendingDraft]);

  const discardDraft = useCallback(() => {
    clearDraft(config.owner, config.repo, config.branch, config.path);
    setPendingDraft(null);
  }, [config.owner, config.repo, config.branch, config.path]);

  const openPullRequest = useCallback(
    async (directMerge: boolean) => {
      if (!branch || branch === "main") {
        setStatus("nothing on this branch to merge or review");
        return;
      }
      setBusy(true);
      setStatus(null);
      try {
        const pr = await api.openPull(config.owner, config.repo, {
          head: branch,
          title: branch,
          body: `Update ${currentPath}`,
        });
        if (directMerge) {
          await api.mergePull(config.owner, config.repo, pr.number, { Do: "squash", force: true });
          setStatus("merged to main");
          window.location.href = `/${urlPath(config.owner)}/${urlPath(config.repo)}/src/branch/main/${urlPath(currentPath)}`;
          return;
        }
        window.location.href = `/${urlPath(config.owner)}/${urlPath(config.repo)}/pulls/${pr.number}`;
      } catch (err) {
        setStatus(err instanceof ApiError ? err.message : "Open pull request failed");
      } finally {
        setBusy(false);
      }
    },
    [branch, config.owner, config.repo, currentPath],
  );

  const readerClass =
    documentTheme === "blueprint-book"
      ? "web-editor-shell cf-theme-scope cf-theme-blueprint-book"
      : "web-editor-shell cf-theme-scope";

  // Cancel returns to the file as it's actually viewable: the edit branch only
  // once it exists, otherwise main (the branch the edit derives from). Never a
  // not-yet-created branch (#121). Uses the last-saved path so discarded
  // in-progress renames don't point at a path that was never written.
  const cancelBranch = branchExists && branch !== "main" ? branch : "main";
  const cancelHref = `/${urlPath(config.owner)}/${urlPath(config.repo)}/src/branch/${urlPath(cancelBranch)}/${urlPath(savedPath)}`;

  return (
    <div className={readerClass}>
      {pendingDraft ? (
        <div className="editor-draft-banner" data-testid="editor-draft-banner" role="status">
          <span>Unsaved local draft from {new Date(pendingDraft.savedAt).toLocaleString()}.</span>
          <button type="button" className="button small" data-testid="editor-draft-restore" onClick={restoreDraft}>
            Restore
          </button>
          <button type="button" className="button small subtle" data-testid="editor-draft-discard" onClick={discardDraft}>
            Discard
          </button>
        </div>
      ) : null}
      <div className="web-editor-main">
        <Suspense fallback={<div className="web-editor-loading">Loading editor...</div>}>
          {documentContextReady ? (
            <ActiveMarkdownEditor
              key={savedPath}
              value={content}
              mode={mode}
              from={currentPath}
              documentContext={documentContext ?? undefined}
              testId="editor"
              onReady={(editor) => {
                outlineUnsubscribeRef.current?.();
                editorRef.current = editor;
                setOutline(editor.outline.get());
                outlineUnsubscribeRef.current = editor.outline.subscribe(setOutline);
              }}
              onChange={(next) => {
                setContent(next);
                setUncommitted(true);
                setStatus(null);
              }}
              saveHandler={saveHandler}
              statusEvents={statusEvents}
              assetUploader={assetUploader}
              autocompleteSources={autocompleteSources}
            />
          ) : (
            <div className="web-editor-loading">Loading editor...</div>
          )}
        </Suspense>
        <aside className="web-editor-outline" aria-label="Outline">
          <h2>Outline</h2>
          {outline.length ? (
            <ol>
              {outline.map((entry) => (
                <li key={entry.key} style={{ paddingLeft: `${Math.max(0, entry.level - 1) * 12}px` }}>
                  <button type="button" onClick={() => editorRef.current?.scrollToLine(entry.line, { center: true })}>
                    {entry.number ? `${entry.number} ` : ""}
                    {entry.text}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p>No headings.</p>
          )}
        </aside>
      </div>
      {renderStatusbar(
        <footer className="web-editor-statusbar" data-testid="statusbar">
          <input
            className="web-editor-path"
            data-testid="editor-path-input"
            aria-label="File path"
            spellCheck={false}
            value={currentPath}
            disabled={busy}
            onChange={(e) => {
              setCurrentPath(e.target.value);
              setPathDirty(e.target.value.trim() !== savedPath);
              setStatus(null);
            }}
          />
          <span className="dirty-dot" hidden={!uncommitted && !pathDirty}>
            *
          </span>
          <span className="web-editor-status">{status ?? ""}</span>
          <span data-testid="active-branch-name" className="web-editor-branch">
            {branch}
          </span>
          {config.formatId === COFLAT_FORMAT_ID ? (
            <button type="button" data-testid="editor-mode-toggle" onClick={() => setMode((value) => (value === "rich" ? "source" : "rich"))}>
              {mode === "rich" ? "Source" : "Rich"}
            </button>
          ) : null}
          <button type="button" onClick={save} disabled={(!uncommitted && !pathDirty) || busy}>
            Save
          </button>
          {branch && branch !== "main" ? (
            <>
              {config.role === "admin" ? (
                <button type="button" data-testid="merge-branch" onClick={() => void openPullRequest(true)} disabled={busy}>
                  Merge to main
                </button>
              ) : null}
              <button type="button" data-testid="open-pull-request" onClick={() => void openPullRequest(false)} disabled={busy}>
                Open PR
              </button>
            </>
          ) : null}
          <a className="web-editor-cancel" data-testid="editor-cancel" href={cancelHref}>
            Cancel
          </a>
        </footer>,
      )}
    </div>
  );
}

// Render the editor status controls into the app status bar so the page has a
// single bottom bar; fall back to in-place rendering if the shell slot is
// absent (tests, standalone mounts).
const statusbarSlot = document.querySelector(".app-statusbar .status-editor-slot");

function renderStatusbar(statusbar: ReactNode): ReactNode {
  return statusbarSlot ? createPortal(statusbar, statusbarSlot) : statusbar;
}

const { config, content } = readConfig();
const root = document.getElementById("web-editor-root");
if (!root) throw new Error("missing #web-editor-root");
createRoot(root).render(
  <StrictMode>
    <WebEditor config={config} initialContent={content} />
  </StrictMode>,
);
