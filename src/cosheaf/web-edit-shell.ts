import type { CoflatDocumentPayload } from "./coflat-document-context";

type WorkbenchMode = "read" | "edit";

interface EditorModule {
  mountWebEditor: (
    root: HTMLElement,
    callbacks?: {
      onDirtyChange?: (dirty: boolean) => void;
      onSaved?: (event: { source: string; branch: string; path: string; readHref: string }) => void;
    },
  ) => unknown;
}

interface WorkbenchState {
  dirty: boolean;
  editorLoaded: boolean;
  editorLoading: boolean;
  payload: CoflatDocumentPayload | null;
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

function renderStatusControls(mode: WorkbenchMode): void {
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
  renderStatusControls(mode);
}

function rebuildReader(host: HTMLElement, payload: CoflatDocumentPayload): void {
  const mount = readerMount(host);
  if (!mount) return;
  const island = document.createElement("div");
  island.className = "cf-reader cf-doc-surface cf-doc-flow coflat-reader-island";
  island.dataset.readerBranch = payload.branch;
  const script = document.createElement("script");
  script.type = "application/json";
  script.textContent = JSON.stringify(payload);
  island.append(script);
  mount.replaceChildren(island);
}

async function ensureEditor(host: HTMLElement, state: WorkbenchState): Promise<void> {
  if (state.editorLoaded || state.editorLoading) return;
  const root = editorRoot(host);
  if (!root) return;
  state.editorLoading = true;
  try {
    const mod = await import("./web-editor") as EditorModule;
    mod.mountWebEditor(root, {
      onDirtyChange: (dirty) => {
        state.dirty = dirty;
        host.dataset.dirty = dirty ? "1" : "0";
      },
      onSaved: (event) => {
        state.dirty = false;
        host.dataset.dirty = "0";
        if (state.payload) {
          state.payload = {
            ...state.payload,
            source: event.source,
            branch: event.branch,
            path: event.path,
          };
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
  if (mode === "read" && state.dirty && !window.confirm("Discard unsaved changes and switch to Read?")) return;
  setVisibleMode(host, mode);
  setUrlMode(mode, opts.replace);
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
    payload: readPayload(host),
  };
  installModeClicks(host, state);
  installPopstate(host, state);
  const mode = initialMode(host);
  setVisibleMode(host, mode);
  setUrlMode(mode, true);
  if (mode === "edit") void ensureEditor(host, state);
}
