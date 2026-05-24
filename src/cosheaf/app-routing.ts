export type WorkspaceSidebarView = "pages" | "inbox" | "issues" | "activity" | "outline" | "linter" | "settings";

export type RoutePath =
  | { kind: "workspaces" }
  | {
      kind: "workspace";
      slug: string;
      filePath: string | null;
      sidebarView?: WorkspaceSidebarView | null;
      issueNumber?: number | null;
      newIssue?: boolean;
    };

export function parseRoute(): RoutePath {
  const path = window.location.pathname;
  const m = /^\/w\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (m) {
    const filePath = m[2] ? decodeURIComponent(m[2]) : null;
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    const issue = Number(params.get("issue"));
    const sidebarView =
      view === "inbox" ||
      view === "issues" ||
      view === "activity" ||
      view === "outline" ||
      view === "linter" ||
      view === "settings"
        ? view
        : null;
    return {
      kind: "workspace",
      slug: m[1],
      filePath,
      sidebarView,
      issueNumber: Number.isInteger(issue) && issue > 0 ? issue : null,
      newIssue: params.get("newIssue") === "1",
    };
  }
  return { kind: "workspaces" };
}

export function routeUrl(r: RoutePath): string {
  if (r.kind === "workspaces") return "/";
  const base = r.filePath
    ? `/w/${r.slug}/${r.filePath.split("/").map(encodeURIComponent).join("/")}`
    : `/w/${r.slug}`;
  const params = new URLSearchParams();
  if (r.sidebarView && r.sidebarView !== "pages") params.set("view", r.sidebarView);
  if (r.issueNumber) params.set("issue", String(r.issueNumber));
  if (r.newIssue) params.set("newIssue", "1");
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function navigate(r: RoutePath, mode: "push" | "replace" = "push"): void {
  const url = routeUrl(r);
  if (window.location.pathname + window.location.search === url) return;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}
