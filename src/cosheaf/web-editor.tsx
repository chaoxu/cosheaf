import type {
  AssetUploader as EditorAssetUploader,
  AutocompleteSource as EditorAutocompleteSource,
  SaveHandler as EditorSaveHandler,
  StatusEvents as EditorStatusEvents,
  MountedEditor,
  MountedDocumentChange,
  OutlineEntry,
} from "@chaoxu/coflat";
import {
  formatUploadedAssetMarkdown,
} from "@chaoxu/coflat";
import {
  extractFirstH1 as extractCoflatFirstH1,
  parseFrontmatter as parseCoflatFrontmatter,
  relativeMarkdownReferencePathFromDocument,
} from "@chaoxu/coflat/parse";
import {
  type DocumentContext,
  type FileEntry,
  type FileSystem,
  createReaderCitationClusterPreviewBody,
  hydrateReaderHoverPreviews,
  hydrateReferences,
} from "@chaoxu/coflat/reader";
import type { ReactNode } from "react";
import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
  userBranchPrefix,
} from "../../shared/conventions";
import {
  documentRailModel,
} from "../../shared/document-rail";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";
import { isEditableTextFile } from "../../shared/file-kind";
import { iconMarkup, lucideIcons } from "../../shared/lucide";
import { urlPath } from "../../shared/url";
import { ApiError, api } from "./api";
import {
  loadCoflatDocumentContext,
} from "./coflat-document-context";
import { renderDocumentRail } from "./document-rail-dom";
import type { DocumentThemeId } from "./document-theme";
import { readAutosave, readDocumentTheme, readEditorMode, writeEditorMode } from "./document-theme";
import {
  IncrementalSourceCache,
  liveEditorSource,
  routeEditorChangeHandlers,
} from "./editor-change-routing";
import { clearDraft, type EditorDraft, readDraft, restoredDraftFreshness, writeDraft } from "./editor-draft";
import { getClientDocumentFormat } from "./format-registry";
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
  mathMacros: Record<string, string>;
  bibliography?: string;
  csl?: string;
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

interface Suggestion {
  id: string;
  insert: string;
  display: string;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function relativeAssetPath(documentPath: string, assetPath: string): string {
  return relativeMarkdownReferencePathFromDocument(documentPath, assetPath);
}

function rawRepoFileHref(owner: string, repo: string, branch: string, path: string): string {
  return `/${urlPath(owner)}/${urlPath(repo)}/raw/branch/${urlPath(branch)}/${urlPath(path)}`;
}

async function fetchRawRepoFile(owner: string, repo: string, branch: string, path: string): Promise<Response> {
  const res = await fetch(rawRepoFileHref(owner, repo, branch, path), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Unable to read ${path}: HTTP ${res.status}`);
  return res;
}

function sizeAssetRejection(file: File): { reject: string } | null {
  return file.size > MAX_ASSET_BYTES ? { reject: `asset exceeds ${MAX_ASSET_DISPLAY}` } : null;
}

// Fire an app-wide toast (cosheaf-toast.js, loaded by the page shell). A no-op
// if the script hasn't loaded; toasts are for discrete events (merge/PR/errors/
// upload), never for per-save feedback.
function toast(message: string, kind: "info" | "success" | "error" = "info"): void {
  (window as unknown as { cosheafToast?: (m: string, o?: { kind?: string }) => void }).cosheafToast?.(message, { kind });
}

// Persistent, glance-able save-state label + style class (#184), priority-ordered:
// in-flight > error > unsaved > last saved > idle. Discrete events (merge/PR/
// upload) go to toasts instead, so constant saves don't spam.
function saveState(args: {
  busy: boolean;
  saveError: string | null;
  dirty: boolean;
  lastSavedAt: string | null;
}): { text: string; cls: string } {
  if (args.busy) return { text: "Saving…", cls: "saving" };
  if (args.saveError) return { text: "Save failed", cls: "error" };
  if (args.dirty) return { text: "Unsaved changes", cls: "dirty" };
  if (args.lastSavedAt) return { text: `Saved · ${args.lastSavedAt}`, cls: "saved" };
  return { text: "", cls: "idle" };
}

function readConfig(): { config: EditorConfig; content: string } {
  const mount = document.getElementById("web-editor-root");
  const payload = document.getElementById("web-editor-content");
  const repoConfigScript = document.getElementById("web-editor-repo-config");
  if (!mount || !payload) throw new Error("missing web editor mount payload");
  const repoConfig = repoConfigScript?.textContent
    ? JSON.parse(repoConfigScript.textContent) as EditorRepoConfigPayload
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
      formatId: (mount.dataset.formatId ?? "forgejo-passthrough") as DocumentFormatId,
      baseSha: mount.dataset.baseSha || null,
      sourceSha: mount.dataset.sourceSha || null,
      resetEditBranch: mount.dataset.resetEditBranch === "1",
      mathMacros: repoConfig.mathMacros ?? {},
      ...(repoConfig.bibliography ? { bibliography: repoConfig.bibliography } : {}),
      ...(repoConfig.csl ? { csl: repoConfig.csl } : {}),
    },
    content: JSON.parse(payload.textContent || "\"\"") as string,
  };
}

function currentDocumentSuggestions(source: string, prefix: string): Suggestion[] {
  const parsed = parseCoflatFrontmatter(source);
  const frontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  const suggestions: Suggestion[] = [];
  const add = (id: string, title: string | null, detail: string) => {
    if (!id || !matchesSuggestion(id, title, prefix)) return;
    suggestions.push({
      id,
      insert: `[@${id}]`,
      display: title ? `${id} — ${title} (${detail})` : `${id} (${detail})`,
    });
  };
  if (typeof frontmatter.id === "string") {
    add(
      frontmatter.id,
      typeof frontmatter.title === "string" ? frontmatter.title : extractCoflatFirstH1(parsed.body),
      "current page",
    );
  }
  for (const target of extractCoflatXrefTargets(source)) add(target.id, target.label, "current page");
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.id)) return false;
    seen.add(suggestion.id);
    return true;
  });
}

function matchesSuggestion(id: string, title: string | null, prefix: string): boolean {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return true;
  return id.toLowerCase().startsWith(needle) || Boolean(title?.toLowerCase().includes(needle));
}

function WebEditor({ config, initialContent }: { config: EditorConfig; initialContent: string }) {
  const ActiveMarkdownEditor = useMemo(
    () => lazy(getClientDocumentFormat(config.formatId).editor),
    [config.formatId],
  );
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
  const [documentTheme] = useState<DocumentThemeId>(() => readDocumentTheme(config.username));
  const [documentContext, setDocumentContext] = useState<DocumentContext | null>(null);
  const [documentContextReady, setDocumentContextReady] = useState(config.formatId !== COFLAT_FORMAT_ID);
  const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const editorRef = useRef<MountedEditor | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const assetInputRef = useRef<HTMLInputElement | null>(null);
  const sourceCacheRef = useRef(new IncrementalSourceCache(initialContent));
  const contextSourceTimerRef = useRef<number | null>(null);
  const outlineUnsubscribeRef = useRef<(() => void) | null>(null);
  const branchRef = useRef(branch);
  const currentPathRef = useRef(currentPath);
  const savedPathRef = useRef(savedPath);
  const savedShaRef = useRef<string | null | undefined>(config.baseSha);
  const sourceShaRef = useRef<string | undefined>(config.sourceSha ?? undefined);
  const resetEditBranchRef = useRef(config.resetEditBranch);
  const contextLoadedRef = useRef(config.formatId !== COFLAT_FORMAT_ID);
  branchRef.current = branch;
  currentPathRef.current = currentPath;
  savedPathRef.current = savedPath;

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

  const handleCoflatDocumentChange = useCallback((change: MountedDocumentChange) => {
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
    const draft = readDraft(config.owner, config.repo, config.branch, config.path);
    if (draft && (draft.source !== initialContent || (draft.path && draft.path !== config.path))) setPendingDraft(draft);
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
      contextLoadedRef.current = true;
      setDocumentContextReady(true);
      return;
    }
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
  }, [branch, branchExists, config.bibliography, config.csl, config.formatId, config.mathMacros, config.owner, config.path, config.repo, contextSource, currentPath]);

  useEffect(() => {
    if (config.formatId !== COFLAT_FORMAT_ID) return;
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
  }, [config.formatId, config.owner, config.repo]);

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
    if (current && current !== "main") return current;
    return `${userBranchPrefix(config.username)}wip-${shortId()}`;
  }, [config.username]);

  const fileSystem = useMemo<FileSystem | undefined>(() => {
    if (config.formatId !== COFLAT_FORMAT_ID) return undefined;
    const readBranch = () => branchRef.current || config.branch || "main";
    const readFile = async (path: string): Promise<string> =>
      fetchRawRepoFile(config.owner, config.repo, readBranch(), path).then((res) => res.text());
    const readFileBinary = async (path: string): Promise<Uint8Array> => {
      const buffer = await fetchRawRepoFile(config.owner, config.repo, readBranch(), path).then((res) => res.arrayBuffer());
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
          await fetchRawRepoFile(config.owner, config.repo, readBranch(), path);
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
      resolveAssetUrl: (path: string): string => rawRepoFileHref(config.owner, config.repo, readBranch(), path),
    };
  }, [config.branch, config.formatId, config.owner, config.repo]);

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
      });
      return { ok: true };
    },
    [config.owner, config.repo],
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
        setEditorContent(result.content ?? source);
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
        clearDraft(config.owner, config.repo, config.branch, config.path);
        if (previousPath !== nextPath) clearDraft(config.owner, config.repo, result.branch, previousPath);
        clearDraft(config.owner, config.repo, result.branch, nextPath);
        return { ok: true, branch: result.branch, path: nextPath };
      } catch (err) {
        return { ok: false, error: err instanceof ApiError ? err.message : "save failed" };
      }
    },
    [branchForWrite, config.owner, config.repo, config.branch, config.path, setEditorContent],
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
        }
      } catch (err) {
        toast(`Upload failed: ${err instanceof ApiError ? err.message : "upload failed"}`, "error");
      } finally {
        setBusy(false);
        if (assetInputRef.current) assetInputRef.current.value = "";
      }
    },
    [assetUploader, branchForWrite, busy, config.owner, config.path, config.repo, content, setEditorContent],
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
    clearDraft(config.owner, config.repo, config.branch, config.path);
    setPendingDraft(null);
  }, [config.owner, config.repo, config.branch, config.path]);

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
            window.location.href = `/${urlPath(config.owner)}/${urlPath(config.repo)}/src/branch/main/${urlPath(reviewPath)}?toast=${encodeURIComponent("Merged to main")}&toastKind=success`;
          } catch (mergeErr) {
            const reason = mergeErr instanceof ApiError ? mergeErr.message : "Couldn't merge to main";
            window.location.href = `/${urlPath(config.owner)}/${urlPath(config.repo)}/pulls/${pr.number}?toast=${encodeURIComponent(reason)}&toastKind=error`;
          }
          return;
        }
        // #181: openPull returns the existing PR when one is already open for
        // this branch, so this navigates to it instead of erroring on a dup.
        window.location.href = `/${urlPath(config.owner)}/${urlPath(config.repo)}/pulls/${pr.number}?toast=${encodeURIComponent(`PR #${pr.number} opened`)}&toastKind=success`;
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
  const readHref = `/${urlPath(config.owner)}/${urlPath(config.repo)}/src/branch/${urlPath(savedReadBranch)}/${urlPath(savedPath)}`;
  const outlineMathMacros = documentContext?.mathMacros;
  const railModel = documentRailModel({
    mode: "edit",
    readHref,
    editHref: window.location.href,
    editorMode: config.formatId === COFLAT_FORMAT_ID ? mode : undefined,
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
        onControl: (control) => {
          if (control.label === "Source") setEditorMode("source");
          else if (control.label === "Rich") setEditorMode("rich");
        },
        onOutlineItem: (entry) => {
          if (typeof entry.line === "number") editorRef.current?.scrollToLine(entry.line, { center: true });
        },
      },
    );
  }, [outlineMathMacros, railModel, setEditorMode]);

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
      <div className="doc-with-toc">
        <div className="doc-main">
          <Suspense fallback={<div className="web-editor-loading">Loading editor...</div>}>
            {documentContextReady ? (
              <ActiveMarkdownEditor
                key={savedPath}
                value={content}
                mode={mode}
                from={currentPath}
                documentContext={documentContext ?? undefined}
                fileSystem={fileSystem}
                testId="editor"
                onReady={(editor) => {
                  outlineUnsubscribeRef.current?.();
                  editorRef.current = editor;
                  setOutline(editor.outline.get());
                  outlineUnsubscribeRef.current = editor.outline.subscribe(setOutline);
                }}
                {...routeEditorChangeHandlers(config.formatId, {
                  onStringChange: handleEditorStringChange,
                  onDocumentChange: handleCoflatDocumentChange,
                })}
                saveHandler={saveHandler}
                statusEvents={statusEvents}
                assetUploader={assetUploader}
                autocompleteSources={autocompleteSources}
                sidenotesCollapsed={config.formatId === COFLAT_FORMAT_ID}
              />
            ) : (
              <div className="web-editor-loading">Loading editor...</div>
            )}
          </Suspense>
        </div>
        <aside ref={railRef} className="web-editor-outline doc-rail" aria-label="Document tools" data-document-rail />
      </div>
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
            disabled={busy}
            onChange={(e) => {
              setCurrentPath(e.target.value);
              setPathDirty(e.target.value.trim() !== savedPath);
              setSaveError(null);
            }}
            onKeyDown={(e) => {
              // Esc abandons an in-progress rename, restoring the saved path;
              // Enter commits by blurring (the underlying save picks up pathDirty).
              if (e.key === "Escape") {
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
            disabled={busy}
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
          {config.formatId === COFLAT_FORMAT_ID ? (() => {
            const actionable = validationSummary ? validationSummary.brokenRefs + validationSummary.duplicateLabels : null;
            const label = actionable === null ? "Problems -" : `Problems ${actionable}`;
            const detail = validationSummary
              ? `${actionable} actionable, ${validationSummary.orphanLabels} unreferenced`
              : "Diagnostics unavailable";
            return (
              <a
                className={`web-editor-problems ${actionable && actionable > 0 ? "has-issues" : ""}`}
                href={`/${urlPath(config.owner)}/${urlPath(config.repo)}/diagnostics`}
                title={detail}
              >
                {label}
              </a>
            );
          })() : null}
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
          <button type="button" data-testid="editor-upload-asset" onClick={() => assetInputRef.current?.click()} disabled={busy}>
            Upload
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
          <a className="web-editor-cancel" data-testid="editor-cancel" href={readHref}>
            Cancel
          </a>
        </>,
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
const statusbarSlot = document.querySelector(".app-statusbar .status-editor-slot");

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

const { config, content } = readConfig();
const root = document.getElementById("web-editor-root");
if (!root) throw new Error("missing #web-editor-root");
createRoot(root).render(
  <StrictMode>
    <WebEditor config={config} initialContent={content} />
  </StrictMode>,
);
