import { workspaceApiPath } from "../../shared/url";

interface LocalAnnotationMessage {
  author?: string;
  timestamp?: string;
  text: string;
}

interface LocalAnnotation {
  id: string;
  anchor: string;
  path: string;
  kind: "comment" | "task";
  status: "open" | "resolved";
  messages: LocalAnnotationMessage[];
  source_excerpt: { line: number; start_line: number; end_line: number; text: string } | null;
}

interface LocalAnnotationResponse {
  annotations: LocalAnnotation[];
}

interface InstallOptions {
  owner: string;
  repo: string;
  path: string;
  drawerParent?: HTMLElement;
}

export function installLocalAnnotations(root: HTMLElement, opts: InstallOptions): () => void {
  if (!opts.owner || !opts.repo || !opts.path) return () => {};
  const drawerParent = opts.drawerParent ?? root.parentElement ?? root;
  const drawer = document.createElement("section");
  drawer.className = "local-annotation-drawer";
  drawer.dataset.testid = "local-annotation-drawer";
  drawer.hidden = true;
  drawerParent.append(drawer);

  let annotations: LocalAnnotation[] = [];
  let activeId: string | null = null;
  let destroyed = false;

  const open = (id?: string | null) => {
    if (id) activeId = stripLocalPrefix(id);
    if (!activeId) activeId = annotations.find((annotation) => annotation.path === opts.path && annotation.status !== "resolved")?.id ?? null;
    drawer.hidden = false;
    render();
  };

  const close = () => {
    drawer.hidden = true;
  };

  const load = async () => {
    try {
      const res = await fetch(`${workspaceApiPath(opts.owner, opts.repo)}/local-annotations`, { credentials: "same-origin" });
      if (!res.ok) return;
      const body = await res.json() as LocalAnnotationResponse;
      annotations = body.annotations ?? [];
      applyHighlights(root, annotations);
      if (!drawer.hidden) render();
    } catch (_err) {
      return;
    }
  };

  const setStatus = async (id: string, status: LocalAnnotation["status"]) => {
    const res = await fetch(`${workspaceApiPath(opts.owner, opts.repo)}/local-annotations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return;
    const body = await res.json() as { annotation: LocalAnnotation };
    annotations = annotations.map((annotation) => annotation.id === id ? body.annotation : annotation);
    activeId = id;
    applyHighlights(root, annotations);
    render();
  };

  const render = () => {
    const currentPathAnnotations = annotations.filter((annotation) => annotation.path === opts.path);
    const unresolved = currentPathAnnotations.filter((annotation) => annotation.status !== "resolved");
    const active = currentPathAnnotations.find((annotation) => annotation.id === activeId) ?? unresolved[0] ?? currentPathAnnotations[0] ?? null;
    activeId = active?.id ?? null;
    drawer.replaceChildren();

    const header = document.createElement("header");
    header.className = "local-annotation-drawer-header";
    const title = document.createElement("strong");
    title.textContent = "Local annotations";
    const count = document.createElement("span");
    count.className = "local-annotation-count";
    count.textContent = `${unresolved.length} unresolved`;
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "local-annotation-close";
    closeButton.ariaLabel = "Close local annotations";
    closeButton.textContent = "x";
    closeButton.addEventListener("click", close);
    header.append(title, count, closeButton);

    const body = document.createElement("div");
    body.className = "local-annotation-drawer-body";
    const list = document.createElement("nav");
    list.className = "local-annotation-list";
    list.ariaLabel = "Local annotations";
    for (const annotation of currentPathAnnotations) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = annotation.id === active?.id ? "local-annotation-item active" : "local-annotation-item";
      item.textContent = `${annotation.kind} ${annotation.anchor}${annotation.status === "resolved" ? " (resolved)" : ""}`;
      item.addEventListener("click", () => {
        activeId = annotation.id;
        render();
      });
      list.append(item);
    }

    const detail = document.createElement("article");
    detail.className = "local-annotation-detail";
    if (active) {
      const meta = document.createElement("div");
      meta.className = "local-annotation-meta";
      meta.textContent = `${active.anchor} / ${active.status}`;
      detail.append(meta);
      for (const message of active.messages) {
        const p = document.createElement("p");
        p.className = "local-annotation-message";
        p.textContent = message.author ? `${message.author}: ${message.text}` : message.text;
        detail.append(p);
      }
      if (active.source_excerpt) {
        const excerpt = document.createElement("pre");
        excerpt.className = "local-annotation-excerpt";
        excerpt.textContent = active.source_excerpt.text;
        detail.append(excerpt);
      }
      const action = document.createElement("button");
      action.type = "button";
      action.className = "button small";
      action.textContent = active.status === "resolved" ? "Reopen" : "Resolve";
      action.addEventListener("click", () => {
        void setStatus(active.id, active.status === "resolved" ? "open" : "resolved");
      });
      detail.append(action);
    } else {
      const empty = document.createElement("p");
      empty.className = "local-annotation-empty";
      empty.textContent = "No local annotations for this file.";
      detail.append(empty);
    }

    body.append(list, detail);
    drawer.append(header, body);
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const anchor = target.closest<HTMLElement>("[data-local-annotation-id]");
    if (!anchor) return;
    event.preventDefault();
    open(anchor.dataset.localAnnotationId);
  };
  root.addEventListener("click", onClick);

  const observer = new MutationObserver(() => applyHighlights(root, annotations));
  observer.observe(root, { childList: true, subtree: true });
  void load();

  return () => {
    destroyed = true;
    root.removeEventListener("click", onClick);
    observer.disconnect();
    drawer.remove();
  };

  function applyHighlights(target: HTMLElement, records: readonly LocalAnnotation[]): void {
    if (destroyed) return;
    const byAnchor = new Map(records.map((annotation) => [annotation.anchor, annotation]));
    for (const element of target.querySelectorAll<HTMLElement>("[data-ref-key^='local:']")) {
      const key = element.dataset.refKey;
      if (!key) continue;
      element.classList.add("local-annotation-anchor");
      element.dataset.localAnnotationId = stripLocalPrefix(key);
      const record = byAnchor.get(key);
      element.classList.toggle("is-resolved", record?.status === "resolved");
      element.title = record ? `${record.kind}: ${record.status}` : "Local annotation";
      element.tabIndex = 0;
      element.setAttribute("role", "button");
    }
  }
}

function stripLocalPrefix(id: string): string {
  return id.startsWith("local:") ? id.slice("local:".length) : id;
}
