import {
  scrollReaderToSourcePosition,
  type SourcePosition,
  visibleSourcePositionInScroller,
} from "@chaoxu/coflat/reader";
import {
  mountRichReadonlyDocument,
  type MountedRichReadonlyDocument,
} from "@chaoxu/coflat/rich-readonly";
import {
  documentRailModel,
} from "../../shared/document-rail";
import { renderDocumentRail } from "./document-rail-dom";
import { readDocumentTheme, readSectionNumbering } from "./document-theme";
import {
  loadCoflatDocumentContext,
  type CoflatDocumentPayload,
} from "./coflat-document-context";
import type { WebEditorMount } from "./web-editor";
import { rewritePdfPreviewObjects } from "./pdf-preview-rewrite";
import "@chaoxu/coflat/document-surface.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

type WorkbenchMode = "read" | "edit";
type WorkbenchSourcePosition = SourcePosition & { viewportRatio?: number };
const MODE_SWITCH_VIEWPORT_RATIO = 0.5;
const URL_ANCHOR_TOP_OFFSET_PX = 8;

interface WorkbenchState {
  editorReady: Promise<WebEditorMount | null> | null;
  fastReadReady: Promise<MountedRichReadonlyDocument | null> | null;
  sourcePosition: WorkbenchSourcePosition | null;
  switchId: number;
}

interface WorkbenchConfig extends CoflatDocumentPayload {
  username: string;
}

function shell(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-edit-shell]");
}

function editorRoot(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("#web-editor-root");
}

function readWorkbenchConfig(): WorkbenchConfig | null {
  const mount = document.getElementById("web-editor-root");
  const payload = document.getElementById("web-editor-content");
  const repoConfigScript = document.getElementById("web-editor-repo-config");
  const assetPreviewsScript = document.getElementById("web-editor-asset-previews");
  if (!mount || !payload) return null;
  const repoConfig = repoConfigScript?.textContent
    ? JSON.parse(repoConfigScript.textContent) as {
      mathMacros?: Record<string, string>;
      bibliography?: string;
      csl?: string;
    }
    : {};
  const assetPreviewPaths = assetPreviewsScript?.textContent
    ? JSON.parse(assetPreviewsScript.textContent) as Record<string, string>
    : {};
  return {
    source: JSON.parse(payload.textContent || "\"\"") as string,
    owner: mount.dataset.owner ?? "",
    repo: mount.dataset.repo ?? "",
    path: mount.dataset.path ?? "",
    branch: mount.dataset.branch ?? "",
    branchExists: mount.dataset.branchExists !== "0",
    username: mount.dataset.username ?? "",
    renderTitle: true,
    sourcePositions: true,
    mathMacros: repoConfig.mathMacros ?? {},
    assetPreviewPaths,
    ...(repoConfig.bibliography ? { bibliography: repoConfig.bibliography } : {}),
    ...(repoConfig.csl ? { csl: repoConfig.csl } : {}),
  };
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
  host.classList.toggle("is-fast-read", mode === "read" && !host.querySelector(".cm-editor"));
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

function visibleContentViewportY(viewportRatio = MODE_SWITCH_VIEWPORT_RATIO): number | null {
  const content = document.querySelector<HTMLElement>(".app-content");
  const rect = content?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return null;
  return rect.top + rect.height * Math.max(0, Math.min(1, viewportRatio));
}

function fastReadScroller(host: HTMLElement): HTMLElement | null {
  const doc = host.querySelector<HTMLElement>(".web-editor-fast-doc");
  return doc?.closest<HTMLElement>(".doc-with-toc") ?? null;
}

function fastReadViewportRatio(scroller: HTMLElement): number {
  const viewportY = visibleContentViewportY();
  if (viewportY === null) return MODE_SWITCH_VIEWPORT_RATIO;
  const rect = scroller.getBoundingClientRect();
  if (rect.height <= 0) return MODE_SWITCH_VIEWPORT_RATIO;
  return Math.max(0, Math.min(1, (viewportY - rect.top) / rect.height));
}

function visibleFastReadSourcePosition(host: HTMLElement): WorkbenchSourcePosition | null {
  const scroller = fastReadScroller(host);
  if (!scroller) return null;
  return visibleSourcePositionInScroller(scroller, { viewportRatio: fastReadViewportRatio(scroller) });
}

function crossSurfaceSourcePosition(position: SourcePosition | null): WorkbenchSourcePosition | null {
  if (!position) return null;
  return {
    pos: position.pos,
    line: position.line,
    viewportRatio: position.viewportRatio ?? MODE_SWITCH_VIEWPORT_RATIO,
    ...(typeof position.viewportY === "number" && Number.isFinite(position.viewportY)
      ? { viewportY: position.viewportY }
      : {}),
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

function applyFastSourcePosition(host: HTMLElement, sourcePosition: WorkbenchSourcePosition | null): void {
  if (!sourcePosition) return;
  const scroller = fastReadScroller(host);
  if (!scroller) return;
  const viewportY = typeof sourcePosition.viewportY === "number" && Number.isFinite(sourcePosition.viewportY)
    ? sourcePosition.viewportY
    : (() => {
      const y = visibleContentViewportY(sourcePosition.viewportRatio ?? MODE_SWITCH_VIEWPORT_RATIO);
      return y === null ? null : y - URL_ANCHOR_TOP_OFFSET_PX;
    })();
  const scrollPosition = viewportY === null ? sourcePosition : { ...sourcePosition, viewportY };
  let frames = 0;
  const apply = () => {
    scrollReaderToSourcePosition(scroller, scrollPosition, {
      viewportRatio: fastReadViewportRatio(scroller),
    });
    frames += 1;
    if (frames < 8) window.requestAnimationFrame(apply);
  };
  window.requestAnimationFrame(apply);
}

function fastReadShellClass(username: string): string {
  const theme = readDocumentTheme(username);
  return theme === "blueprint-book"
    ? "web-editor-shell cf-theme-scope cf-theme-blueprint-book web-editor-fast-shell"
    : "web-editor-shell cf-theme-scope web-editor-fast-shell";
}

function installFastReadFrame(root: HTMLElement, username: string): { doc: HTMLElement; rail: HTMLElement } {
  root.replaceChildren();
  const shellEl = document.createElement("div");
  shellEl.className = fastReadShellClass(username);
  const layout = document.createElement("div");
  layout.className = "doc-with-toc";
  const main = document.createElement("div");
  main.className = "doc-main";
  const doc = document.createElement("div");
  doc.className = "web-editor-fast-doc";
  doc.dataset.testid = "editor-fast-readonly";
  const rail = document.createElement("aside");
  rail.className = "web-editor-outline doc-rail";
  rail.setAttribute("aria-label", "Document tools");
  rail.dataset.documentRail = "";
  main.append(doc);
  layout.append(main, rail);
  shellEl.append(layout);
  root.append(shellEl);
  return { doc, rail };
}

function renderFastRail(rail: HTMLElement, mounted: MountedRichReadonlyDocument): void {
  renderDocumentRail(
    rail,
    {
      ...documentRailModel({
        mode: "edit",
        readHref: window.location.href,
        controls: false,
        outline: (mounted.result.outline ?? []).map((entry) => ({
          key: entry.id,
          level: entry.level,
          label: entry.text,
          html: entry.html,
        })),
      }),
      mathMacros: mounted.result.mathMacros,
    },
    {
      onOutlineItem: (entry) => {
        const target = mounted.root.querySelector<HTMLElement>(`#${CSS.escape(entry.key)}`);
        target?.scrollIntoView({ block: "center" });
      },
    },
  );
  rail.hidden = mounted.result.outline?.length ? false : rail.hidden;
}

function ensureFastRead(host: HTMLElement, state: WorkbenchState): Promise<MountedRichReadonlyDocument | null> {
  if (state.fastReadReady) return state.fastReadReady;
  const root = editorRoot(host);
  const config = readWorkbenchConfig();
  if (!root || !config) return Promise.resolve(null);
  state.fastReadReady = (async () => {
    const { doc, rail } = installFastReadFrame(root, config.username);
    const context = await loadCoflatDocumentContext(config);
    const mounted = mountRichReadonlyDocument({
      root: doc,
      source: config.source,
      context,
      renderOptions: {
        documentPath: config.path,
        outline: true,
        referencePreviews: true,
        resolveReferences: true,
        sectionNumbering: readSectionNumbering(config.username),
        sourcePositions: true,
      },
      hydration: {
        disclosures: true,
        media: true,
        references: true,
        math: true,
        hoverPreviews: true,
      },
    });
    renderFastRail(rail, mounted);
    await mounted.ready;
    rewritePdfPreviewObjects(doc);
    return mounted;
  })();
  return state.fastReadReady;
}

function ensureEditor(host: HTMLElement, state: WorkbenchState): Promise<WebEditorMount | null> {
  if (state.editorReady) return state.editorReady;
  const root = editorRoot(host);
  if (!root) return Promise.resolve(null);
  state.editorReady = (async () => {
    const fastRead = await state.fastReadReady;
    fastRead?.dispose();
    const mod: typeof import("./web-editor") = await import("./web-editor");
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
  if (state.editorReady) {
    const mount = await ensureEditor(host, state);
    return crossSurfaceSourcePosition(mount?.preview()?.sourcePosition ?? visibleEditSourcePosition(host) ?? state.sourcePosition);
  }
  return visibleFastReadSourcePosition(host) ?? state.sourcePosition;
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
  setVisibleMode(host, mode);
  setUrlMode(mode, opts.replace);
  if (mode === "read" && !state.editorReady) {
    await ensureFastRead(host, state);
    applyFastSourcePosition(host, state.sourcePosition);
    return;
  }
  const mount = await ensureEditor(host, state);
  if (state.switchId !== switchId || host.dataset.mode !== mode) return;
  mount?.setReadOnly(mode === "read");
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
    fastReadReady: null,
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
  void ensureFastRead(host, state).then(() => {
    if (mode === "read") {
      applyFastSourcePosition(host, state.sourcePosition);
      return;
    }
    void ensureEditor(host, state).then((mount) => {
      if (!mount) return;
      mount.setReadOnly(false);
      applyEditorSourcePosition(mount, state.sourcePosition);
    });
  });
}
