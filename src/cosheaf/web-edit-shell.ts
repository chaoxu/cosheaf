import {
  type SourcePosition,
  visibleSourcePositionInScroller,
} from "@chaoxu/coflat/reader";
import type { WebEditorMount, mountWebEditor } from "./web-editor";

type WorkbenchMode = "read" | "edit";
type WorkbenchSourcePosition = SourcePosition & { viewportRatio?: number };
const MODE_SWITCH_VIEWPORT_RATIO = 0.5;

interface EditorModule {
  mountWebEditor: typeof mountWebEditor;
}

interface WorkbenchState {
  editorReady: Promise<WebEditorMount | null> | null;
  sourcePosition: WorkbenchSourcePosition | null;
  switchId: number;
}

function shell(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-edit-shell]");
}

function editorRoot(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("#web-editor-root");
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

function sourcePositionFromUrl(): WorkbenchSourcePosition | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("source_from")) return null;
  const from = Number(params.get("source_from"));
  const toParam = params.get("source_to");
  const to = toParam === null ? from : Number(toParam);
  if (!Number.isInteger(from) || from < 0) return null;
  if (!Number.isInteger(to) || to < from) return null;
  return { pos: from, viewportRatio: MODE_SWITCH_VIEWPORT_RATIO };
}

function initialMode(host: HTMLElement): WorkbenchMode {
  return activeModeFromUrl() ?? (host.dataset.initialMode === "auto" ? preferredOpenMode() : host.dataset.initialMode === "read" ? "read" : "edit");
}

function setUrlMode(mode: WorkbenchMode, replace = false, opts: { keepSourceAnchor?: boolean } = {}): void {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  if (!opts.keepSourceAnchor) {
    url.searchParams.delete("source_from");
    url.searchParams.delete("source_to");
  }
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
  const actions = editorActionsSlot();
  if (actions) actions.hidden = mode !== "edit";
  const fileSlot = fileActionsSlot();
  if (fileSlot) fileSlot.hidden = mode !== "edit";
  renderStatusControls(mode, host.dataset.dirty === "1");
}

function visibleEditSourcePosition(host: HTMLElement): WorkbenchSourcePosition | null {
  const scroller = host.querySelector<HTMLElement>(".cm-scroller");
  if (!scroller || scroller.hidden) return null;
  return visibleSourcePositionInScroller(scroller, { viewportRatio: MODE_SWITCH_VIEWPORT_RATIO });
}

function crossSurfaceSourcePosition(position: SourcePosition | null): WorkbenchSourcePosition | null {
  if (!position) return null;
  return {
    pos: position.pos,
    line: position.line,
    viewportRatio: position.viewportRatio ?? MODE_SWITCH_VIEWPORT_RATIO,
  };
}

function applyEditorSourcePosition(mount: WebEditorMount | null | undefined, sourcePosition: WorkbenchSourcePosition | null): void {
  if (!sourcePosition) return;
  let frames = 0;
  const apply = () => {
    mount?.scrollToSourcePosition(sourcePosition);
    frames += 1;
    if (frames < 8) window.requestAnimationFrame(apply);
  };
  window.requestAnimationFrame(apply);
}

function ensureEditor(host: HTMLElement, state: WorkbenchState): Promise<WebEditorMount | null> {
  if (state.editorReady) return state.editorReady;
  const root = editorRoot(host);
  if (!root) return Promise.resolve(null);
  state.editorReady = (async () => {
    const mod = await import("./web-editor") as EditorModule;
    const mount = mod.mountWebEditor(root, {
      onDirtyChange: (dirty) => {
        host.dataset.dirty = dirty ? "1" : "0";
        renderStatusControls((host.dataset.mode === "read" ? "read" : "edit"), dirty);
      },
    }, { initialReadOnly: (host.dataset.mode === "read") });
    await mount.ready;
    return mount;
  })();
  return state.editorReady;
}

async function captureSourcePosition(
  host: HTMLElement,
  state: WorkbenchState,
): Promise<WorkbenchSourcePosition | null> {
  const mount = await ensureEditor(host, state);
  return crossSurfaceSourcePosition(mount?.preview()?.sourcePosition ?? visibleEditSourcePosition(host) ?? state.sourcePosition);
}

async function switchMode(host: HTMLElement, state: WorkbenchState, mode: WorkbenchMode, opts: { replace?: boolean } = {}): Promise<void> {
  if (host.dataset.mode === mode && !opts.replace) {
    state.switchId += 1;
    return;
  }
  const switchId = state.switchId + 1;
  state.switchId = switchId;
  const fromMode: WorkbenchMode = host.dataset.mode === "read" ? "read" : "edit";
  const sourcePosition = await captureSourcePosition(host, state);
  if (state.switchId !== switchId || host.dataset.mode !== fromMode) return;
  state.sourcePosition = sourcePosition ?? state.sourcePosition;
  const mount = await ensureEditor(host, state);
  if (state.switchId !== switchId || host.dataset.mode !== fromMode) return;
  setVisibleMode(host, mode);
  mount?.setReadOnly(mode === "read");
  setUrlMode(mode, opts.replace);
  applyEditorSourcePosition(mount, state.sourcePosition);
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
    editorReady: null,
    sourcePosition: null,
    switchId: 0,
  };
  installModeClicks(host, state);
  installPopstate(host, state);
  const mode = initialMode(host);
  const urlSourcePosition = sourcePositionFromUrl();
  if (urlSourcePosition) state.sourcePosition = urlSourcePosition;
  setVisibleMode(host, mode);
  setUrlMode(mode, true, { keepSourceAnchor: Boolean(urlSourcePosition) });
  void ensureEditor(host, state).then((mount) => {
    if (!mount) return;
    mount.setReadOnly(mode === "read");
    applyEditorSourcePosition(mount, state.sourcePosition);
  });
}
