import type {
  AssetUploader as EditorAssetUploader,
  AutocompleteSource as EditorAutocompleteSource,
  SaveHandler as EditorSaveHandler,
  EditorSourcePosition,
  StatusEvents as EditorStatusEvents,
  EditorDocumentChange,
  OutlineEntry,
  RequestHandler,
  EditorScrollToSourcePositionOptions,
} from "@chaoxu/coflat";
import {
  formatUploadedAssetMarkdown,
} from "@chaoxu/coflat";
import {
  createReaderCitationClusterPreviewBody,
  type DocumentContext,
  type FileEntry,
  type FileSystem,
  hydrateReaderHoverPreviews,
  hydrateReferences,
} from "@chaoxu/coflat/reader";
import type { ReactNode, Ref } from "react";
import { createRef, lazy, StrictMode, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { type AssetPreviewPaths, pdfDisplaySuffix, previewAssetPath } from "../../shared/asset-previews";
import {
  userBranchPrefix,
} from "../../shared/conventions";
import { DEFAULT_DOCUMENT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";
import {
  documentRailModel,
} from "../../shared/document-rail";
import { isEditableTextFile } from "../../shared/file-kind";
import { iconMarkup, lucideIcons } from "../../shared/lucide";
import { repoBranchFileHref, repoHref } from "../../shared/url";
import { ApiError, api, type LocalAnnotation } from "./api";
import { createBibliographyPicker } from "./bibliography-picker";
import {
  LOCAL_ANNOTATION_CLICK_EVENT,
  loadCoflatDocumentContext,
  localAnnotationIdFromRef,
} from "./coflat-document-context";
import { renderDocumentRail } from "./document-rail-dom";
import type { DocumentThemeId } from "./document-theme";
import { readAutosave, readDocumentTheme, readEditorMode, writeEditorMode } from "./document-theme";
import type { MountedEditor } from "./editor";
import {
  IncrementalSourceCache,
  liveEditorSource,
  routeEditorChangeHandlers,
} from "./editor-change-routing";
import { clearDraft, type EditorDraft, readDraft, restoredDraftFreshness, writeDraft } from "./editor-draft";
import { currentDocumentSuggestions, fetchRawRepoFile, nowTime, rawRepoFileHref, relativeAssetPath, saveState, shortId, sizeAssetRejection, toast } from "./web-editor-helpers";
import { LocalAnnotationsDrawer, useLocalAnnotationsController } from "./web-editor-local-annotations";
import "@chaoxu/coflat/style.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

interface EditorConfig {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  branchExists: boolean;
  readBranch: string;
  username: string;
  role: "admin" | "write" | "read";
  formatId: DocumentFormatId;
  baseSha: string | null;
  sourceSha: string | null;
  resetEditBranch: boolean;
  // 'branch' (hosted default): edits land on a lazily-created `wip-` branch and
  // expose Open-PR / Merge affordances. 'direct' (local Workbench): edits write
  // the current ref in place — no invented branch, PR/Merge only when the
  // backend reports it can open one.
  writeMode: "branch" | "direct";
  // Whether opening a PR is available (hosted: always; local: only at Tier 2
  // with a configured remote). Gates the Open-PR / Merge-to-main affordances.
  canOpenPull: boolean;
  // Optional local Workbench origin scope. Hosted pages omit it, preserving the
  // legacy owner/repo/branch/path draft key.
  originId?: string;
  mathMacros: Record<string, string>;
  bibliography?: string;
  csl?: string;
  assetPreviewPaths: AssetPreviewPaths;
}

interface EditorRepoConfigPayload {
  mathMacros?: Record<string, string>;
  bibliography?: string;
  csl?: string;
}

interface ValidationSummary {
  brokenRefs: number;
  duplicateLabels: number;
  orphanLabels: number;
}

export interface WebEditorPreviewEvent {
  source: string;
  branch: string;
  branchExists: boolean;
  path: string;
  dirty: boolean;
  sourcePosition: EditorSourcePosition | null;
}

type WebEditorSourcePosition = EditorSourcePosition | EditorScrollToSourcePositionOptions;
const MODE_SWITCH_VIEWPORT_RATIO = 0.5;
const ActiveMarkdownEditor = lazy(() => import("./editor").then((m) => ({ default: m.MarkdownEditor })));

function insertAnchorIntoSource(source: string, anchor: string): string {
  if (!source) return `${anchor}\n`;
  if (source.includes(anchor)) return source;
  if (source.endsWith("\n\n")) return `${source}${anchor}\n`;
  if (source.endsWith("\n")) return `${source}\n${anchor}\n`;
  return `${source} ${anchor}`;
}

export interface WebEditorCallbacks {
  onDirtyChange?: (dirty: boolean) => void;
}

export interface WebEditorHandle {
  preview: () => WebEditorPreviewEvent;
  scrollToSourcePosition: (position: WebEditorSourcePosition) => boolean;
  setReadOnly: (readOnly: boolean) => void;
}

export interface WebEditorMount {
  root: Root;
  ready: Promise<void>;
  preview: () => WebEditorPreviewEvent | null;
  scrollToSourcePosition: (position: WebEditorSourcePosition) => boolean;
  setReadOnly: (readOnly: boolean) => void;
}

function readConfig(): { config: EditorConfig; content: string } {
  const mount = document.getElementById("web-editor-root");
  const payload = document.getElementById("web-editor-content");
  const repoConfigScript = document.getElementById("web-editor-repo-config");
  const assetPreviewsScript = document.getElementById("web-editor-asset-previews");
  if (!mount || !payload) throw new Error("missing web editor mount payload");
  const repoConfig = repoConfigScript?.textContent
    ? JSON.parse(repoConfigScript.textContent) as EditorRepoConfigPayload
    : {};
  const assetPreviewPaths = assetPreviewsScript?.textContent
    ? JSON.parse(assetPreviewsScript.textContent) as AssetPreviewPaths
    : {};
  return {
    config: {
      owner: mount.dataset.owner ?? "",
      repo: mount.dataset.repo ?? "",
      path: mount.dataset.path ?? "",
      branch: mount.dataset.branch ?? "",
      branchExists: mount.dataset.branchExists !== "0",
      readBranch: mount.dataset.readBranch ?? "main",
      username: mount.dataset.username ?? "",
      role: (mount.dataset.role ?? "read") as EditorConfig["role"],
      formatId: (mount.dataset.formatId as DocumentFormatId) ?? DEFAULT_DOCUMENT_FORMAT_ID,
      baseSha: mount.dataset.baseSha || null,
      sourceSha: mount.dataset.sourceSha || null,
      resetEditBranch: mount.dataset.resetEditBranch === "1",
      writeMode: mount.dataset.writeMode === "direct" ? "direct" : "branch",
      canOpenPull: mount.dataset.canOpenPull !== "0",
      ...(mount.dataset.originId ? { originId: mount.dataset.originId } : {}),
      mathMacros: repoConfig.mathMacros ?? {},
      assetPreviewPaths,
      ...(repoConfig.bibliography ? { bibliography: repoConfig.bibliography } : {}),
      ...(repoConfig.csl ? { csl: repoConfig.csl } : {}),
    },
    content: JSON.parse(payload.textContent || "\"\"") as string,
  };
}

function WebEditor({
  config,
  initialContent,
  callbacks = {},
  handleRef,
  onEditorReady,
  initialReadOnly,
}: {
  config: EditorConfig;
  initialContent: string;
  callbacks?: WebEditorCallbacks;
  handleRef?: Ref<WebEditorHandle>;
  onEditorReady?: () => void;
  initialReadOnly?: boolean;
}) {
  const [content, setContent] = useState(initialContent);
  const [contextSource, setContextSource] = useState(initialContent);
  const [currentPath, setCurrentPath] = useState(config.path);
  const [savedPath, setSavedPath] = useState(config.path);
  const [branch, setBranch] = useState(config.branch);
  const [savedReadBranch, setSavedReadBranch] = useState(config.readBranch);
  // Tracks whether the edit branch exists on the forge yet. Starts from the
  // server's check and flips true once a save creates the branch — drives the
  // Cancel target so it never links to a not-yet-created branch (#121).
  const [branchExists, setBranchExists] = useState(config.branchExists);
  // Persistent save-state (#184): the inline indicator shows Unsaved/Saving/Saved
  // from these + busy/uncommitted/pathDirty. Discrete events (merge, PR, upload,
  // errors) go to toasts instead, so constant saves don't spam.
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
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
  const [readOnly, setReadOnly] = useState(Boolean(initialReadOnly));
  const [documentTheme] = useState<DocumentThemeId>(() => readDocumentTheme(config.username));
  const [documentContext, setDocumentContext] = useState<DocumentContext | null>(null);
  const [documentContextReady, setDocumentContextReady] = useState(false);
  const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const editorRef = useRef<MountedEditor | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const assetInputRef = useRef<HTMLInputElement | null>(null);
  const sourceCacheRef = useRef(new IncrementalSourceCache(initialContent));
  const contextSourceTimerRef = useRef<number | null>(null);
  const outlineUnsubscribeRef = useRef<(() => void) | null>(null);
  const cursorUnsubscribeRef = useRef<(() => void) | null>(null);
  const lastCursorFromRef = useRef<number | null>(null);
  const branchRef = useRef(branch);
  const branchExistsRef = useRef(branchExists);
  const savedReadBranchRef = useRef(savedReadBranch);
  const currentPathRef = useRef(currentPath);
  const savedPathRef = useRef(savedPath);
  const savedShaRef = useRef<string | null | undefined>(config.baseSha);
  const sourceShaRef = useRef<string | undefined>(config.sourceSha ?? undefined);
  const resetEditBranchRef = useRef(config.resetEditBranch);
  const draftScope = useMemo(() => config.originId ? { originId: config.originId } : undefined, [config.originId]);
  const contextLoadedRef = useRef(false);
  const localAnnotationsEnabled = config.writeMode === "direct";
  branchRef.current = branch;
  branchExistsRef.current = branchExists;
  savedReadBranchRef.current = savedReadBranch;
  currentPathRef.current = currentPath;
  savedPathRef.current = savedPath;

  useEffect(() => {
    callbacks.onDirtyChange?.(uncommitted || pathDirty);
  }, [callbacks, pathDirty, uncommitted]);

  // Reveal the editor's overlay scrollbar only while actively scrolling, then let
  // it fade out (the .is-scrolling rule in cosheaf-web.css). A capturing listener
  // catches scroll from CodeMirror's inner .cm-scroller, since scroll doesn't bubble.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let timer: number | undefined;
    const onScroll = () => {
      shell.classList.add("is-scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => shell.classList.remove("is-scrolling"), 700);
    };
    shell.addEventListener("scroll", onScroll, true);
    return () => {
      shell.removeEventListener("scroll", onScroll, true);
      window.clearTimeout(timer);
    };
  }, []);

  useImperativeHandle(handleRef, () => ({
    preview: () => ({
      source: liveEditorSource(editorRef.current, content),
      branch: branchRef.current || config.branch,
      branchExists: branchExistsRef.current,
      path: currentPathRef.current.trim() || config.path,
      dirty: uncommitted || pathDirty,
      sourcePosition: editorRef.current?.getVisibleSourcePosition({ viewportRatio: MODE_SWITCH_VIEWPORT_RATIO }) ?? null,
    }),
    scrollToSourcePosition: (position) => {
      editorRef.current?.scrollToSourcePosition(position);
      return Boolean(editorRef.current);
    },
    setReadOnly,
  }), [config.branch, config.path, content, pathDirty, uncommitted]);

  const setEditorMode = useCallback((next: "rich" | "source") => {
    setMode(next);
    writeEditorMode(next, config.username);
  }, [config.username]);

  const setEditorContent = useCallback((next: string) => {
    sourceCacheRef.current.reset(next);
    setContent(next);
    setContextSource(next);
  }, []);

  const scheduleContextSourceSync = useCallback(() => {
    if (contextSourceTimerRef.current !== null) window.clearTimeout(contextSourceTimerRef.current);
    contextSourceTimerRef.current = window.setTimeout(() => {
      contextSourceTimerRef.current = null;
      setContextSource(sourceCacheRef.current.source());
    }, 700);
  }, []);

  const handleEditorStringChange = useCallback((next: string) => {
    setEditorContent(next);
    setUncommitted(true);
    setSaveError(null);
  }, [setEditorContent]);

  const handleCoflatDocumentChange = useCallback((change: EditorDocumentChange) => {
    // Keep Coflat's hot edit path metadata-only. Operations that require source
    // text (save/upload/autocomplete/PR) read from the mounted editor handle.
    // The document-context source is refreshed from an incremental Text cache
    // after typing pauses, without calling editor.getDoc().
    sourceCacheRef.current.apply(change);
    scheduleContextSourceSync();
    setUncommitted(true);
    setSaveError(null);
  }, [scheduleContextSourceSync]);

  useEffect(
    () => () => {
      if (contextSourceTimerRef.current !== null) window.clearTimeout(contextSourceTimerRef.current);
    },
    [],
  );

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
    const draft = readDraft(config.owner, config.repo, config.branch, config.path, draftScope);
    if (draft && (draft.source !== initialContent || (draft.path && draft.path !== config.path))) setPendingDraft(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      outlineUnsubscribeRef.current?.();
      outlineUnsubscribeRef.current = null;
      cursorUnsubscribeRef.current?.();
      cursorUnsubscribeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    if (!contextLoadedRef.current) setDocumentContextReady(false);
    const sourceVersion = sourceCacheRef.current.version();
    const payload = {
      source: contextSource,
      owner: config.owner,
      repo: config.repo,
      branch,
      branchExists,
      path: currentPath.trim() || config.path,
      mathMacros: config.mathMacros,
      assetPreviewPaths: config.assetPreviewPaths,
      ...(config.bibliography ? { bibliography: config.bibliography } : {}),
      ...(config.csl ? { csl: config.csl } : {}),
    };
    void loadCoflatDocumentContext(payload).then((ctx) => {
      if (cancelled || !sourceCacheRef.current.isCurrent(sourceVersion)) return;
      setDocumentContext(ctx);
      contextLoadedRef.current = true;
      setDocumentContextReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [branch, branchExists, config.assetPreviewPaths, config.bibliography, config.csl, config.mathMacros, config.owner, config.path, config.repo, contextSource, currentPath]);

  useEffect(() => {
    let cancelled = false;
    void api.validation(config.owner, config.repo).then((validation) => {
      if (cancelled) return;
      setValidationSummary({
        brokenRefs: validation.broken_refs.length,
        duplicateLabels: validation.duplicate_xrefs.length,
        orphanLabels: validation.orphan_labels.length,
      });
    }).catch(() => {
      if (!cancelled) setValidationSummary(null);
    });
    return () => {
      cancelled = true;
    };
  }, [config.owner, config.repo]);

  useEffect(() => {
    if (!documentContext) return;
    const root = document.getElementById("web-editor-root");
    if (!root) return;
    let queued = false;
    const cleanupHoverPreviews = hydrateReaderHoverPreviews(root, {
      source: contextSource,
      context: documentContext,
      previewForReference: (key) => createReaderCitationClusterPreviewBody(key, documentContext),
    });
    const reconcile = () => {
      queued = false;
      hydrateReferences(root, documentContext, {
        documentPath: currentPath.trim() || config.path,
        source: contextSource,
        surface: "editor",
      });
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
      cleanupHoverPreviews();
    };
  }, [config.path, contextSource, currentPath, documentContext]);

  const branchForWrite = useCallback(() => {
    const current = branchRef.current;
    // Direct mode (local Workbench): write the current ref in place — never
    // invent a `wip-` branch. The local backend aliases all refs to the working
    // tree, so this is just "save to disk on the checked-out branch".
    if (config.writeMode === "direct") return current || config.branch || "main";
    if (current && current !== "main") return current;
    return `${userBranchPrefix(config.username)}wip-${shortId()}`;
  }, [config.username, config.writeMode, config.branch]);

  const fileSystem = useMemo<FileSystem | undefined>(() => {
    const readBranch = () => branchRef.current || config.branch || "main";
    const readExistingBranch = () => branchExistsRef.current ? readBranch() : savedReadBranchRef.current;
    const displayAssetPath = (path: string): string => previewAssetPath(path, config.assetPreviewPaths);
    const readFile = async (path: string): Promise<string> =>
      fetchRawRepoFile(config.owner, config.repo, readExistingBranch(), path).then((res) => res.text());
    const readFileBinary = async (path: string): Promise<Uint8Array> => {
      const buffer = await fetchRawRepoFile(config.owner, config.repo, readExistingBranch(), path).then((res) => res.arrayBuffer());
      return new Uint8Array(buffer);
    };
    const unsupportedWrite = async (): Promise<void> => {
      throw new Error("Repository writes must go through Cosheaf save or upload actions.");
    };
    return {
      listTree: async (): Promise<FileEntry> => ({ name: "", path: "", isDirectory: true, children: [] }),
      readFile,
      writeFile: unsupportedWrite,
      createFile: unsupportedWrite,
      exists: async (path: string): Promise<boolean> => {
        try {
          await fetchRawRepoFile(config.owner, config.repo, readExistingBranch(), path);
          return true;
        } catch (_error) {
          return false;
        }
      },
      renameFile: unsupportedWrite,
      createDirectory: unsupportedWrite,
      deleteFile: unsupportedWrite,
      writeFileBinary: unsupportedWrite,
      readFileBinary,
      resolveAssetUrl: (path: string, options?: { purpose?: "source" | "display" }): string => {
        const display = options?.purpose !== "source";
        const assetPath = display ? displayAssetPath(path) : path;
        const url = rawRepoFileHref(config.owner, config.repo, readExistingBranch(), assetPath);
        // A PDF figure with no sibling raster renders to a PNG for display.
        return display ? `${url}${pdfDisplaySuffix(assetPath)}` : url;
      },
    };
  }, [config.assetPreviewPaths, config.branch, config.formatId, config.owner, config.repo]);

  // Autosave (#162): persist the in-progress source to a local draft. No
  // network, no commit, no branch creation — so it can never clobber the
  // selection (#161) or produce commit noise. Synchronous, so it returns ok.
  const saveDraft = useCallback(
    (source: string): { ok: true } => {
      const baseSha = savedShaRef.current;
      const sourceSha = sourceShaRef.current;
      writeDraft(config.owner, config.repo, branchRef.current, savedPathRef.current, {
        source,
        path: currentPathRef.current,
        ...(baseSha === undefined ? {} : { baseSha, baseShaKnown: true as const }),
        ...(sourceSha === undefined ? {} : { sourceSha, sourceShaKnown: true as const }),
        savedAt: Date.now(),
      }, draftScope);
      return { ok: true };
    },
    [config.owner, config.repo, draftScope],
  );

  // Explicit commit (Save / Cmd-S): the real Forgejo write. Creates the edit
  // branch lazily on this first commit, reconciles the server-injected
  // frontmatter id into the editor, and clears the local draft on success.
  const commitSource = useCallback(
    async (source: string): Promise<{ ok: true; branch: string; path: string } | { ok: false; error: string }> => {
      const writeBranch = branchForWrite();
      const nextPath = currentPathRef.current.trim();
      const previousPath = savedPathRef.current;
      // Markdown or any supported text file (#178) — mirror the server's
      // isEditableTextFile gate so an in-editor rename to .bib/.txt/.tex isn't
      // rejected client-side when the backend would accept it.
      if (!isEditableTextFile(nextPath)) return { ok: false, error: "path must be a Markdown or text file (e.g. .md, .bib, .txt)" };
      try {
        const result = await api.putFile(
          config.owner,
          config.repo,
          nextPath,
          source,
          writeBranch,
          previousPath !== nextPath ? previousPath : undefined,
          savedShaRef.current,
          sourceShaRef.current,
          resetEditBranchRef.current,
        );
        // Reconcile the server's frontmatter id into the controlled editor. This
        // now happens only on an explicit commit (rare), never every autosave
        // tick — so it no longer resets the doc and clobbers the selection (#161).
        const savedSource = result.content ?? source;
        setEditorContent(savedSource);
        setBranch(result.branch);
        setBranchExists(true);
        setSavedReadBranch(result.branch);
        setSavedPath(nextPath);
        savedShaRef.current = result.sha;
        sourceShaRef.current = undefined;
        resetEditBranchRef.current = false;
        setCurrentPath(nextPath);
        setPathDirty(false);
        setUncommitted(false);
        clearDraft(config.owner, config.repo, config.branch, config.path, draftScope);
        if (previousPath !== nextPath) clearDraft(config.owner, config.repo, result.branch, previousPath, draftScope);
        clearDraft(config.owner, config.repo, result.branch, nextPath, draftScope);
        return { ok: true, branch: result.branch, path: nextPath };
      } catch (err) {
        return { ok: false, error: err instanceof ApiError ? err.message : "save failed" };
      }
    },
    [branchForWrite, config.owner, config.repo, config.branch, config.path, draftScope, setEditorContent],
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
        setSaveError(null);
      },
      onSaveSucceeded: () => {
        setBusy(false);
        // A real commit updates the persistent "Saved · HH:MM" state; an autosave
        // tick (local draft, or a no-op when autosave is off) leaves the state as
        // "Unsaved changes" since the branch still lags (#158/#162).
        if (lastReasonRef.current !== "autosave") setLastSavedAt(nowTime());
      },
      onSaveFailed: (event) => {
        setBusy(false);
        setSaveError(event.error);
        toast(`Save failed: ${event.error}`, "error");
      },
      // Asset upload is a discrete action → toast, not the save indicator.
      onAssetUploading: () => {},
      onAssetUploadSucceeded: (event) => toast(`Uploaded ${event.path}`),
      onAssetUploadFailed: (event) => toast(`Upload failed: ${event.error}`, "error"),
    }),
    [],
  );

  const assetUploader = useMemo<EditorAssetUploader>(
    () => ({
      accept: (file) => {
        const sizeRejection = sizeAssetRejection(file);
        if (sizeRejection) return sizeRejection;
        if (!file.type.startsWith("image/")) return { reject: "paste/drop upload currently accepts images only; use Upload for other files" };
        return null;
      },
      upload: async (file, env) => {
        const writeBranch = branchForWrite();
        try {
          const result = await api.uploadAsset(config.owner, config.repo, writeBranch, file);
          setBranch(writeBranch);
          setBranchExists(true);
          setSavedReadBranch(writeBranch);
          return { path: relativeAssetPath(env.from ?? (currentPathRef.current.trim() || config.path), result.path) };
        } catch (err) {
          return { error: err instanceof ApiError ? err.message : "upload failed" };
        }
      },
    }),
    [branchForWrite, config.owner, config.path, config.repo],
  );

  const uploadPickedAssets = useCallback(
    async (files: FileList | null) => {
      const picked = Array.from(files ?? []);
      if (picked.length === 0 || busy) return;
      setBusy(true);
      setSaveError(null);
      try {
        const writeBranch = branchForWrite();
        const snippets: string[] = [];
        for (const file of picked) {
          const rejection = sizeAssetRejection(file);
          if (rejection?.reject) {
            toast(`Upload failed: ${rejection.reject}`, "error");
            continue;
          }
          const uploaded = await api.uploadAsset(config.owner, config.repo, writeBranch, file);
          const rel = relativeAssetPath(currentPathRef.current.trim() || config.path, uploaded.path);
          snippets.push(
            formatUploadedAssetMarkdown({
              path: rel,
              name: file.name,
              mimeType: file.type,
            }),
          );
          toast(`Uploaded ${uploaded.path}`);
        }
        if (snippets.length > 0) {
          const source = liveEditorSource(editorRef.current, content);
          const separator = source.length === 0 ? "" : source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
          const next = `${source}${separator}${snippets.join("\n")}\n`;
          setEditorContent(next);
          setUncommitted(true);
          setBranch(writeBranch);
          setBranchExists(true);
          setSavedReadBranch(writeBranch);
        }
      } catch (err) {
        toast(`Upload failed: ${err instanceof ApiError ? err.message : "upload failed"}`, "error");
      } finally {
        setBusy(false);
        if (assetInputRef.current) assetInputRef.current.value = "";
      }
    },
    [branchForWrite, busy, config.owner, config.path, config.repo, content, setEditorContent],
  );

  const requestHandler = useMemo<RequestHandler>(
    () => ({
      openBibliographyPicker: createBibliographyPicker({
        owner: config.owner,
        repo: config.repo,
        branch,
        docPath: currentPath.trim() || config.path,
      }),
    }),
    [config.owner, config.repo, config.path, branch, currentPath],
  );

  const autocompleteSources = useMemo<readonly EditorAutocompleteSource[]>(
    () =>
      [
        {
          trigger: "[@",
          suggest: async (prefix, env) => {
            if (env.signal.aborted) return [];
            const local = currentDocumentSuggestions(liveEditorSource(editorRef.current, content), prefix);
            try {
              const result = await api.suggest(config.owner, config.repo, { trigger: "[@", prefix, branch, limit: 10 });
              const seen = new Set(local.map((suggestion) => suggestion.id));
              return [
                ...local,
                ...result.suggestions.filter((suggestion) => {
                  if (seen.has(suggestion.id)) return false;
                  seen.add(suggestion.id);
                  return true;
                }),
              ].slice(0, 10);
            } catch (_err) {
              return local.slice(0, 10);
            }
          },
        },
      ],
    [branch, config.owner, config.repo, config.formatId, content],
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
    setSaveError(null);
    lastReasonRef.current = "manual";
    void commitSource(liveEditorSource(editorRef.current, content)).then((result) => {
      setBusy(false);
      if (result.ok) setLastSavedAt(nowTime());
      else {
        setSaveError(result.error);
        toast(`Save failed: ${result.error}`, "error");
      }
    });
  }, [busy, content, uncommitted, pathDirty, commitSource]);

  const captureEditorCursor = useCallback(() => {
    const context = editorRef.current?.cursorContext.get();
    if (context) lastCursorFromRef.current = context.from;
  }, []);

  const insertLocalAnnotationAnchor = useCallback((annotation: LocalAnnotation) => {
    captureEditorCursor();
    const source = liveEditorSource(editorRef.current, content);
    if (source.includes(annotation.anchor)) return;
    if (editorRef.current?.insertText) {
      editorRef.current.insertText(annotation.anchor, {
        ...(lastCursorFromRef.current === null ? {} : { position: lastCursorFromRef.current }),
        replaceSelection: false,
      });
      setSaveError(null);
      return;
    }
    const next = insertAnchorIntoSource(source, annotation.anchor);
    setEditorContent(next);
    setUncommitted(true);
    setSaveError(null);
  }, [captureEditorCursor, content, setEditorContent]);

  const removeLocalAnnotationAnchor = useCallback((annotation: LocalAnnotation) => {
    const cached = sourceCacheRef.current.source();
    const source = cached.includes(annotation.anchor) ? cached : liveEditorSource(editorRef.current, content);
    if (!source.includes(annotation.anchor)) return;
    const next = source.split(annotation.anchor).join("");
    sourceCacheRef.current.reset(next);
    editorRef.current?.setDoc(next);
    setEditorContent(next);
    setUncommitted(true);
    setSaveError(null);
  }, [content, setEditorContent]);

  const localAnnotations = useLocalAnnotationsController({
    enabled: localAnnotationsEnabled,
    owner: config.owner,
    repo: config.repo,
    path: currentPath.trim() || config.path,
    captureCursor: captureEditorCursor,
    insertAnchor: insertLocalAnnotationAnchor,
    removeAnchor: removeLocalAnnotationAnchor,
  });
  const focusLocalAnnotation = localAnnotations.focusAnnotation;

  useEffect(() => {
    if (!localAnnotationsEnabled) return;
    const onLocalAnnotationClick = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === "string") focusLocalAnnotation(id);
    };
    const onLocalAnnotationMarkerPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const marker = event.target.closest<HTMLElement>("[data-ref-key]");
      const id = marker ? localAnnotationIdFromRef(marker.dataset.refKey ?? "") : null;
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      focusLocalAnnotation(id);
    };
    const onLocalAnnotationMarkerKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof Element)) return;
      const marker = event.target.closest<HTMLElement>("[data-ref-key]");
      const id = marker ? localAnnotationIdFromRef(marker.dataset.refKey ?? "") : null;
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      focusLocalAnnotation(id);
    };
    window.addEventListener(LOCAL_ANNOTATION_CLICK_EVENT, onLocalAnnotationClick);
    window.addEventListener("mousedown", onLocalAnnotationMarkerPointer, true);
    window.addEventListener("click", onLocalAnnotationMarkerPointer, true);
    window.addEventListener("keydown", onLocalAnnotationMarkerKeydown, true);
    return () => {
      window.removeEventListener(LOCAL_ANNOTATION_CLICK_EVENT, onLocalAnnotationClick);
      window.removeEventListener("mousedown", onLocalAnnotationMarkerPointer, true);
      window.removeEventListener("click", onLocalAnnotationMarkerPointer, true);
      window.removeEventListener("keydown", onLocalAnnotationMarkerKeydown, true);
    };
  }, [focusLocalAnnotation, localAnnotationsEnabled]);

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
    setEditorContent(pendingDraft.source);
    setUncommitted(true);
    setSaveError(null);
    toast("Restored local draft");
    setPendingDraft(null);
  }, [pendingDraft, setEditorContent]);

  const discardDraft = useCallback(() => {
    clearDraft(config.owner, config.repo, config.branch, config.path, draftScope);
    setPendingDraft(null);
  }, [config.owner, config.repo, config.branch, config.path, draftScope]);

  const openPullRequest = useCallback(
    async (directMerge: boolean) => {
      const editor = editorRef.current;
      const needsCommit = uncommitted || pathDirty;
      if ((!branch || branch === "main") && !needsCommit) {
        toast("Nothing on this branch to merge or review");
        return;
      }
      setBusy(true);
      setSaveError(null);
      try {
        // #179: publish what's in the editor, not the last commit. Commit any
        // pending content (or a pending rename) first — this also creates the
        // edit branch on Forgejo, so a never-saved branch no longer makes the
        // PR call fail on a missing head ref. Abort if that commit fails.
        // Gate on the same uncommitted/pathDirty signals the Save button uses
        // (commitSource resets both), so a retry after a failed openPull/merge
        // doesn't re-commit an unchanged doc; take the live source from the
        // editor handle when available so we publish exactly what's on screen.
        // For a path-only rename before the lazy editor is ready, commit the
        // unchanged content state instead of opening a PR for stale contents.
        let reviewBranch = branch;
        let reviewPath = currentPathRef.current.trim();
        if (needsCommit) {
          const committed = await commitSource(liveEditorSource(editor, content));
          if (!committed.ok) {
            setSaveError(committed.error);
            toast(`Save failed: ${committed.error}`, "error");
            return;
          }
          reviewBranch = committed.branch;
          reviewPath = committed.path;
        }
        if (!reviewBranch || reviewBranch === "main") {
          toast("Nothing on this branch to merge or review");
          return;
        }
        const pr = await api.openPull(config.owner, config.repo, {
          head: reviewBranch,
          title: `Update ${reviewPath}`,
          body: `Update ${reviewPath}`,
        });
        if (directMerge) {
          // #180: respect the workspace's branch protection — the editor never
          // force-merges. On success, carry the confirmation across the redirect
          // (#184). On a blocked/failed merge, send the author to the PR (which
          // now exists) with the reason — that's where they review, get approval,
          // or use the explicit admin "Merge anyway" bypass — rather than
          // dead-ending on a toast.
          try {
            await api.mergePull(config.owner, config.repo, pr.number, { Do: "squash" });
            window.location.href = `${repoBranchFileHref(config.owner, config.repo, "main", reviewPath)}?toast=${encodeURIComponent("Merged to main")}&toastKind=success`;
          } catch (mergeErr) {
            const reason = mergeErr instanceof ApiError ? mergeErr.message : "Couldn't merge to main";
            window.location.href = `${repoHref(config.owner, config.repo, `/pulls/${pr.number}`)}?toast=${encodeURIComponent(reason)}&toastKind=error`;
          }
          return;
        }
        // #181: openPull returns the existing PR when one is already open for
        // this branch, so this navigates to it instead of erroring on a dup.
        window.location.href = `${repoHref(config.owner, config.repo, `/pulls/${pr.number}`)}?toast=${encodeURIComponent(`PR #${pr.number} opened`)}&toastKind=success`;
      } catch (err) {
        toast(err instanceof ApiError ? err.message : "Open pull request failed", "error");
      } finally {
        setBusy(false);
      }
    },
    [branch, uncommitted, pathDirty, commitSource, content, config.owner, config.repo],
  );

  const readerClass =
    documentTheme === "blueprint-book"
      ? "web-editor-shell cf-theme-scope cf-theme-blueprint-book"
      : "web-editor-shell cf-theme-scope";

  // Reader/Cancel return to the last saved file as it is actually viewable. For
  // a lazy edit branch, that may still be main until the first successful save.
  // Uses the last-saved path so discarded in-progress renames do not point at a
  // path that was never written.
  const readHref = repoBranchFileHref(config.owner, config.repo, savedReadBranch, savedPath);
  const outlineMathMacros = documentContext?.mathMacros;
  // PR/Merge affordances require the backend to support opening a PR (hosted
  // always; local only at Tier 2). In direct mode without that capability the
  // branch actions are hidden entirely.
  const branchActions = config.canOpenPull && branch && branch !== "main";
  const canDiscardDefaultEditBranch = branchExists && branch === `${userBranchPrefix(config.username)}web-edit`;
  const railModel = documentRailModel({
    mode: "edit",
    readHref,
    editHref: window.location.href,
    controls: false,
    outline: outline.map((entry) => ({
      key: entry.key,
      level: entry.level,
      label: entry.markdown,
      html: (entry as OutlineEntry & { html?: string }).html,
      line: entry.line,
    })),
  });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    renderDocumentRail(
      rail,
      { ...railModel, mathMacros: outlineMathMacros },
      {
        onOutlineItem: (entry) => {
          if (typeof entry.line === "number") editorRef.current?.scrollToLine(entry.line, { center: true });
        },
      },
    );
  }, [outlineMathMacros, railModel]);

  return (
    <div className={readerClass} ref={shellRef}>
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
      <div className="doc-with-toc">
        <div className="doc-main">
          <Suspense fallback={<div className="web-editor-loading">Loading editor...</div>}>
            {documentContextReady ? (
              <ActiveMarkdownEditor
                key={savedPath}
                value={content}
                mode={readOnly ? "rich" : mode}
                readOnly={readOnly}
                from={currentPath}
                documentContext={documentContext ?? undefined}
                fileSystem={fileSystem}
                testId="editor"
                onReady={(editor) => {
                  outlineUnsubscribeRef.current?.();
                  cursorUnsubscribeRef.current?.();
                  editorRef.current = editor;
                  setOutline(editor.outline.get());
                  outlineUnsubscribeRef.current = editor.outline.subscribe(setOutline);
                  lastCursorFromRef.current = editor.cursorContext.get().from;
                  cursorUnsubscribeRef.current = editor.cursorContext.subscribe((context) => {
                    lastCursorFromRef.current = context.from;
                  }, { emitCurrent: true });
                  onEditorReady?.();
                }}
                {...routeEditorChangeHandlers({
                  onStringChange: handleEditorStringChange,
                  onDocumentChange: handleCoflatDocumentChange,
                })}
                saveHandler={saveHandler}
                statusEvents={statusEvents}
                assetUploader={assetUploader}
                autocompleteSources={autocompleteSources}
                requestHandler={requestHandler}
                sidenotesCollapsed={true}
              />
            ) : (
              <div className="web-editor-loading">Loading editor...</div>
            )}
          </Suspense>
        </div>
        <aside ref={railRef} className="web-editor-outline doc-rail" aria-label="Document tools" data-document-rail />
      </div>
      <LocalAnnotationsDrawer controller={localAnnotations} />
      {renderEditorChrome(
        <>
          <span className="status-sep">/</span>
          <input
            ref={pathInputRef}
            className="web-editor-path"
            data-testid="editor-path-input"
            aria-label="Rename file"
            title="Rename file"
            spellCheck={false}
            value={currentPath}
            disabled={readOnly || busy}
            onChange={(e) => {
              const nextPath = e.target.value;
              currentPathRef.current = nextPath;
              setCurrentPath(nextPath);
              setPathDirty(nextPath.trim() !== savedPath);
              setSaveError(null);
            }}
            onKeyDown={(e) => {
              // Esc abandons an in-progress rename, restoring the saved path;
              // Enter commits by blurring (the underlying save picks up pathDirty).
              if (e.key === "Escape") {
                currentPathRef.current = savedPath;
                setCurrentPath(savedPath);
                setPathDirty(false);
                e.currentTarget.blur();
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
          />
          {/* Edit cue so the inline-editable filename is discoverable (#173):
              the pencil focuses + selects the field; clicking the name works too. */}
          <button
            type="button"
            className="web-editor-path-pencil"
            data-testid="editor-path-pencil"
            aria-label="Rename file"
            title="Rename file"
            disabled={readOnly || busy}
            onClick={() => pathInputRef.current?.select()}
          >
            {/* #186: render the shared lucide source (shared/lucide.ts), the same
                node data + markup the server chrome uses — no hand-drawn SVG. The
                markup is hardcoded/trusted (no user input), so inserting it is safe. */}
            <span className="web-editor-path-pencil-icon" dangerouslySetInnerHTML={{ __html: iconMarkup(lucideIcons.pencil, { size: 13 }) }} />
          </button>
          <span className="dirty-dot" hidden={!uncommitted && !pathDirty}>
            *
          </span>
        </>,
        <>
          <span className="web-editor-mode-toggle" aria-label="Editor mode">
            <button
              type="button"
              className={mode !== "source" ? "active" : ""}
              aria-pressed={mode !== "source"}
              onClick={() => setEditorMode("rich")}
            >
              Rich
            </button>
            <button
              type="button"
              className={mode === "source" ? "active" : ""}
              aria-pressed={mode === "source"}
              onClick={() => setEditorMode("source")}
            >
              Source
            </button>
          </span>
          {(() => {
            const actionable = validationSummary ? validationSummary.brokenRefs + validationSummary.duplicateLabels : null;
            const label = actionable === null ? "Problems -" : `Problems ${actionable}`;
            const detail = validationSummary
              ? `${actionable} actionable, ${validationSummary.orphanLabels} unreferenced`
              : "Diagnostics unavailable";
            return (
              <a
                className={`web-editor-problems ${actionable && actionable > 0 ? "has-issues" : ""}`}
                href={repoHref(config.owner, config.repo, "/diagnostics")}
                title={detail}
              >
                {label}
              </a>
            );
          })()}
          {localAnnotations.enabled ? (
            <button
              type="button"
              className="web-editor-annotations-toggle"
              aria-pressed={localAnnotations.open}
              onPointerDown={captureEditorCursor}
              onClick={() => localAnnotations.setOpen((open) => !open)}
            >
              Annotations {localAnnotations.openCount}
            </button>
          ) : null}
          {(() => {
            // Glance-able, paired with the dirty-dot. title surfaces the full error.
            const s = saveState({ busy, saveError, dirty: uncommitted || pathDirty, lastSavedAt });
            return (
              <span
                className={`web-editor-status web-editor-status--${s.cls}`}
                data-testid="editor-save-state"
                title={saveError ?? undefined}
              >
                {s.text}
              </span>
            );
          })()}
          <button type="button" onClick={save} disabled={(!uncommitted && !pathDirty) || busy}>
            Save
          </button>
          <input
            ref={assetInputRef}
            className="web-editor-asset-input"
            data-testid="editor-asset-input"
            type="file"
            multiple
            onChange={(event) => void uploadPickedAssets(event.currentTarget.files)}
          />
          {branchActions ? (
            <span className="web-editor-branch-actions web-editor-mobile-actions" aria-label="Branch actions">
              {config.role === "admin" && config.writeMode !== "direct" ? (
                <button type="button" onClick={() => void openPullRequest(true)} disabled={busy}>
                  Merge to main
                </button>
              ) : null}
              <button type="button" onClick={() => void openPullRequest(false)} disabled={busy}>
                {config.writeMode === "direct" ? "Open remote PR" : "Open PR"}
              </button>
            </span>
          ) : null}
          {canDiscardDefaultEditBranch ? (
            <form
              className="inline-form web-editor-discard-branch"
              method="post"
              action={repoHref(config.owner, config.repo, "/branches/delete")}
              onSubmit={(event) => {
                if (!window.confirm(`Discard all committed changes on ${branch}?`)) event.preventDefault();
              }}
            >
              <input type="hidden" name="name" value={branch} />
              <input type="hidden" name="redirect_to" value={readHref} />
              <button className="button danger" type="submit" disabled={busy}>
                Discard branch
              </button>
            </form>
          ) : null}
          <a className="web-editor-cancel" data-testid="editor-cancel" href={readHref}>
            Cancel
          </a>
        </>,
      )}
      {renderFileTreeActions(
        <button type="button" className="file-tree-upload" data-testid="editor-upload-asset" onClick={() => assetInputRef.current?.click()} disabled={busy}>
          Upload
        </button>,
      )}
    </div>
  );
}

// Split the editor chrome across the single app status bar (#164): the editable
// filename goes into the breadcrumb's rename slot (the file shows once, as the
// rename affordance — no duplicate filename/branch), the actions into the editor
// slot. Fall back to one in-place footer if the shell slots are absent (tests,
// standalone mounts).
const renameSlot = document.querySelector(".app-statusbar .status-rename-slot");
const statusbarSlot = document.querySelector("[data-editor-actions-slot]") ?? document.querySelector(".app-statusbar .status-editor-slot");
const fileTreeActionsSlot = document.querySelector(".file-tree .file-tree-actions-slot");

function renderFileTreeActions(actions: ReactNode): ReactNode {
  if (!fileTreeActionsSlot) return null;
  return createPortal(actions, fileTreeActionsSlot);
}

function renderEditorChrome(filename: ReactNode, actions: ReactNode): ReactNode {
  // With the shell slots present (the real app), the filename portals into the
  // breadcrumb and only the actions go in the editor footer. Without them
  // (tests/standalone), both render inline in one footer.
  const split = Boolean(statusbarSlot && renameSlot);
  const footer = (
    <footer className="web-editor-statusbar" data-testid="statusbar">
      {split ? null : filename}
      {actions}
    </footer>
  );
  if (!split || !statusbarSlot || !renameSlot) return footer;
  return (
    <>
      {createPortal(filename, renameSlot)}
      {createPortal(footer, statusbarSlot)}
    </>
  );
}

export function mountWebEditor(root: HTMLElement, callbacks: WebEditorCallbacks = {}, options: { initialReadOnly?: boolean } = {}): WebEditorMount {
  const { config, content } = readConfig();
  const handleRef = createRef<WebEditorHandle>();
  const reactRoot = createRoot(root);
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  reactRoot.render(
    <StrictMode>
      <WebEditor
        config={config}
        initialContent={content}
        callbacks={callbacks}
        handleRef={handleRef}
        onEditorReady={resolveReady}
        initialReadOnly={options.initialReadOnly}
      />
    </StrictMode>,
  );
  return {
    root: reactRoot,
    ready,
    preview: () => handleRef.current?.preview() ?? null,
    scrollToSourcePosition: (position) => handleRef.current?.scrollToSourcePosition(position) ?? false,
    setReadOnly: (readOnly) => handleRef.current?.setReadOnly(readOnly),
  };
}

const root = document.getElementById("web-editor-root");
if (root && !root.closest("[data-edit-shell]")) mountWebEditor(root);
