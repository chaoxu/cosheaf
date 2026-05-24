import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AssetUploader as EditorAssetUploader,
  AutocompleteSource as EditorAutocompleteSource,
  MountedEditor,
  OutlineEntry,
  SaveHandler as EditorSaveHandler,
  StatusEvents as EditorStatusEvents,
} from "@chaoxu/coflat-editor";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
  userBranchPrefix,
} from "../../shared/conventions";
import { ApiError, api } from "./api";
import { readDocumentTheme } from "./document-theme";
import type { DocumentThemeId } from "./document-theme";
import { getClientDocumentFormat } from "./format-registry";
import "@chaoxu/coflat-editor/style.css";
import "@chaoxu/coflat-editor/themes/blueprint-book.css";
import "./globals.css";

interface EditorConfig {
  slug: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
  username: string;
  role: "admin" | "write" | "read";
  formatId: DocumentFormatId;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function urlPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function readConfig(): { config: EditorConfig; content: string } {
  const mount = document.getElementById("web-editor-root");
  const payload = document.getElementById("web-editor-content");
  if (!mount || !payload) throw new Error("missing web editor mount payload");
  return {
    config: {
      slug: mount.dataset.slug ?? "",
      owner: mount.dataset.owner ?? "",
      repo: mount.dataset.repo ?? "",
      path: mount.dataset.path ?? "",
      branch: mount.dataset.branch ?? "",
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
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pathDirty, setPathDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [documentTheme] = useState<DocumentThemeId>(() => readDocumentTheme(config.username));
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const editorRef = useRef<MountedEditor | null>(null);
  const branchRef = useRef(branch);
  const currentPathRef = useRef(currentPath);
  const savedPathRef = useRef(savedPath);
  branchRef.current = branch;
  currentPathRef.current = currentPath;
  savedPathRef.current = savedPath;

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty && !pathDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, pathDirty]);

  useEffect(() => {
    const input = document.getElementById("web-editor-path-input");
    if (!(input instanceof HTMLInputElement)) return;
    const onInput = () => {
      setCurrentPath(input.value);
      setPathDirty(input.value.trim() !== savedPathRef.current);
      setStatus(null);
    };
    input.addEventListener("input", onInput);
    return () => input.removeEventListener("input", onInput);
  }, []);

  useEffect(() => {
    const input = document.getElementById("web-editor-path-input");
    if (input instanceof HTMLInputElement) {
      if (input.value !== currentPath) input.value = currentPath;
      input.disabled = busy;
    }
    const dirtyMark = document.getElementById("web-editor-path-dirty");
    if (dirtyMark instanceof HTMLElement) dirtyMark.hidden = !dirty && !pathDirty;
  }, [busy, currentPath, dirty, pathDirty]);

  const branchForWrite = useCallback(() => {
    const current = branchRef.current;
    if (current && current !== "main") return current;
    return `${userBranchPrefix(config.username)}wip-${shortId()}`;
  }, [config.username]);

  const saveSource = useCallback(
    async (source: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const writeBranch = branchForWrite();
      const nextPath = currentPathRef.current.trim();
      const previousPath = savedPathRef.current;
      if (!nextPath.endsWith(".md")) return { ok: false, error: "path must end with .md" };
      try {
        const result = await api.putFile(
          config.slug,
          nextPath,
          source,
          writeBranch,
          previousPath !== nextPath ? previousPath : undefined,
        );
        if (result.content !== undefined) setContent(result.content);
        setBranch(result.branch);
        setSavedPath(nextPath);
        setCurrentPath(nextPath);
        setPathDirty(false);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof ApiError ? err.message : "save failed" };
      }
    },
    [branchForWrite, config.slug],
  );

  const saveHandler = useMemo<EditorSaveHandler>(
    () => ({
      autosaveDebounceMs: 1500,
      isBusy: () => busy,
      save: (payload) => saveSource(payload.source),
    }),
    [busy, saveSource],
  );

  const statusEvents = useMemo<EditorStatusEvents>(
    () => ({
      onSaveStart: () => {
        setBusy(true);
        setStatus(null);
      },
      onSaveSucceeded: () => {
        setBusy(false);
        setStatus("saved");
      },
      onSaveFailed: (event) => {
        setBusy(false);
        setStatus(`save failed: ${event.error}`);
      },
      onDirtyChange: setDirty,
      onAssetUploading: (event) => setStatus(`uploading ${event.file.name}...`),
      onAssetUploadSucceeded: (event) => setStatus(`uploaded ${event.path}`),
      onAssetUploadFailed: (event) => setStatus(`upload failed: ${event.error}`),
    }),
    [],
  );

  const assetUploader = useMemo<EditorAssetUploader>(
    () => ({
      accept: (file) =>
        file.size > MAX_ASSET_BYTES ? { reject: `asset exceeds ${MAX_ASSET_DISPLAY}` } : null,
      upload: async (file) => {
        const writeBranch = branchForWrite();
        try {
          const result = await api.uploadAsset(config.slug, writeBranch, file);
          setBranch(writeBranch);
          return { path: result.path };
        } catch (err) {
          return { error: err instanceof ApiError ? err.message : "upload failed" };
        }
      },
    }),
    [branchForWrite, config.slug],
  );

  const autocompleteSources = useMemo<readonly EditorAutocompleteSource[]>(
    () => [
      {
        trigger: "[@",
        suggest: async (prefix, env) => {
          if (env.signal.aborted) return [];
          try {
            const result = await api.suggest(config.slug, { trigger: "[@", prefix, limit: 10 });
            return result.suggestions;
          } catch (_err) {
            return [];
          }
        },
      },
    ],
    [config.slug],
  );

  const save = useCallback(() => {
    if (dirty) {
      void editorRef.current?.triggerSave("manual");
      return;
    }
    if (!pathDirty || busy) return;
    setBusy(true);
    setStatus(null);
    void saveSource(content).then((result) => {
      setBusy(false);
      if (result.ok) setStatus("saved");
      else setStatus(`save failed: ${result.error}`);
    });
  }, [busy, content, dirty, pathDirty, saveSource]);

  const openPullRequest = useCallback(
    async (directMerge: boolean) => {
      if (!branch || branch === "main") {
        setStatus("nothing on this branch to merge or review");
        return;
      }
      setBusy(true);
      setStatus(null);
      try {
        const pr = await api.openPull(config.slug, {
          head: branch,
          title: branch,
          body: `Update ${currentPath}`,
        });
        if (directMerge) {
          await api.mergePull(config.slug, pr.number, { Do: "squash", force: true });
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
    [branch, config.owner, config.repo, config.slug, currentPath],
  );

  const readerClass =
    documentTheme === "blueprint-book"
      ? "web-editor-shell cf-theme-scope cf-theme-blueprint-book"
      : "web-editor-shell cf-theme-scope";

  return (
    <div className={readerClass}>
      <div className="web-editor-main">
        <Suspense fallback={<div className="web-editor-loading">Loading editor...</div>}>
          <ActiveMarkdownEditor
            key={savedPath}
            value={content}
            mode={mode}
            from={currentPath}
            testId="editor"
            onReady={(editor) => {
              editorRef.current = editor;
              setOutline(editor.outline.get());
              editor.outline.subscribe(setOutline);
            }}
            onChange={(next) => {
              setContent(next);
              setStatus(null);
            }}
            saveHandler={saveHandler}
            statusEvents={statusEvents}
            assetUploader={assetUploader}
            autocompleteSources={autocompleteSources}
          />
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
      <footer className="web-editor-statusbar" data-testid="statusbar">
        <span className="web-editor-status">{status ?? ""}</span>
        <span data-testid="active-branch-name" className="web-editor-branch">
          {branch}
        </span>
        {config.formatId === COFLAT_FORMAT_ID ? (
          <button type="button" onClick={() => setMode((value) => (value === "rich" ? "source" : "rich"))}>
            {mode === "rich" ? "Source" : "Rich"}
          </button>
        ) : null}
        <button type="button" onClick={save} disabled={(!dirty && !pathDirty) || busy}>
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
              Open pull request
            </button>
          </>
        ) : null}
      </footer>
    </div>
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
