import {
  DOCUMENT_RAIL_CONTROLS_CLASS,
  DOCUMENT_RAIL_CONTROLS_LABEL,
  DOCUMENT_RAIL_GROUP_CLASS,
  DOCUMENT_RAIL_OUTLINE_CLASS,
  DOCUMENT_RAIL_OUTLINE_LABEL,
  DOCUMENT_RAIL_OUTLINE_TITLE_CLASS,
  DOCUMENT_RAIL_SWITCH_CLASS,
  type DocumentRailControl,
  type DocumentRailModel,
  type DocumentRailGroup,
  type DocumentRailOutlineItem,
} from "../../shared/document-rail";
import { renderInertChromeInline } from "./chrome-inline";

export interface DocumentRailRenderModel extends DocumentRailModel {
  mathMacros?: Record<string, string>;
}

export interface DocumentRailRenderOptions {
  onControl?: (control: DocumentRailControl) => void;
  onOutlineItem?: (item: DocumentRailOutlineItem) => void;
}

export function renderDocumentRail(
  container: HTMLElement,
  model: DocumentRailRenderModel,
  opts: DocumentRailRenderOptions = {},
): void {
  const toggle = container.querySelector<HTMLElement>(":scope > .rail-collapse-toggle");
  const children = [renderControls(model.groups, opts), renderOutline(model.outline, model.mathMacros, opts)];
  container.replaceChildren(...(toggle ? [toggle, ...children] : children));
}

function renderControls(groups: readonly DocumentRailGroup[], opts: DocumentRailRenderOptions): HTMLElement {
  const controls = document.createElement("div");
  controls.className = DOCUMENT_RAIL_CONTROLS_CLASS;
  controls.setAttribute("aria-label", DOCUMENT_RAIL_CONTROLS_LABEL);
  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = DOCUMENT_RAIL_GROUP_CLASS;
    groupEl.setAttribute("aria-label", group.label);

    const switchEl = document.createElement("div");
    switchEl.className = DOCUMENT_RAIL_SWITCH_CLASS;
    for (const control of group.controls) {
      switchEl.appendChild(renderControl(control, opts));
    }
    groupEl.appendChild(switchEl);
    controls.appendChild(groupEl);
  }
  return controls;
}

function renderControl(control: DocumentRailControl, opts: DocumentRailRenderOptions): HTMLElement {
  const el = control.kind === "button" ? document.createElement("button") : document.createElement("a");
  if (control.kind === "button") {
    el.setAttribute("type", "button");
  } else {
    el.setAttribute("href", control.href ?? "#");
    if (control.modeLink) el.setAttribute("data-doc-mode-link", "");
  }
  if (control.active) {
    el.className = "active";
    el.setAttribute("aria-current", "page");
  }
  el.textContent = control.label;
  if (opts.onControl) {
    el.addEventListener("click", (event) => {
      if (control.kind !== "button") return;
      event.preventDefault();
      opts.onControl?.(control);
    });
  }
  return el;
}

function renderOutline(
  outline: readonly DocumentRailOutlineItem[],
  mathMacros: Record<string, string> | undefined,
  opts: DocumentRailRenderOptions,
): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = DOCUMENT_RAIL_OUTLINE_CLASS;
  nav.setAttribute("aria-label", DOCUMENT_RAIL_OUTLINE_LABEL);
  nav.hidden = outline.length < 1;

  const title = document.createElement("h2");
  title.className = DOCUMENT_RAIL_OUTLINE_TITLE_CLASS;
  title.textContent = DOCUMENT_RAIL_OUTLINE_LABEL;
  nav.appendChild(title);

  for (const item of outline) {
    const el = opts.onOutlineItem ? document.createElement("button") : document.createElement("a");
    if (opts.onOutlineItem) {
      el.setAttribute("type", "button");
      el.addEventListener("click", () => opts.onOutlineItem?.(item));
    } else {
      el.setAttribute("href", `#${item.key}`);
    }
    el.className = item.className;
    renderInertChromeInline(el, { html: item.html, fallback: item.label, mathMacros });
    nav.appendChild(el);
  }
  return nav;
}
