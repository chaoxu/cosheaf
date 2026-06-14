import { joinHtml, type Html } from "./web-html.js";

// Portable UI-panel seam (#120). A panel is a self-contained, server-rendered
// unit with a stable id that owns only its own content + classes and never
// assumes a container element. A host page places panels into named region
// slots (the left sidebar, the right rail, …) through `renderRegion`, so any
// panel can move between regions by changing a single placement — no markup
// rewrite and no page rewiring. This is a pure decoupling seam: panels render
// exactly where they do today.
export interface Panel {
  id: string;
  render: () => Html;
}

export function panel(id: string, render: () => Html): Panel {
  return { id, render };
}

// Render an ordered list of panels into a region. The caller's element is the
// region container; each panel renders only its own content into it.
export function renderRegion(panels: readonly Panel[]): Html {
  return joinHtml(panels.map((p) => p.render()));
}
