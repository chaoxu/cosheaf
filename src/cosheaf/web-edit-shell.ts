import {
  scrollReaderToSourcePosition,
  type SourcePosition,
} from "@chaoxu/coflat/reader";
import type { CoflatDocumentPayload } from "./coflat-document-context";

type WorkbenchMode = "read" | "edit";

interface EditorModule {
  mountWebEditor: (
    root: HTMLElement,
    callbacks?: {
      onDirtyChange?: (dirty: boolean) => void;
      onSaved?: (event: { source: string; branch: string; path: string; readHref: string }) => void;
    },
  ) => WebEditorMount;
}

interface WebEditorMount {
  preview: () => { source: string; branch: string; branchExists: boolean; path: string; dirty: boolean; sourcePosition: SourcePosition | null } | null;
}

interface WorkbenchState {
  dirty: boolean;
  editorLoaded: boolean;
  editorLoading: boolean;
  editorMount: WebEditorMount | null;
  payload: CoflatDocumentPayload | null;
  previewKey: string | null;
  sourcePosition: SourcePosition | null;
}

function shell(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-edit-shell]");
}

function editorRoot(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("#web-editor-root");
}

function readPanel(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-edit-read-panel]");
}

function readerMount(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-edit-reader-mount]");
}

function statusSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".app-statusbar .status-editor-slot");
}

function editorActionsSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-editor-actions-slot]");
}

function fileActionsSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".file-tree .file-tree-actions-slot");
}

function readPayload(host: HTMLElement): CoflatDocumentPayload | null {
  const script = host.querySelector<HTMLScriptElement>("[data-edit-reader-payload]");
  if (!script?.textContent) return null;
  return JSON.parse(script.textContent) as CoflatDocumentPayload;
}

function writePayload(host: HTMLElement, payload: CoflatDocumentPayload): void {
  const script = host.querySelector<HTMLScriptElement>("[data-edit-reader-payload]");
  if (script) script.textContent = JSON.stringify(payload);
}

function payloadKey(payload: Pick<CoflatDocumentPayload, "source" | "branch" | "path">): string {
  return JSON.stringify([payload.branch, payload.path, payload.source]);
}

function activeModeFromUrl(): WorkbenchMode | null {
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "read" || mode === "edit") return mode;
  return null;
}

function preferredOpenMode(): WorkbenchMode {
  const user = document.body.dataset.cosheafUser || "";
  const legacyKey = "cosheaf:file-open-mode";
  const key = user ? `${legacyKey}:${user}` : legacyKey;
  return (localStorage.getItem(key) || localStorage.getItem(legacyKey)) === "read" ? "read" : "edit";
}

function initialMode(host: HTMLElement): WorkbenchMode {
  return activeModeFromUrl() ?? (host.dataset.initialMode === "auto" ? preferredOpenMode() : host.dataset.initialMode === "read" ? "read" : "edit");
}

function setUrlMode(mode: WorkbenchMode, replace = false): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  if (replace) history.replaceState({ ...(history.state ?? {}), editMode: mode }, "", url);
  else history.pushState({ ...(history.state ?? {}), editMode: mode }, "", url);
}

function renderStatusControls(mode: WorkbenchMode, dirty = false): void {
  const slot = statusSlot();
  if (!slot) return;
  let primary = slot.querySelector<HTMLElement>("[data-edit-primary-mode]");
  let actions = slot.querySelector<HTMLElement>("[data-editor-actions-slot]");
  if (!primary || !actions) {
    slot.replaceChildren();
    primary = document.createElement("span");
    primary.className = "edit-primary-mode";
    primary.dataset.editPrimaryMode = "";
    primary.setAttribute("aria-label", "Document mode");
    const read = document.createElement("button");
    read.type = "button";
    read.textContent = "Read";
    read.dataset.editModeTarget = "read";
    read.dataset.editPrimaryModeItem = "read";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.dataset.editModeTarget = "edit";
    edit.dataset.editPrimaryModeItem = "edit";
    primary.append(read, edit);
    actions = document.createElement("span");
    actions.className = "editor-actions-slot";
    actions.dataset.editorActionsSlot = "";
    slot.append(actions, primary);
  }
  for (const item of primary.querySelectorAll<HTMLElement>("[data-edit-primary-mode-item]")) {
    const active = item.dataset.editPrimaryModeItem === mode;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", active ? "true" : "false");
  }
  primary.classList.toggle("is-dirty", dirty);
  primary.title = dirty ? "Previewing unsaved edits" : "";
}

function setVisibleMode(host: HTMLElement, mode: WorkbenchMode): void {
  host.dataset.mode = mode;
  document.documentElement.dataset.cosheafWorkbenchMode = mode;
  const reader = readPanel(host);
  const root = editorRoot(host);
  if (reader) reader.hidden = mode !== "read";
  if (root) root.hidden = mode !== "edit";
  const actions = editorActionsSlot();
  if (actions) actions.hidden = mode !== "edit";
  const fileSlot = fileActionsSlot();
  if (fileSlot) fileSlot.hidden = mode !== "edit";
  renderStatusControls(mode, host.dataset.dirty === "1");
}

function rebuildReader(host: HTMLElement, payload: CoflatDocumentPayload): void {
  const mount = readerMount(host);
  if (!mount) return;
  const article = document.createElement("article");
  article.className = "document cosheaf-document-reader cf-theme-scope";
  article.dataset.testid = "file-preview-markdown";
  const island = document.createElement("div");
  island.className = "cf-reader cf-doc-surface cf-doc-flow coflat-reader-island";
  island.dataset.readerBranch = payload.branch;
  const script = document.createElement("script");
  script.type = "application/json";
  script.textContent = JSON.stringify(payload);
  island.append(script);
  article.append(island);
  mount.replaceChildren(article);
}

function readScroller(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-edit-read-panel] .doc-main");
}

function applyReadSourcePosition(host: HTMLElement, sourcePosition: SourcePosition | null): void {
  if (!sourcePosition) return;
  let attempts = 0;
  const apply = () => {
    attempts += 1;
    const scroller = readScroller(host);
    const pendingPayload = scroller?.querySelector('script[type="application/json"]');
    if (!scroller || pendingPayload || (scroller.scrollHeight <= scroller.clientHeight && attempts < 20)) {
      if (attempts < 20) window.requestAnimationFrame(apply);
      return;
    }
    if (!scrollReaderToSourcePosition(scroller, sourcePosition, { block: "center" }) && attempts < 20) {
      window.requestAnimationFrame(apply);
    }
  };
  window.requestAnimationFrame(apply);
}

function rebuildReaderFromEditor(host: HTMLElement, state: WorkbenchState): boolean {
  const preview = state.editorMount?.preview();
  if (!preview || !state.payload) return false;
  state.sourcePosition = preview.sourcePosition;
  state.dirty = preview.dirty;
  host.dataset.dirty = preview.dirty ? "1" : "0";
  const nextPreviewKey = payloadKey(preview);
  if (state.previewKey === nextPreviewKey) return false;
  state.payload = {
    ...state.payload,
    source: preview.source,
    branch: preview.branch,
    branchExists: preview.branchExists,
    path: preview.path,
  };
  state.previewKey = nextPreviewKey;
  writePayload(host, state.payload);
  rebuildReader(host, state.payload);
  return true;
}

async function ensureEditor(host: HTMLElement, state: WorkbenchState): Promise<void> {
  if (state.editorLoaded || state.editorLoading) return;
  const root = editorRoot(host);
  if (!root) return;
  state.editorLoading = true;
  try {
    const mod = await import("./web-editor") as EditorModule;
    state.editorMount = mod.mountWebEditor(root, {
      onDirtyChange: (dirty) => {
        state.dirty = dirty;
        host.dataset.dirty = dirty ? "1" : "0";
        renderStatusControls((host.dataset.mode === "read" ? "read" : "edit"), dirty);
      },
      onSaved: (event) => {
        state.dirty = false;
        host.dataset.dirty = "0";
        if (state.payload) {
          state.payload = {
            ...state.payload,
            source: event.source,
            branch: event.branch,
            branchExists: true,
            path: event.path,
          };
          state.previewKey = payloadKey(state.payload);
          writePayload(host, state.payload);
          rebuildReader(host, state.payload);
        }
      },
    });
    state.editorLoaded = true;
  } finally {
    state.editorLoading = false;
  }
}

async function switchMode(host: HTMLElement, state: WorkbenchState, mode: WorkbenchMode, opts: { replace?: boolean } = {}): Promise<void> {
  if (mode === "read") rebuildReaderFromEditor(host, state);
  setVisibleMode(host, mode);
  setUrlMode(mode, opts.replace);
  if (mode === "read") applyReadSourcePosition(host, state.sourcePosition);
  if (mode === "edit") await ensureEditor(host, state);
}

function installModeClicks(host: HTMLElement, state: WorkbenchState): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest<HTMLElement>("[data-edit-mode-target]");
    const mode = trigger?.dataset.editModeTarget;
    if (mode !== "read" && mode !== "edit") return;
    event.preventDefault();
    void switchMode(host, state, mode);
  });
}

function installPopstate(host: HTMLElement, state: WorkbenchState): void {
  window.addEventListener("popstate", () => {
    const mode = activeModeFromUrl() ?? initialMode(host);
    void switchMode(host, state, mode, { replace: true });
  });
}

const host = shell();
if (host) {
  const state: WorkbenchState = {
    dirty: false,
    editorLoaded: false,
    editorLoading: false,
    editorMount: null,
    payload: readPayload(host),
    previewKey: null,
    sourcePosition: null,
  };
  if (state.payload) state.previewKey = payloadKey(state.payload);
  installModeClicks(host, state);
  installPopstate(host, state);
  const mode = initialMode(host);
  setVisibleMode(host, mode);
  setUrlMode(mode, true);
  if (mode === "edit") void ensureEditor(host, state);
}
