import type {
  Extension,
} from "@codemirror/state";
import type {
  AssetUploader as EditorAssetUploader,
  SaveHandler as EditorSaveHandler,
  EditorSourcePosition,
  StatusEvents as EditorStatusEvents,
  EditorDocumentChange,
  OutlineEntry,
  RequestHandler,
  EditorScrollToSourcePositionOptions,
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
import {
  documentRailModel,
} from "../../shared/document-rail";
import { isEditableTextFile } from "../../shared/file-kind";
import { iconMarkup, lucideIcons } from "../../shared/lucide";
import { suggestingHunkFingerprint, suggestingHunks, type SuggestingHunk } from "../../shared/suggesting-diff";
import { repoBranchFileHref, repoHref, workspaceApiPath } from "../../shared/url";
import { ApiError, api, type LocalAnnotation } from "./api";
import { createBibliographyPicker } from "./bibliography-picker";
import {
  LOCAL_ANNOTATION_CLICK_EVENT,
  coflatDocumentContextSignature,
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
import { fetchRawRepoFile, nowTime, rawRepoFileHref, relativeAssetPath, saveState, shortId, sizeAssetRejection, toast } from "./web-editor-helpers";
import { LocalAnnotationsDrawer, useLocalAnnotationsController } from "./web-editor-local-annotations";
import { suggestingModeExtension } from "./suggesting-mode";
import "@chaoxu/coflat/style.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

function acceptedSuggestingHunkKey(baseText: string, currentText: string, hunk: SuggestingHunk): string {
  return `${hunk.id}\0${suggestingHunkFingerprint(baseText, currentText, hunk)}`;
}

interface EditorConfig {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  branchExists: boolean;
  readBranch: string;
  username: string;
  role: "admin" | "write" | "read";
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

interface SuggestingBase {
  path: string;
  baseText: string;
  headSha: string;
  currentSha: string | null;
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
type ExternalFileChange = {
  path: string;
  type: "change" | "remove";
  compareOpen: boolean;
  loading: boolean;
  latestContent?: string;
  latestSha?: string | null;
  error?: string;
  staleSave?: boolean;
};
const MODE_SWITCH_VIEWPORT_RATIO = 0.5;
const ActiveMarkdownEditor = lazy(() => import("./editor").then((m) => ({ default: m.MarkdownEditor })));

function compareLines(buffer: string, latest: string): Array<{ index: number; buffer: string; latest: string; changed: boolean }> {
  const bufferLines = buffer.split("\n");
  const latestLines = latest.split("\n");
  const count = Math.max(bufferLines.length, latestLines.length);
  const rows: Array<{ index: number; buffer: string; latest: string; changed: boolean }> = [];
  for (let i = 0; i < count; i++) {
    const bufferLine = bufferLines[i] ?? "";
    const latestLine = latestLines[i] ?? "";
    rows.push({ index: i + 1, buffer: bufferLine, latest: latestLine, changed: bufferLine !== latestLine });
  }
  return rows;
}

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
  const [suggestingSource, setSuggestingSource] = useState(initialContent);
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
  const [suggestingBase, setSuggestingBase] = useState<SuggestingBase | null>(null);
  const [acceptedSuggestingHunks, setAcceptedSuggestingHunks] = useState<ReadonlySet<string>>(() => new Set());
  const [suggestingError, setSuggestingError] = useState<string | null>(null);
  const [externalFileChange, setExternalFileChange] = useState<ExternalFileChange | null>(null);
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
  const ignoredChangePathsRef = useRef(new Set<string>());
  const ignoredChangeTimersRef = useRef<number[]>([]);
  const draftScope = useMemo(() => config.originId ? { originId: config.originId } : undefined, [config.originId]);
  const contextLoadedRef = useRef(false);
  const contextSignatureRef = useRef<string | null>(null);
  const documentContextRef = useRef<DocumentContext | null>(null);
  const documentContextLoadRef = useRef<{ signature: string; promise: Promise<DocumentContext> } | null>(null);
  const localAnnotationsEnabled = config.writeMode === "direct";
  const suggestingEnabled = config.writeMode === "direct";
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
    if (suggestingEnabled && suggestingBase) setSuggestingSource(next);
  }, [suggestingBase, suggestingEnabled]);

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
    if (suggestingEnabled && suggestingBase) setSuggestingSource(sourceCacheRef.current.source());
    scheduleContextSourceSync();
    setUncommitted(true);
    setSaveError(null);
  }, [scheduleContextSourceSync, suggestingBase, suggestingEnabled]);

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

  const loadSuggestingBase = useCallback(async (path: string) => {
    if (!suggestingEnabled) return null;
    try {
      const base = await api.suggestingBase(config.owner, config.repo, path);
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
  }, [config.owner, config.repo, suggestingEnabled]);

  useEffect(() => {
    if (!suggestingEnabled) return;
    void loadSuggestingBase(savedPathRef.current);
  }, [loadSuggestingBase, savedPath, suggestingEnabled]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource(`${workspaceApiPath(config.owner, config.repo)}/events`);
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
      const current = currentPathRef.current.trim() || config.path;
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
  }, [config.owner, config.path, config.repo]);

  useEffect(() => {
    if (!externalFileChange || externalFileChange.type !== "change" || !externalFileChange.loading) return;
    let cancelled = false;
    const readBranch = branchRef.current || savedReadBranchRef.current || config.branch;
    void api.getFile(config.owner, config.repo, externalFileChange.path, readBranch).then((latest) => {
      if (cancelled) return;
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
  }, [config.branch, config.owner, config.repo, externalFileChange]);

  useEffect(() => {
    let cancelled = false;
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
    const signature = coflatDocumentContextSignature(payload);
    if (contextSignatureRef.current === signature && documentContextRef.current) {
      setDocumentContextReady(true);
      return;
    }
    contextSignatureRef.current = signature;
    setDocumentContextReady(false);
    let load = documentContextLoadRef.current?.signature === signature
      ? documentContextLoadRef.current.promise
      : null;
    if (!load) {
      load = loadCoflatDocumentContext(payload);
      documentContextLoadRef.current = { signature, promise: load };
    }
    void load.then((ctx) => {
      if (cancelled || contextSignatureRef.current !== signature) return;
      setDocumentContext(ctx);
      documentContextRef.current = ctx;
      contextLoadedRef.current = true;
      setDocumentContextReady(true);
      if (documentContextLoadRef.current?.signature === signature) documentContextLoadRef.current = null;
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
    const refSelector = "[data-ref-key], .cf-citation";
    const nodeMayContainRefs = (node: Node): boolean => {
      if (!(node instanceof HTMLElement)) return false;
      return node.matches(refSelector) || Boolean(node.querySelector(refSelector));
    };
    schedule();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) =>
        (mutation.type === "attributes" && nodeMayContainRefs(mutation.target)) ||
        [...mutation.addedNodes].some(nodeMayContainRefs)
      )) {
        schedule();
      }
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-ref-key"] });
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
  }, [config.assetPreviewPaths, config.branch, config.owner, config.repo]);

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
        ignoreOwnChangeEvents(previousPath === nextPath ? [nextPath] : [previousPath, nextPath]);
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
        setExternalFileChange(null);
        clearDraft(config.owner, config.repo, config.branch, config.path, draftScope);
        if (previousPath !== nextPath) clearDraft(config.owner, config.repo, result.branch, previousPath, draftScope);
        clearDraft(config.owner, config.repo, result.branch, nextPath, draftScope);
        return { ok: true, branch: result.branch, path: nextPath };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setExternalFileChange({
            path: nextPath,
            type: "change",
            compareOpen: true,
            loading: true,
            staleSave: true,
          });
          return { ok: false, error: "Stale buffer: this file changed outside the editor. Compare or reload before saving." };
        }
        return { ok: false, error: err instanceof ApiError ? err.message : "save failed" };
      }
    },
    [branchForWrite, config.owner, config.repo, config.branch, config.path, draftScope, ignoreOwnChangeEvents, setEditorContent],
  );

  const checkpointSuggestingFile = useCallback(async (path: string): Promise<{ ok: true; commitSha: string | null } | { ok: false; error: string }> => {
    if (!suggestingEnabled) return { ok: true, commitSha: null };
    try {
      if (!suggestingBase || suggestingBase.path !== path) {
        return { ok: false, error: "suggesting base unavailable; reload and retry" };
      }
      const checkpoint = await api.checkpointSuggestingFile(config.owner, config.repo, path, {
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
  }, [config.owner, config.repo, suggestingBase, suggestingEnabled]);

  const commitManualSource = useCallback(
    async (source: string): Promise<{ ok: true; branch: string; path: string } | { ok: false; error: string }> => {
      const committed = await commitSource(source);
      if (!committed.ok) return committed;
      if (!suggestingEnabled || !suggestingBase || suggestingBase.path !== committed.path) return committed;
      const checkpoint = await checkpointSuggestingFile(committed.path);
      if (!checkpoint.ok) return { ok: false, error: checkpoint.error };
      return committed;
    },
    [commitSource, checkpointSuggestingFile, suggestingBase, suggestingEnabled],
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
  const hasCheckpointChanges = suggestingEnabled && suggestingHunksForSource.length > 0;

  // Route Coflat saves by reason (#162): autosave → local draft (or nothing when
  // disabled, #158); manual/command (Save button, Cmd-S) → real commit.
  const saveHandler = useMemo<EditorSaveHandler>(
    () => ({
      autosaveDebounceMs: autosave.intervalMs,
      isBusy: () => busy,
      save: (payload) => {
        lastReasonRef.current = payload.reason;
        if (payload.reason !== "autosave") return commitManualSource(payload.source);
        if (!autosave.enabled) return Promise.resolve({ ok: true as const });
        return Promise.resolve(saveDraft(payload.source));
      },
    }),
    [autosave.intervalMs, autosave.enabled, busy, saveDraft, commitManualSource],
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
        const { formatUploadedAssetMarkdown } = await import("@chaoxu/coflat");
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
    if (!pathDirty) {
      if (!hasCheckpointChanges) return;
      setBusy(true);
      setSaveError(null);
      lastReasonRef.current = "manual";
      void checkpointSuggestingFile(savedPathRef.current).then((result) => {
        setBusy(false);
        if (result.ok) setLastSavedAt(nowTime());
        else {
          setSaveError(result.error);
          toast(`Save failed: ${result.error}`, "error");
        }
      });
      return;
    }
    setBusy(true);
    setSaveError(null);
    lastReasonRef.current = "manual";
    void commitManualSource(liveEditorSource(editorRef.current, content)).then((result) => {
      setBusy(false);
      if (result.ok) setLastSavedAt(nowTime());
      else {
        setSaveError(result.error);
        toast(`Save failed: ${result.error}`, "error");
      }
    });
  }, [busy, content, uncommitted, pathDirty, hasCheckpointChanges, checkpointSuggestingFile, commitManualSource]);

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
      const result = await api.revertSuggestingHunk(config.owner, config.repo, targetPath, hunk, {
        headSha: suggestingBase.headSha,
        currentSha: savedShaRef.current ?? suggestingBase.currentSha,
      });
      setEditorContent(result.content);
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
  }, [busy, uncommitted, pathDirty, commitSource, content, config.owner, config.repo, ignoreOwnChangeEvents, setEditorContent, suggestingBase]);

  const acceptSuggestingHunkRef = useRef(acceptSuggestingHunk);
  const revertSuggestingHunkRef = useRef(revertSuggestingHunk);
  const saveCheckpointRef = useRef(save);
  acceptSuggestingHunkRef.current = acceptSuggestingHunk;
  revertSuggestingHunkRef.current = revertSuggestingHunk;
  saveCheckpointRef.current = save;

  const suggestingExtensions = useMemo<readonly Extension[]>(
    () =>
      suggestingEnabled && suggestingBase
        ? [
            suggestingModeExtension({
              baseText: suggestingBase.baseText,
              onAccept: (hunk) => acceptSuggestingHunkRef.current(hunk),
              onRevert: (hunk) => revertSuggestingHunkRef.current(hunk),
              onCheckpoint: () => saveCheckpointRef.current(),
            }),
          ]
        : [],
    [suggestingBase, suggestingEnabled],
  );

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
  const copyCurrentBuffer = useCallback(() => {
    const buffer = liveEditorSource(editorRef.current, content);
    if (!navigator.clipboard) {
      toast("Copy unavailable; select the editor buffer manually", "error");
      return;
    }
    void navigator.clipboard.writeText(buffer).then(() => {
      toast("Copied current editor buffer");
    }).catch(() => {
      toast("Copy failed; select the editor buffer manually", "error");
    });
  }, [content]);
  const reloadLatestFile = useCallback(() => {
    window.location.href = `${repoBranchFileHref(config.owner, config.repo, savedReadBranchRef.current, savedPathRef.current)}?mode=edit`;
  }, [config.owner, config.repo]);

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
  const railOutline = useMemo(
    () => outline.map((entry) => ({
      key: entry.key,
      level: entry.level,
      label: entry.markdown,
      html: (entry as OutlineEntry & { html?: string }).html,
      line: entry.line,
    })),
    [outline],
  );
  const railModel = useMemo(
    () => documentRailModel({
      mode: "edit",
      readHref,
      editHref: window.location.href,
      controls: false,
      outline: railOutline,
    }),
    [railOutline, readHref],
  );

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

  const externalCompareRows = externalFileChange?.latestContent !== undefined
    ? compareLines(liveEditorSource(editorRef.current, content), externalFileChange.latestContent)
    : [];

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
      {externalFileChange ? (
        <div className="editor-draft-banner editor-external-change-banner" data-testid="editor-external-change-banner" role="alert">
          <span>
            {externalFileChange.staleSave
              ? "Save blocked because this editor buffer is stale."
              : externalFileChange.type === "remove" ? "This file was removed outside this editor." : "This file changed outside this editor."}
            {" "}Compare or reload before continuing.
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
          <button type="button" className="button small" data-testid="editor-external-change-reload" onClick={reloadLatestFile}>
            Reload
          </button>
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
      ) : null}
      {externalFileChange?.compareOpen ? (
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
            <p>The workspace file no longer exists. Copy the buffer or reload to resolve.</p>
          ) : (
            <div className="editor-external-compare-grid">
              <div className="editor-external-compare-heading">Current editor buffer</div>
              <div className="editor-external-compare-heading">Latest workspace file</div>
              {externalCompareRows.map((row) => (
                <div className={`editor-external-compare-row ${row.changed ? "changed" : ""}`} key={row.index}>
                  <pre><span>{row.index}</span>{row.buffer || " "}</pre>
                  <pre><span>{row.index}</span>{row.latest || " "}</pre>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
      <div className="doc-with-toc">
        <div className="doc-main">
          <Suspense fallback={<div className="web-editor-loading">Loading editor...</div>}>
            {documentContextReady ? (
              <ActiveMarkdownEditor
                key={`${savedPath}:${suggestingBase?.headSha ?? "no-suggesting-base"}`}
                value={content}
                mode={readOnly ? "rich" : mode}
                readOnly={readOnly}
                from={currentPath}
                documentContext={documentContext ?? undefined}
                fileSystem={fileSystem}
                extensions={suggestingExtensions}
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
          <span className="dirty-dot" hidden={!uncommitted && !pathDirty && !hasCheckpointChanges}>
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
          {suggestingEnabled ? (
            <span
              className="web-editor-suggesting-state"
              data-testid="editor-suggesting-state"
              title={suggestingError ?? (suggestingBase ? "Diff against the current HEAD checkpoint" : "Suggesting mode unavailable")}
            >
              Changes {suggestingBase ? unresolvedSuggestingHunkCount : "-"}
            </span>
          ) : null}
          {(() => {
            // Glance-able, paired with the dirty-dot. title surfaces the full error.
            const s = saveState({ busy, saveError, dirty: uncommitted || pathDirty || hasCheckpointChanges, lastSavedAt });
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
          <button type="button" onClick={save} disabled={(!uncommitted && !pathDirty && !hasCheckpointChanges) || busy}>
            {suggestingBase ? "Save checkpoint" : "Save"}
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
