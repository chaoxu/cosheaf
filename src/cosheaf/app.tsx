import type { ReactElement } from "react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COFLAT_FORMAT_ID, type DocumentFormatId } from "../../shared/document-format";
import { getClientDocumentFormat } from "./format-registry";
import { blueprintBookThemeManifest } from "@chaoxu/coflat-editor/reader";
import type { OutlineEntry } from "@chaoxu/coflat-editor";
import {
  ApiError,
  api,
  getStoredPat,
  type ActivityRow,
  type ApprovalRecord,
  type Backlink,
  type PrFiles,
  type Decision,
  type FileEntry,
  type IssueRow,
  type LineComment,
  type NotificationRow,
  type OpenPull,
  type PrMeta,
  type PullReviewEntry,
  type SearchResult,
  type User,
  type Workspace,
  type WorkspaceValidation,
} from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import { formatRelativeTime } from "./lib/format-relative-time";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
  userBranchPrefix,
} from "../../shared/conventions";
import { PrHeader } from "./review/PrHeader";
import { FileList } from "./review/FileList";
import { DiffArea } from "./review/DiffArea";
import { ReviewActions } from "./review/ReviewActions";
import { IssueBodyRender } from "./review/IssueBodyRender";
import { IssueView } from "./review/IssueView";
import { buildWorkspaceDocumentContext } from "./document-format/coflat-context";
import type {
  EditorAssetUploader,
  EditorAutocompleteSource,
  EditorSaveHandler,
  EditorStatusEvents,
  MountedEditor,
} from "./document-format/coflat-editor";
import { SettingsPanel } from "./review/SettingsPanel";
import { WorkspaceProvider, useWorkspaceContext } from "./workspace-context";
import { useReviewComments } from "./use-review-comments";

type View =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "workspaces"; user: User }
  | { kind: "workspace"; user: User; workspace: Workspace };

function SidebarTab({
  active,
  disabled,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "px-2 py-1 rounded hover:bg-[var(--cf-hover)] disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-[var(--cf-active)] font-medium",
      )}
    >
      {children}
    </button>
  );
}

function OutlinePanel({
  entries,
  onPick,
}: {
  entries: readonly OutlineEntry[];
  onPick: (line: number) => void;
}): ReactElement {
  if (entries.length === 0) {
    return <div className={cn("p-3 text-xs", muted)}>No headings.</div>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1 text-sm">
      {entries.map((e) => (
        <button
          key={e.key}
          type="button"
          onClick={() => onPick(e.line)}
          className="flex items-baseline gap-2 truncate px-3 py-0.5 text-left hover:bg-[var(--cf-hover)]"
          style={{ paddingLeft: `${(e.level - 1) * 12 + 12}px` }}
          title={e.text}
        >
          <span className={cn("text-xs", muted)}>{e.number ?? ""}</span>
          <span className="truncate">{e.text}</span>
        </button>
      ))}
    </div>
  );
}

function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const initial = user.username.slice(0, 1).toUpperCase();
  return (
    <div ref={ref} className={cn("mt-auto relative border-t", borderColor)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--cf-hover)]",
        )}
        title={user.username}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--cf-hover)] text-xs font-semibold">
          {initial}
        </span>
        <span className="truncate text-sm">{user.username}</span>
      </button>
      {open && (
        <div
          className={cn(
            "absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded border bg-[var(--cf-bg)] shadow-lg",
            borderColor,
          )}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--cf-hover)]"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// Focus-on-mount via ref instead of the `autoFocus` attribute. autoFocus
// fires during render before assistive tech has settled on the new view;
// programmatic focus after mount is the a11y-friendly equivalent.
function useFocusOnMount<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

function SlugInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  const ref = useFocusOnMount<HTMLInputElement>();
  return (
    <Input
      ref={ref}
      placeholder="slug (lowercase, dashes)"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NewFilePathInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): ReactElement {
  const ref = useFocusOnMount<HTMLInputElement>();
  return (
    <Input
      ref={ref}
      placeholder="path/to/note.md"
      data-testid="new-file-path"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const muted = "text-[var(--cf-muted)]";
const borderColor = "border-[var(--cf-border)]";
type DocumentThemeId = "default" | "blueprint-book";
const DOCUMENT_THEME_KEY = "cosheaf:document-theme";
const DOCUMENT_THEMES: Array<{ id: DocumentThemeId; label: string }> = [
  { id: "default", label: "Default" },
  { id: blueprintBookThemeManifest.id, label: blueprintBookThemeManifest.name },
];

function readDocumentTheme(): DocumentThemeId {
  if (typeof localStorage === "undefined") return "default";
  const value = localStorage.getItem(DOCUMENT_THEME_KEY);
  return value === "blueprint-book" ? value : "default";
}

function useDocumentTheme(): [DocumentThemeId, (theme: DocumentThemeId) => void] {
  const [documentTheme, setDocumentTheme] = useState<DocumentThemeId>(() => readDocumentTheme());
  useEffect(() => {
    localStorage.setItem(DOCUMENT_THEME_KEY, documentTheme);
  }, [documentTheme]);
  return [documentTheme, setDocumentTheme];
}

// URL ↔ view kind mapping. File-open state lives inside WorkspaceView for now;
// workspace switching and the workspaces list participate in browser history.
type RoutePath =
  | { kind: "workspaces" }
  | {
      kind: "workspace";
      slug: string;
      filePath: string | null;
      sidebarView?: WorkspaceSidebarView | null;
      issueNumber?: number | null;
      newIssue?: boolean;
    };

type WorkspaceSidebarView = "pages" | "inbox" | "issues" | "activity" | "outline" | "linter" | "settings";

function parseRoute(): RoutePath {
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

function routeUrl(r: RoutePath): string {
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

function navigate(r: RoutePath, mode: "push" | "replace" = "push"): void {
  const url = routeUrl(r);
  if (window.location.pathname + window.location.search === url) return;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function CosheafApp(): ReactElement {
  const [view, setView] = useState<View>({ kind: "loading" });
  const handleLogout = useCallback(() => {
    api.logout().finally(() => {
      navigate({ kind: "workspaces" }, "replace");
      setView({ kind: "login" });
    });
  }, []);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => {
        if (!user) {
          setView({ kind: "login" });
          return;
        }
        // Restore the route from the current URL (deep-link friendly).
        const r = parseRoute();
        if (r.kind === "workspace") {
          api
            .listWorkspaces()
            .then((wss) => {
              const ws = wss.find((w) => w.slug === r.slug);
              if (ws) setView({ kind: "workspace", user, workspace: ws });
              else {
                navigate({ kind: "workspaces" }, "replace");
                setView({ kind: "workspaces", user });
              }
            })
            .catch(() => {
              navigate({ kind: "workspaces" }, "replace");
              setView({ kind: "workspaces", user });
            });
        } else {
          setView({ kind: "workspaces", user });
        }
      })
      .catch(() => setView({ kind: "login" }));
  }, []);

  // Wire popstate → re-parse URL → reload the matching view. We don't have the
  // workspace list in scope here so reload-from-`me`-flow handles it.
  useEffect(() => {
    const handler = (): void => {
      if (view.kind === "loading" || view.kind === "login") return;
      const r = parseRoute();
      if (r.kind === "workspaces") setView({ kind: "workspaces", user: view.user });
      else if (r.kind === "workspace") {
        if (view.kind === "workspace" && view.workspace.slug === r.slug) return;
        api
          .listWorkspaces()
          .then((wss) => {
            const ws = wss.find((w) => w.slug === r.slug);
            if (ws) setView({ kind: "workspace", user: view.user, workspace: ws });
            else setView({ kind: "workspaces", user: view.user });
          })
          .catch(() => {
            navigate({ kind: "workspaces" }, "replace");
            setView({ kind: "workspaces", user: view.user });
          });
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [view]);

  if (view.kind === "loading") {
    return <div className="h-full" />;
  }
  if (view.kind === "login") {
    return (
      <LoginScreen
        onLoggedIn={(user) => {
          navigate({ kind: "workspaces" });
          setView({ kind: "workspaces", user });
        }}
      />
    );
  }
  if (view.kind === "workspaces") {
    return (
      <WorkspaceList
        user={view.user}
        onPick={(workspace) => {
          navigate({ kind: "workspace", slug: workspace.slug, filePath: null });
          setView({ kind: "workspace", user: view.user, workspace });
        }}
        onLogout={handleLogout}
      />
    );
  }
  return (
    <WorkspaceView
      user={view.user}
      workspace={view.workspace}
      onBack={() => {
        navigate({ kind: "workspaces" });
        setView({ kind: "workspaces", user: view.user });
      }}
      onLogout={handleLogout}
    />
  );
}

function Topbar({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <header
      className={cn("flex items-center gap-3 px-4 py-2 border-b", borderColor)}
    >
      {children}
    </header>
  );
}

function Screen({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): ReactElement {
  return <div className={cn("flex h-full flex-col", className)}>{children}</div>;
}

function ContentPane({ children }: { children: React.ReactNode }): ReactElement {
  return <main className="mx-auto w-full max-w-3xl px-8 py-6">{children}</main>;
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: (user: User) => void }): ReactElement {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useFocusOnMount<HTMLInputElement>();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const loginUsername = username.trim();
    if (!loginUsername || !password) return;
    setBusy(true);
    setError(null);
    api
      .login(loginUsername, password)
      .then(onLoggedIn)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Login failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={submit}
        className={cn("flex w-80 flex-col gap-3 rounded-lg border p-7", borderColor)}
      >
        <h1 className="mb-2 text-[22px] font-semibold">cosheaf</h1>
        <div className={cn("flex flex-col gap-1 text-xs", muted)}>
          <label htmlFor="login-username">username</label>
          <Input
            id="login-username"
            ref={usernameRef}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div className={cn("flex flex-col gap-1 text-xs", muted)}>
          <label htmlFor="login-password">password</label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <div className="py-2 text-red-600">{error}</div>}
        <Button type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? "..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function WorkspaceList({
  user,
  onPick,
  onLogout,
}: {
  user: User;
  onPick: (workspace: Workspace) => void;
  onLogout: () => void;
}): ReactElement {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");

  const load = useCallback(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Failed to load"),
      );
  }, []);

  useEffect(load, [load]);

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    api
      .createWorkspace(newSlug, newName)
      .then(() => {
        setNewSlug("");
        setNewName("");
        setCreating(false);
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Create failed"),
      );
  };

  return (
    <Screen>
      <Topbar>
        <strong>cosheaf</strong>
        <span className="flex-1" />
        <span className={muted}>{user.username}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
        >
          Sign out
        </Button>
      </Topbar>
      <ContentPane>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "+ New"}
          </Button>
        </div>

        {creating && (
          <form onSubmit={handleCreate} className="mb-3 flex gap-2">
            <SlugInput value={newSlug} onChange={setNewSlug} />
            <Input
              placeholder="display name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" disabled={!newSlug || !newName}>
              Create
            </Button>
          </form>
        )}

        {error && <div className="py-2 text-red-600">{error}</div>}
        {workspaces && workspaces.length === 0 && (
          <div className={muted}>No workspaces yet. Create one to get started.</div>
        )}
        {workspaces && workspaces.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {workspaces.map((ws) => (
              <li key={ws.slug}>
                <button
                  type="button"
                  data-testid={`workspace-${ws.slug}`}
                  onClick={() => onPick(ws)}
                  className="flex w-full items-center gap-2.5 rounded-md px-4 py-3 text-left hover:bg-[var(--cf-hover)]"
                >
                  <strong>{ws.name}</strong>
                  <span className={muted}>/{ws.slug}</span>
                  <span
                    className={cn(
                      "ml-auto text-[10px] uppercase tracking-wider",
                      muted,
                    )}
                  >
                    {ws.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ContentPane>
    </Screen>
  );
}

function SidePanel({
  title,
  children,
}: {
  title: ReactElement | string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "max-h-[30%] overflow-y-auto border-t px-4 pb-3 pt-2",
        borderColor,
      )}
    >
      <div
        className={cn(
          "mb-1 text-[11px] uppercase tracking-wider",
          muted,
        )}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function BacklinksPanel({
  links,
  onPick,
}: {
  links: Backlink[];
  onPick: (srcPath: string) => void;
}): ReactElement {
  return (
    <SidePanel title={`Backlinks${links.length > 0 ? ` (${links.length})` : ""}`}>
      {links.length === 0 && <div className={cn("text-xs px-2 py-1", muted)}>None.</div>}
      {links.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {links.map((bl) => (
            <li key={`${bl.src_id}-${bl.target_label}`}>
              <button
                type="button"
                onClick={() => onPick(bl.src_path)}
                className={cn(
                  "rounded px-1 py-0.5 text-left hover:bg-[var(--cf-hover)]",
                )}
              >
                <strong>{bl.src_title ?? bl.src_path}</strong>{" "}
                <span className={cn("text-xs", muted)}>{bl.target_label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}

function LinterPanel({
  result,
  onRefresh,
  onOpenPath,
}: {
  result: WorkspaceValidation | null;
  onRefresh: () => void;
  onOpenPath: (path: string, line: number | null) => void;
}): ReactElement {
  const broken = result?.broken_refs ?? [];
  const orphans = result?.orphan_labels ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 px-2 py-1">
        <strong>Linter</strong>
        <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh linter">↻</Button>
      </div>
      {!result ? (
        <div className={cn("px-3 py-2 text-xs", muted)}>Checking references…</div>
      ) : broken.length === 0 && orphans.length === 0 ? (
        <div className={cn("px-3 py-2 text-xs", muted)}>No reference issues.</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {broken.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
                Broken references
              </div>
              <ul className="m-0 p-0">
                {broken.map((r) => (
                  <li key={`${r.source_id}-${r.target_label}`}>
                    <FileRow
                      onClick={() => onOpenPath(r.source_path, r.line)}
                      testId={`lint-broken-${r.source_id}-${r.target_label}`}
                    >
                      <strong>{r.target_label}</strong>
                      <span className={cn("text-xs", muted)}>
                        {` in ${r.source_title ?? r.source_path}${r.line ? `:${r.line}` : ""}`}
                      </span>
                    </FileRow>
                  </li>
                ))}
              </ul>
            </>
          )}
          {orphans.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
                Orphan ids
              </div>
              <ul className="m-0 p-0">
                {orphans.map((o) => (
                  <li key={o.id}>
                    <FileRow
                      onClick={() => onOpenPath(o.path, null)}
                      testId={`lint-orphan-${o.id}`}
                    >
                      <strong>{o.id}</strong>
                      <span className={cn("text-xs", muted)}>
                        {` ${o.title ?? o.path}`}
                      </span>
                    </FileRow>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}


function InboxOrActivity({
  kind,
  reviewPulls,
  openPrs,
  issues,
  pinned,
  activities,
  notifications,
  scope,
  setScope,
  query,
  setQuery,
  onRefresh,
  onOpenPullReview,
  onOpenIssue,
  onOpenPr,
  onMarkNotifRead,
  onMarkAllNotifsRead,
  onNewIssue,
  canWrite,
}: {
  kind: "inbox" | "issues" | "activity";
  reviewPulls: readonly PullReviewEntry[];
  openPrs: readonly OpenPull[];
  issues: readonly IssueRow[];
  pinned: readonly IssueRow[];
  activities: readonly ActivityRow[];
  notifications: readonly NotificationRow[];
  scope: "mine" | "all";
  setScope: (s: "mine" | "all") => void;
  query: string;
  setQuery: (q: string) => void;
  onRefresh: () => void;
  onOpenPullReview: (entry: PullReviewEntry) => void;
  onOpenIssue: (number: number) => void;
  onOpenPr: (number: number) => void;
  onMarkNotifRead: (id: number) => void;
  onMarkAllNotifsRead: () => void;
  onNewIssue: () => void;
  canWrite: boolean;
}): ReactElement {
  const isInbox = kind === "inbox";
  const isIssues = kind === "issues";
  // In Inbox+Mine: only PRs awaiting your review.
  // In Inbox+All or Activity: every open PR in the workspace.
  // Issues is issue-only.
  const useOpenList = !isIssues && (!isInbox || scope === "all");
  const q = query.trim().toLowerCase();
  const sourcePulls: PullReviewEntry[] = useOpenList
    ? openPrs.map((p) => ({ ...p, approvals: 0, rejections: 0 }))
    : [...reviewPulls];
  const visiblePulls = q
    ? sourcePulls.filter((qe) => qe.title.toLowerCase().includes(q))
    : sourcePulls;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 px-2 py-1">
        <strong>{isInbox ? "Inbox" : isIssues ? "Issues" : "Activity"}</strong>
        <div className="flex items-center gap-1">
          {(isInbox || isIssues) && (
            <div className="flex text-[10px] uppercase tracking-wide">
              <button
                type="button"
                onClick={() => setScope("mine")}
                className={cn("px-1.5 py-0.5 rounded", scope === "mine" && "bg-[var(--cf-hover)]")}
              >
                Mine
              </button>
              <button
                type="button"
                onClick={() => setScope("all")}
                className={cn("px-1.5 py-0.5 rounded", scope === "all" && "bg-[var(--cf-hover)]")}
              >
                All
              </button>
            </div>
          )}
          <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh">↻</Button>
          {canWrite && (
            <Button
              variant="outline"
              size="sm"
              onClick={onNewIssue}
              data-testid="new-issue"
              aria-label="New issue"
            >
              + Issue
            </Button>
          )}
        </div>
      </div>
      <div className="px-2 pb-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title…"
          data-testid="inbox-search"
          className="h-7 text-xs"
        />
      </div>
      {visiblePulls.length === 0 && issues.length === 0 && notifications.length === 0 && (
        <div className={cn("px-3 py-2 text-xs", muted)}>
          {isInbox ? "Nothing waiting on you." : isIssues ? "No open issues." : "No open activity."}
        </div>
      )}
      {isInbox && notifications.length > 0 && (
        <>
          <div
            className="flex items-center justify-between px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70"
            data-testid="notifs-section"
          >
            <span>Notifications</span>
            <button
              type="button"
              className="text-[10px] normal-case opacity-80 hover:opacity-100 underline"
              onClick={onMarkAllNotifsRead}
              data-testid="notifs-mark-all-read"
              aria-label="Mark all notifications read"
            >
              mark all read
            </button>
          </div>
          <ul className="m-0 p-0">
            {notifications.map((n) => (
              <li key={`notif-${n.id}`}>
                <FileRow
                  onClick={() => {
                    onMarkNotifRead(n.id);
                    if (n.kind === "pr") onOpenPr(n.number);
                    else onOpenIssue(n.number);
                  }}
                  testId={`notif-${n.id}`}
                >
                  {n.kind === "pr" ? (
                    <span className="text-[10px] uppercase tracking-wide bg-blue-500/15 text-blue-700 rounded px-1 mr-1">PR</span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-800 rounded px-1 mr-1">ISSUE</span>
                  )}
                  <strong>{n.title}</strong>
                  <span className={cn("text-xs ml-1", muted)}>
                    {`#${n.number} · ${formatTime(n.updated_at)}`}
                  </span>
                </FileRow>
              </li>
            ))}
          </ul>
        </>
      )}
      {visiblePulls.length > 0 && (
        <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
          {useOpenList ? "Open pull requests" : "Pull requests awaiting your review"}
        </div>
      )}
      <ul className="m-0 p-0">
        {visiblePulls.map((entry) => (
          <li key={`pr-${entry.number}`}>
            <FileRow onClick={() => onOpenPullReview(entry)} testId={`review-pull-${entry.number}`}>
              <span className="text-[10px] uppercase tracking-wide bg-blue-500/15 text-blue-700 rounded px-1 mr-1">PR</span>
              <strong>{entry.title}</strong>
              <span className={cn("text-xs", muted)}>
                {entry.approvals > 0 && ` ✓${entry.approvals}`}
                {entry.rejections > 0 && ` ✗${entry.rejections}`}
                {` #${entry.number}`}
              </span>
            </FileRow>
          </li>
        ))}
      </ul>
      {!isInbox && !isIssues && activities.length > 0 && (
        <>
          <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
            Recent activity
          </div>
          <ul className="m-0 p-0 max-h-64 overflow-y-auto">
            {activities.slice(0, 30).map((a) => (
              <li key={`act-${a.id}`} className={cn("px-2 py-1 text-xs leading-snug")}>
                <ActivityLine row={a} onOpenIssue={onOpenIssue} onOpenPr={onOpenPr} />
              </li>
            ))}
          </ul>
        </>
      )}
      {pinned.length > 0 && (
        <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
          Pinned
        </div>
      )}
      <ul className="m-0 p-0">
        {pinned.map((iss) => (
          <li key={`pinned-${iss.number}`}>
            <FileRow onClick={() => onOpenIssue(iss.number)} testId={`pinned-issue-${iss.number}`}>
              <span className="text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-800 rounded px-1 mr-1">ISSUE</span>
              <span aria-hidden className="mr-1">📌</span>
              <strong>{iss.title}</strong>
              <span className={cn("text-xs", muted)}>
                {iss.comment_count > 0 && ` 💬${iss.comment_count}`}
                {` #${iss.number}`}
              </span>
            </FileRow>
          </li>
        ))}
      </ul>
      {issues.length > 0 && (
        <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
          {isInbox || isIssues ? (scope === "mine" ? "Your issues" : "Issues") : "Open issues"}
        </div>
      )}
      <ul className="m-0 flex-1 overflow-y-auto p-0">
        {issues
          .filter((iss) => !pinned.some((p) => p.number === iss.number))
          .filter((iss) => !q || iss.title.toLowerCase().includes(q))
          .map((iss) => (
          <li key={`issue-${iss.number}`}>
            <FileRow onClick={() => onOpenIssue(iss.number)} testId={`issue-${iss.number}`}>
              <span className="text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-800 rounded px-1 mr-1">ISSUE</span>
              <strong>{iss.title}</strong>
              <span className={cn("text-xs", muted)}>
                {iss.comment_count > 0 && ` 💬${iss.comment_count}`}
                {` #${iss.number}`}
              </span>
            </FileRow>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivityLine({
  row,
  onOpenIssue,
  onOpenPr,
}: {
  row: ActivityRow;
  onOpenIssue: (n: number) => void;
  onOpenPr: (n: number) => void;
}): ReactElement {
  const desc = describeOpType(row);
  return (
    <div className={cn("flex items-baseline gap-1", muted)}>
      <strong className="text-[var(--cf-fg)]">@{row.author_username ?? "?"}</strong>
      <span>{desc.verb}</span>
      {desc.targetKind && desc.targetNumber !== null && (() => {
        const n = desc.targetNumber;
        const kind = desc.targetKind;
        return (
          <button
            type="button"
            className="text-[var(--cf-accent)] hover:underline"
            onClick={() => (kind === "pr" ? onOpenPr(n) : onOpenIssue(n))}
          >
            {kind === "pr" ? "PR" : "issue"} #{n}
          </button>
        );
      })()}
      {desc.extra && <span className="opacity-75">{desc.extra}</span>}
    </div>
  );
}

function describeOpType(row: ActivityRow): {
  verb: string;
  targetKind: "issue" | "pr" | null;
  targetNumber: number | null;
  extra: string | null;
} {
  const n = row.ref_index;
  switch (row.op_type) {
    case "create_issue":
      return { verb: "opened", targetKind: "issue", targetNumber: n, extra: null };
    case "close_issue":
      return { verb: "closed", targetKind: "issue", targetNumber: n, extra: null };
    case "reopen_issue":
      return { verb: "reopened", targetKind: "issue", targetNumber: n, extra: null };
    case "comment_issue":
      return { verb: "commented on", targetKind: "issue", targetNumber: n, extra: null };
    case "create_pull_request":
      return { verb: "opened", targetKind: "pr", targetNumber: n, extra: null };
    case "close_pull_request":
      return { verb: "closed", targetKind: "pr", targetNumber: n, extra: null };
    case "reopen_pull_request":
      return { verb: "reopened", targetKind: "pr", targetNumber: n, extra: null };
    case "merge_pull_request":
      return { verb: "merged", targetKind: "pr", targetNumber: n, extra: null };
    case "comment_pull":
      return { verb: "commented on", targetKind: "pr", targetNumber: n, extra: null };
    case "pull_review":
    case "approve_pull_request":
      return { verb: "approved", targetKind: "pr", targetNumber: n, extra: null };
    case "reject_pull_request":
      return { verb: "requested changes on", targetKind: "pr", targetNumber: n, extra: null };
    case "push":
      return { verb: "pushed to", targetKind: null, targetNumber: null, extra: row.ref_name };
    case "create_branch":
      return { verb: "created branch", targetKind: null, targetNumber: null, extra: row.ref_name };
    case "delete_branch":
      return { verb: "deleted branch", targetKind: null, targetNumber: null, extra: row.ref_name };
    default:
      return { verb: row.op_type.replace(/_/g, " "), targetKind: null, targetNumber: null, extra: null };
  }
}

function ApprovalsPanel({
  approvals,
  lineCommentCount = 0,
}: {
  approvals: ApprovalRecord[];
  lineCommentCount?: number;
}): ReactElement {
  const { slug: workspaceSlug, formatId, documentContext } = useWorkspaceContext();
  // Latest verdict per reviewer (excluding "comment", which is just activity).
  const verdictByUser = new Map<string, ApprovalRecord>();
  for (const a of approvals) {
    if (a.decision === "comment") continue;
    const existing = verdictByUser.get(a.username);
    if (!existing || a.created_at > existing.created_at) {
      verdictByUser.set(a.username, a);
    }
  }
  const verdicts = Array.from(verdictByUser.values()).sort((a, b) => a.created_at - b.created_at);

  const approvedCount = verdicts.filter((v) => v.decision === "approve").length;
  const changesRequestedCount = verdicts.filter((v) => v.decision === "request_changes").length;

  // Activity list: only entries with a body or a non-comment decision.
  const meaningful = approvals.filter(
    (a) => (a.comment && a.comment.trim().length > 0) || a.decision !== "comment",
  );

  return (
    <SidePanel title="Reviews">
      <div className="px-2 py-1 flex flex-col gap-2">
        {/* Verdicts strip */}
        {verdicts.length === 0 ? (
          <div className={cn("text-xs", muted)}>No verdict yet.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5 items-center">
            {verdicts.map((v) => (
              <span
                key={v.username}
                data-testid={`verdict-${v.decision}-${v.username}`}
                className={cn(
                  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs",
                  v.decision === "approve"
                    ? "bg-green-500/15 text-green-700"
                    : "bg-red-500/15 text-red-700",
                )}
                title={v.comment ?? ""}
              >
                <span aria-hidden>{v.decision === "approve" ? "✓" : "✗"}</span>
                <strong>{v.username}</strong>
                <span className={muted}>·</span>
                <span>{v.decision === "approve" ? "approved" : "changes requested"}</span>
              </span>
            ))}
          </div>
        )}

        {/* One-line counters */}
        <div className={cn("text-xs", muted)}>
          {approvedCount > 0 && <span>{approvedCount} approved</span>}
          {approvedCount > 0 && (changesRequestedCount > 0 || lineCommentCount > 0) && " · "}
          {changesRequestedCount > 0 && <span>{changesRequestedCount} requested changes</span>}
          {changesRequestedCount > 0 && lineCommentCount > 0 && " · "}
          {lineCommentCount > 0 && <span>{lineCommentCount} line comment{lineCommentCount === 1 ? "" : "s"}</span>}
          {approvedCount === 0 && changesRequestedCount === 0 && lineCommentCount === 0 && (
            <span>No activity yet</span>
          )}
        </div>

        {/* Activity timeline (only entries with body or verdict) */}
        {meaningful.length > 0 && (
          <ol className="flex flex-col gap-1.5 mt-1 border-t border-[var(--cf-border)] pt-1.5">
            {meaningful.map((a) => (
              <li
                key={`${a.username}-${a.created_at}`}
                className="flex flex-col gap-0.5"
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <span aria-hidden className={
                    a.decision === "approve"
                      ? "text-green-700"
                      : a.decision === "request_changes"
                        ? "text-red-700"
                        : muted
                  }>
                    {a.decision === "approve" ? "✓" : a.decision === "request_changes" ? "✗" : "•"}
                  </span>
                  <strong>{a.username}</strong>
                  <span className={muted}>{formatTime(a.created_at)}</span>
                </div>
                {a.comment && (
                  <div className="text-xs pl-4 break-words">
                    <IssueBodyRender
                      text={a.comment}
                      workspaceSlug={workspaceSlug}
                      formatId={formatId}
                      ctx={documentContext}
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </SidePanel>
  );
}

// formatTime is the shared `formatRelativeTime` from lib (also used by
// CommentThread and IssueView). Keep a local alias to avoid touching every
// call site name in this large file.
const formatTime = formatRelativeTime;

function FileRow({
  active,
  title,
  onClick,
  children,
  testId,
}: {
  active?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] text-[var(--cf-fg)] hover:bg-[var(--cf-hover)]",
        active && "bg-[var(--cf-active)] font-medium",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
          </button>
  );
}

function WorkspaceStatusBar({
  activeFormatId,
  busy,
  currentBranchName,
  dirty,
  documentTheme,
  editorMode,
  openPath,
  reviewingPullNumber,
  role,
  status,
  onDocumentThemeChange,
  onOpenPullRequest,
  onSave,
  onToggleEditorMode,
}: {
  activeFormatId: DocumentFormatId;
  busy: boolean;
  currentBranchName: string | null;
  dirty: boolean;
  documentTheme: DocumentThemeId;
  editorMode: "rich" | "source";
  openPath: string | null;
  reviewingPullNumber: number | null;
  role: Workspace["role"];
  status: string | null;
  onDocumentThemeChange: (theme: DocumentThemeId) => void;
  onOpenPullRequest: (mode: "direct" | "review") => void;
  onSave: () => void;
  onToggleEditorMode: () => void;
}): ReactElement {
  return (
    <div
      data-statusbar
      data-testid="statusbar"
      className={cn(
        "shrink-0 flex min-w-0 items-center gap-2 border-t px-2 h-6 text-xs",
        muted,
        borderColor,
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {openPath ? (
          <>
            <span className="truncate">{openPath}</span>
            {dirty && <span className="text-[var(--cf-accent)]">●</span>}
          </>
        ) : reviewingPullNumber ? null : (
          <span>no file open</span>
        )}
      </div>
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <span className="truncate">{status ?? ""}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {activeFormatId === COFLAT_FORMAT_ID && (
          <select
            value={documentTheme}
            onChange={(e) => onDocumentThemeChange(e.target.value as DocumentThemeId)}
            title="Document theme"
            data-testid="document-theme-select"
            className="h-5 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1 text-xs text-[var(--cf-fg)]"
          >
            {DOCUMENT_THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
        )}
        {openPath && (
          <>
            {activeFormatId === COFLAT_FORMAT_ID && (
              <button
                type="button"
                onClick={onToggleEditorMode}
                title={editorMode === "rich" ? "Switch to source mode" : "Switch to rich mode"}
                className="px-1.5 rounded hover:bg-[var(--cf-hover)]"
              >
                {editorMode === "rich" ? "Source" : "Rich"}
              </button>
            )}
            {role !== "read" && (
              <button
                type="button"
                onClick={onSave}
                disabled={!dirty || busy || !!reviewingPullNumber}
                className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
              >
                Save
              </button>
            )}
            {currentBranchName && role !== "read" && (
              <>
                <span data-testid="active-branch-name" className="hidden">
                  {currentBranchName}
                </span>
                {role === "admin" && (
                  <button
                    type="button"
                    data-testid="merge-branch"
                    onClick={() => onOpenPullRequest("direct")}
                    disabled={busy}
                    title="Squash-merge this branch into main (⇧⌘P)"
                    className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                  >
                    Merge to main
                  </button>
                )}
                <button
                  type="button"
                  data-testid="open-pull-request"
                  onClick={() => onOpenPullRequest("review")}
                  disabled={busy}
                  title="Open a pull request for this branch"
                  className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                >
                  Open pull request
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WorkspaceView({
  user,
  workspace,
  onBack,
  onLogout,
}: {
  user: User;
  workspace: Workspace;
  onBack: () => void;
  onLogout: () => void;
}): ReactElement {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const workspaceCtx = useMemo(() => buildWorkspaceDocumentContext({ files }), [files]);
  const [activeFormatId, setActiveFormatId] = useState(workspace.default_md_format);
  useEffect(() => {
    setActiveFormatId(workspace.default_md_format);
  }, [workspace.default_md_format]);
  const ActiveMarkdownEditor = useMemo(
    () => lazy(getClientDocumentFormat(activeFormatId).editor),
    [activeFormatId],
  );
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<FileEntry["doc"] | undefined>(undefined);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [reviewPulls, setReviewPulls] = useState<PullReviewEntry[] | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const [sidebarView, setSidebarView] = useState<WorkspaceSidebarView>("pages");
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [issuesScope, setIssuesScope] = useState<"mine" | "all">("mine");
  const [inboxQuery, setInboxQuery] = useState("");
  const [openPrs, setOpenPrs] = useState<OpenPull[] | null>(null);
  const [pinnedIssues, setPinnedIssues] = useState<IssueRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [validation, setValidation] = useState<WorkspaceValidation | null>(null);
  const [pendingScroll, setPendingScroll] = useState<{ path: string; line: number } | null>(null);
  const [viewingIssue, setViewingIssue] = useState<number | null>(null);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [newIssueBusy, setNewIssueBusy] = useState(false);
  const editorRef = useRef<MountedEditor | null>(null);
  const [editorMode, setEditorMode] = useState<"rich" | "source">("rich");
  const [documentTheme, setDocumentTheme] = useDocumentTheme();
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [reviewingPullNumber, setReviewingPullNumber] = useState<number | null>(null);
  const [reviewState, setReviewState] = useState<{
    pr: PrMeta | null;
    diff: PrFiles | null;
    comments: LineComment[];
    selectedPath: string | null;
    busy: boolean;
    pendingReviewId: number | null;
  }>({ pr: null, diff: null, comments: [], selectedPath: null, busy: false, pendingReviewId: null });
  // The active writable branch, set synchronously from save responses to avoid
  // racing a separate branch-list refresh.
  const [currentBranchName, setCurrentBranchName] = useState<string | null>(null);
  const [reviewBranchName, setReviewBranchName] = useState<string | null>(null);
  const [branchesReady, setBranchesReady] = useState(false);
  // Tree + file reads run against whichever branch is "active": the review's
  // head when in review mode, otherwise the user's working branch (or main).
  const activeBranchName = reviewBranchName ?? currentBranchName;
  const filesRef = useRef<FileEntry[] | null>(null);
  const openRequestRef = useRef(0);

  // Sequence id for tree fetches: any in-flight tree response that isn't
  // the *latest* request is dropped. Without this, the initial-mount fetch
  // against `main` can resolve after a post-create fetch against the new
  // branch and silently overwrite the fresh tree.
  const treeReqSeqRef = useRef(0);
  const loadTree = useCallback(
    (branch?: string) => {
      const seq = ++treeReqSeqRef.current;
      return api
        .tree(workspace.slug, branch)
        .then((next) => {
          if (treeReqSeqRef.current === seq) setFiles(next);
        })
        .catch((err: unknown) => {
          if (treeReqSeqRef.current === seq)
            setStatus(err instanceof ApiError ? err.message : "Failed to load tree");
        });
    },
    [workspace.slug],
  );
  const reloadTree = useCallback(() => {
    void loadTree(activeBranchName ?? undefined);
  }, [loadTree, activeBranchName]);

  useEffect(reloadTree, [reloadTree]);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // "My branches" = branches I authored that don't have an open PR yet.
  // Auto-select when there's exactly one; keep an already-selected branch if
  // it still appears in the list (don't clobber a freshly-created one).
  const reloadBranches = useCallback((markReady = false) => {
    if (markReady) setBranchesReady(false);
    api
      .myBranches(workspace.slug)
      .then((branches) => {
        setCurrentBranchName((current) => {
          // If the user has an explicit branch selected, keep it. Forgejo's
          // branch listing is eventually consistent — a branch we just
          // created via PUT /file may take a beat to appear in /branches/mine,
          // and clearing the selection in the interim wipes the open-pull-request
          // affordance and the post-save tree refresh.
          if (current) return current;
          return branches.length === 1 ? (branches[0]?.name ?? null) : null;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (markReady) setBranchesReady(true);
      });
  }, [workspace.slug]);

  useEffect(() => {
    reloadBranches(true);
  }, [reloadBranches]);

  const openPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const reviewingPullNumberRef = useRef<number | null>(null);
  // Tracks the branch the currently-open file was last fetched against, so
  // background refetches (e.g. SSE-driven refreshes) keep hitting the same
  // branch even after currentBranchName is nulled by opening a pull request.
  const openFileBranchRef = useRef<string | null>(null);
  useEffect(() => {
    openPathRef.current = openPath;
  }, [openPath]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    reviewingPullNumberRef.current = reviewingPullNumber;
  }, [reviewingPullNumber]);

  // Hold the reload callbacks in refs so the SSE effect can stay mounted across
  // PR switches and branch changes. Depending on `reloadTree` directly caused
  // a tear-down/reconnect of the EventSource every time `activeBranchName`
  // shifted, which kicked off a reconnect storm during reviews and saves.
  const reloadTreeRef = useRef(reloadTree);
  const reloadBranchesRef = useRef(reloadBranches);
  const refreshPullsRef = useRef<() => void>(() => {});
  useEffect(() => {
    reloadTreeRef.current = reloadTree;
    reloadBranchesRef.current = reloadBranches;
  }, [reloadTree, reloadBranches]);

  useEffect(() => {
    // EventSource can't set Authorization headers, so the PAT goes in a
    // `?pat=` query param. The server treats it identically to the header.
    const pat = getStoredPat();
    const url =
      `/api/v1/w/${encodeURIComponent(workspace.slug)}/events` +
      (pat ? `?pat=${encodeURIComponent(pat)}` : "");
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      let event: { type: string; path?: string };
      try {
        event = JSON.parse(msg.data);
      } catch (_err) {
        return;
      }
      if (event.type === "change" || event.type === "remove") {
        reloadTreeRef.current();
        if (event.path && event.path === openPathRef.current) {
          if (event.type === "remove") {
            setOpenPath(null);
            setOpenDoc(undefined);
            setContent("");
            setDirty(false);
            setStatus("file deleted on server");
          } else if (!dirtyRef.current) {
            // Race guard (#54): user may switch files (or start editing)
            // before this in-flight refresh resolves. Bump openRequestRef so
            // both this and openPathFromSource compete on the same token, and
            // bail if the user has moved on or started editing.
            const reqId = openRequestRef.current + 1;
            openRequestRef.current = reqId;
            const path = event.path;
            api
              .getFile(workspace.slug, path, openFileBranchRef.current ?? undefined)
              .then((r) => {
                if (openRequestRef.current !== reqId) return;
                if (openPathRef.current !== path) return;
                if (dirtyRef.current) return;
                setContent(r.content);
              })
              .catch(() => undefined);
          }
        }
      } else if (event.type === "pull" || event.type === "pull_reviewed") {
        refreshPullsRef.current();
        reloadBranchesRef.current();
        reloadTreeRef.current();
        if (reviewingPullNumberRef.current) {
          api
            .listComments(workspace.slug, reviewingPullNumberRef.current)
            .then((comments) => setReviewState((s) => ({ ...s, comments })))
            .catch(() => undefined);
        }
      }
    };
    return () => es.close();
  }, [workspace.slug]);

  const loadBacklinks = useCallback(
    (id: string | undefined) => {
      if (!id) {
        setBacklinks([]);
        return;
      }
      api
        .backlinks(workspace.slug, id)
        .then(setBacklinks)
        .catch(() => setBacklinks([]));
    },
    [workspace.slug],
  );

  const refreshValidation = useCallback(() => {
    api
      .validateWorkspace(workspace.slug)
      .then(setValidation)
      .catch(() => setValidation({ broken_refs: [], orphan_labels: [] }));
  }, [workspace.slug]);

  // Approvals only exist for an open/closed PR. We pass the PR number when we
  // know we're inside a review; otherwise clear.
  const loadApprovals = useCallback(
    (prNumber: number | null | undefined) => {
      if (!prNumber) {
        setApprovals([]);
        return;
      }
      api
        .listReviews(workspace.slug, prNumber)
        .then((r) => setApprovals(r.reviews))
        .catch(() => setApprovals([]));
    },
    [workspace.slug],
  );

  useEffect(() => {
    loadApprovals(reviewingPullNumber);
  }, [reviewingPullNumber, loadApprovals]);

  const openPathFromSource = useCallback(
    (
      path: string,
      options: { doc?: FileEntry["doc"]; branch?: string | null; push?: boolean; force?: boolean } = {},
    ) => {
      if (!options.force && dirtyRef.current && !confirm("Discard unsaved changes?")) return false;
      const requestId = openRequestRef.current + 1;
      openRequestRef.current = requestId;
      // Prefer the explicit option; otherwise the live activeBranchName;
      // otherwise the last-loaded branch (kept in a ref so a just-set value
      // from create() / save() wins races against state propagation).
      const branch =
        "branch" in options
          ? (options.branch ?? undefined)
          : (activeBranchName ?? openFileBranchRef.current ?? undefined);
      setBusy(true);
      setStatus(null);
      api
        .getFile(workspace.slug, path, branch)
        .then((r) => {
          if (openRequestRef.current !== requestId) return;
          const doc = options.doc ?? filesRef.current?.find((f) => f.path === path)?.doc;
          setViewingIssue(null);
          setNewIssueOpen(false);
          setOpenPath(path);
          setOpenDoc(doc);
          setContent(r.content);
          setDirty(false);
          openFileBranchRef.current = branch ?? null;
          loadBacklinks(doc?.id);
          loadApprovals(reviewingPullNumber);
          if (options.push !== false) {
            navigate({ kind: "workspace", slug: workspace.slug, filePath: path });
          }
        })
        .catch((err: unknown) => {
          if (openRequestRef.current !== requestId) return;
          setStatus(err instanceof ApiError ? err.message : "Failed to open");
        })
        .finally(() => {
          if (openRequestRef.current === requestId) setBusy(false);
        });
      return true;
    },
    [workspace.slug, activeBranchName, loadBacklinks, loadApprovals],
  );

  const open = useCallback(
    (entry: FileEntry) => {
      openPathFromSource(entry.path, { doc: entry.doc });
    },
    [openPathFromSource],
  );

  const clearOpenFile = useCallback(() => {
    setOpenPath(null);
    setOpenDoc(undefined);
    setContent("");
    setDirty(false);
    openFileBranchRef.current = null;
  }, []);

  const showIssue = useCallback(
    (number: number, push = true) => {
      if (dirtyRef.current && !confirm("Discard unsaved changes?")) return;
      clearOpenFile();
      setReviewingPullNumber(null);
      setReviewBranchName(null);
      setNewIssueOpen(false);
      setViewingIssue(number);
      setSidebarView("issues");
      if (push) {
        navigate({
          kind: "workspace",
          slug: workspace.slug,
          filePath: null,
          sidebarView: "issues",
          issueNumber: number,
        });
      }
    },
    [clearOpenFile, workspace.slug],
  );

  const showNewIssue = useCallback(
    (push = true) => {
      if (dirtyRef.current && !confirm("Discard unsaved changes?")) return;
      clearOpenFile();
      setReviewingPullNumber(null);
      setReviewBranchName(null);
      setViewingIssue(null);
      setNewIssueOpen(true);
      setSidebarView("issues");
      if (push) {
        navigate({
          kind: "workspace",
          slug: workspace.slug,
          filePath: null,
          sidebarView: "issues",
          newIssue: true,
        });
      }
    },
    [clearOpenFile, workspace.slug],
  );

  // Open whatever file is in the URL on workspace entry. Intentionally
  // omits openPathFromSource from the deps: its identity changes whenever
  // activeBranchName updates, and re-running it after a save would refetch
  // the file and wipe `dirty=true` from any local edits in flight.
  const initialOpenRef = useRef(false);
  useEffect(() => {
    if (!branchesReady || initialOpenRef.current) return;
    const r = parseRoute();
    if (r.kind === "workspace" && r.slug === workspace.slug && r.filePath) {
      initialOpenRef.current = true;
      openPathFromSource(r.filePath, { push: false, force: true });
    } else if (r.kind === "workspace" && r.slug === workspace.slug) {
      initialOpenRef.current = true;
      setSidebarView(r.sidebarView ?? "pages");
      if (r.issueNumber) showIssue(r.issueNumber, false);
      else if (r.newIssue) showNewIssue(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional, see comment above
  }, [branchesReady, workspace.slug]);

  useEffect(() => {
    const handler = (): void => {
      const r = parseRoute();
      if (r.kind !== "workspace" || r.slug !== workspace.slug) return;
      if (!r.filePath) {
        if (dirtyRef.current && !confirm("Discard unsaved changes?")) {
          navigate({ kind: "workspace", slug: workspace.slug, filePath: openPathRef.current }, "replace");
          return;
        }
        clearOpenFile();
        setSidebarView(r.sidebarView ?? "pages");
        setReviewingPullNumber(null);
        setReviewBranchName(null);
        setViewingIssue(r.issueNumber ?? null);
        setNewIssueOpen(r.newIssue ?? false);
        return;
      }
      setViewingIssue(null);
      setNewIssueOpen(false);
      setSidebarView(r.sidebarView ?? "pages");
      const opened = openPathFromSource(r.filePath, { push: false });
      if (!opened) navigate({ kind: "workspace", slug: workspace.slug, filePath: openPathRef.current }, "replace");
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [workspace.slug, openPathFromSource, clearOpenFile]);

  // Host APIs for the embedded MarkdownEditor. The editor owns dirty
  // tracking (live doc vs last-saved baseline); cosheaf subscribes via
  // `onDirtyChange`. The Save button routes through `editor.triggerSave()`,
  // which dispatches to `saveHandler.save` — the single write path. This
  // avoids dual-dirty races where cosheaf's `onChange`-driven setDirty(true)
  // was clobbered by the editor's mount-time onDirtyChange(false).
  const currentBranchNameRef = useRef<string | null>(null);
  currentBranchNameRef.current = currentBranchName;

  const branchForWrite = useCallback(
    (): string =>
      (currentBranchNameRef.current && currentBranchNameRef.current !== "main"
        ? currentBranchNameRef.current
        : null) ??
      `${userBranchPrefix(user.username)}wip-${shortId()}`,
    [user],
  );

  const editorSaveHandler = useMemo<EditorSaveHandler>(
    () => ({
      autosaveDebounceMs: 1500,
      save: async (payload) => {
        const path = openPathRef.current;
        if (!path) return { ok: false as const, error: "no file open" };
        if (reviewingPullNumberRef.current)
          return { ok: false as const, error: "review mode is read-only" };
        const branch = branchForWrite();
        try {
          const r = await api.putFile(workspace.slug, path, payload.source, branch);
          if (r.content !== undefined) setContent(r.content);
          setOpenDoc(r.meta);
          setCurrentBranchName(r.branch);
          openFileBranchRef.current = r.branch;
          loadBacklinks(r.meta.id);
          void loadTree(r.branch);
          return { ok: true as const };
        } catch (err) {
          return {
            ok: false as const,
            error: err instanceof ApiError ? err.message : "save failed",
          };
        }
      },
    }),
    [branchForWrite, workspace.slug, loadTree, loadBacklinks],
  );

  const editorStatusEvents = useMemo<EditorStatusEvents>(
    () => ({
      onSaveStart: () => {
        setBusy(true);
        setStatus(null);
      },
      onSaveSucceeded: () => {
        setBusy(false);
        setStatus("saved");
      },
      onSaveFailed: (e) => {
        setBusy(false);
        setStatus(`save failed: ${e.error}`);
      },
      // Single source of truth: the editor's dirty tracker. We don't also
      // set dirty=true from `onChange` — that would race the mount-time
      // onDirtyChange(false) and lose typed keystrokes.
      onDirtyChange: (d) => setDirty(d),
      onAssetUploading: (e) => setStatus(`uploading ${e.file.name}…`),
      onAssetUploadSucceeded: (e) => setStatus(`uploaded ${e.path}`),
      onAssetUploadFailed: (e) => setStatus(`upload failed: ${e.error}`),
    }),
    [],
  );

  const editorAssetUploader = useMemo<EditorAssetUploader>(
    () => ({
      accept: (file) =>
        file.size > MAX_ASSET_BYTES ? { reject: `asset exceeds ${MAX_ASSET_DISPLAY}` } : null,
      upload: async (file) => {
        if (reviewingPullNumberRef.current)
          return { error: "review mode is read-only" };
        const branch = branchForWrite();
        try {
          const r = await api.uploadAsset(workspace.slug, branch, file);
          if (!currentBranchNameRef.current) setCurrentBranchName(branch);
          return { path: r.path };
        } catch (err) {
          return { error: err instanceof ApiError ? err.message : "upload failed" };
        }
      },
    }),
    [branchForWrite, workspace.slug],
  );

  const editorAutocompleteSources = useMemo<readonly EditorAutocompleteSource[]>(
    () => [
      {
        trigger: "[@",
        suggest: async (prefix, env) => {
          if (env.signal.aborted) return [];
          try {
            const r = await api.suggest(workspace.slug, { trigger: "[@", prefix, limit: 10 });
            return r.suggestions;
          } catch (_err) {
            // Best-effort autocomplete; network blips become empty results.
            return [];
          }
        },
      },
    ],
    [workspace.slug],
  );

  // Cosheaf Save-button entry point. Routes through editor.triggerSave so
  // the editor's dirty baseline + autosave + Cmd-S all stay coherent with
  // the manual button — a single write path.
  const save = useCallback(() => {
    if (!openPath) return;
    if (reviewingPullNumber) {
      setStatus("review mode is read-only");
      return;
    }
    void editorRef.current?.triggerSave("manual");
  }, [openPath, reviewingPullNumber]);

  const refreshPulls = useCallback(() => {
    api
      .listPulls(workspace.slug, "open")
      .then((pulls) =>
        Promise.all(
          pulls.map(async (p) => {
            const r = await api.listReviews(workspace.slug, p.number).catch(() => ({
              approvals: 0,
              rejections: 0,
              reviews: [] as ApprovalRecord[],
            }));
            return { ...p, approvals: r.approvals, rejections: r.rejections } as PullReviewEntry;
          }),
        ),
      )
      .then(setReviewPulls)
      .catch(() => setReviewPulls([]));
  }, [workspace.slug]);
  useEffect(() => {
    refreshPullsRef.current = refreshPulls;
  }, [refreshPulls]);

  const refreshIssues = useCallback(
    (scope: "mine" | "all", panel: "inbox" | "issues" | "activity", q: string) => {
      const filter = (panel === "inbox" || panel === "issues") && scope === "mine" ? "mine" : undefined;
      api
        .listIssues(workspace.slug, {
          state: "open",
          ...(filter ? { filter } : {}),
          ...(q.trim() ? { q } : {}),
        })
        .then((r) => setIssues(r.issues))
        .catch(() => setIssues([]));
    },
    [workspace.slug],
  );

  // Fetch issues whenever the user opens Inbox/Issues/Activity, switches scope, or
  // changes the search query. Server-side LIKE filter on title.
  useEffect(() => {
    if (sidebarView === "inbox" || sidebarView === "issues" || sidebarView === "activity") {
      const handle = setTimeout(() => {
        refreshIssues(issuesScope, sidebarView, inboxQuery);
      }, 150);
      return () => clearTimeout(handle);
    }
  }, [sidebarView, issuesScope, inboxQuery, refreshIssues]);

  const refreshNotifs = useCallback(() => {
    api
      .listNotifications(workspace.slug)
      .then(setNotifs)
      .catch(() => setNotifs([]));
  }, [workspace.slug]);

  // Poll Forgejo notifications while Inbox is open. Forgejo doesn't broadcast
  // these over webhooks, so we refresh on open + every 30s.
  useEffect(() => {
    if (sidebarView !== "inbox") return;
    refreshNotifs();
    const t = setInterval(refreshNotifs, 30_000);
    return () => clearInterval(t);
  }, [sidebarView, refreshNotifs]);

  // Eagerly fetch every open PR once per workspace — used by Activity, the
  // Inbox All scope, and #N cross-reference resolution.
  useEffect(() => {
    api
      .listPulls(workspace.slug, "open")
      .then(setOpenPrs)
      .catch(() => setOpenPrs([]));
  }, [workspace.slug]);

  const refreshPinned = useCallback(async () => {
    try {
      const r = await api.listPinnedIssues(workspace.slug);
      setPinnedIssues(r.issues);
    } catch (_err) {
      setPinnedIssues([]);
    }
  }, [workspace.slug]);

  const selectSidebarView = useCallback(
    (view: WorkspaceSidebarView) => {
      setSidebarView(view);
      if (view !== "issues") {
        setViewingIssue(null);
        setNewIssueOpen(false);
      }
      if (view === "issues") {
        refreshIssues(issuesScope, "issues", inboxQuery);
        void refreshPinned();
      }
      navigate({
        kind: "workspace",
        slug: workspace.slug,
        filePath: openPathRef.current,
        sidebarView: view,
      });
    },
    [workspace.slug, issuesScope, inboxQuery, refreshIssues, refreshPinned],
  );

  useEffect(() => {
    void refreshPinned();
  }, [refreshPinned]);

  // Activity feed refreshes when the user opens the Activity tab.
  useEffect(() => {
    if (sidebarView !== "activity") return;
    let cancel = false;
    api
      .listActivities(workspace.slug, 50)
      .then((r) => {
        if (!cancel) setActivities(r.activities);
      })
      .catch(() => {
        if (!cancel) setActivities([]);
      });
    return () => {
      cancel = true;
    };
  }, [sidebarView, workspace.slug]);

  useEffect(() => {
    if (sidebarView !== "linter") return;
    refreshValidation();
  }, [sidebarView, refreshValidation]);

  const openPullReview = useCallback(
    (entry: PullReviewEntry) => {
      setReviewingPullNumber(entry.number);
      setReviewBranchName(entry.head_ref);
      setCurrentBranchName(null);
      setSidebarView("pages");
      setStatus(null);
      loadApprovals(entry.number);
    },
    [loadApprovals],
  );

  const openPullRequest = useCallback(
    (mode?: "direct" | "review") => {
      if (!currentBranchName) {
        setStatus("nothing on this branch to merge or review");
        return;
      }
      setBusy(true);
      setStatus(null);
      (async () => {
        try {
          const pr = await api.openPull(workspace.slug, {
            head: currentBranchName,
            title: currentBranchName,
          });
          if (mode === "direct") {
            // Admin direct-merge bypasses required-approvals branch protection.
            await api.mergePull(workspace.slug, pr.number, { Do: "squash", force: true });
            setStatus("merged to main");
            // Direct-merge clears the branch (it was merged; there's no
            // follow-up). For the normal "open for review" path we KEEP the
            // branch context so a later save (e.g. after request-changes)
            // appends commits to the same PR head ref (#26).
            setCurrentBranchName(null);
          } else {
            setStatus(`pull request #${pr.number} opened — saves on this file continue pushing to ${currentBranchName}`);
          }
          refreshPulls();
          // #57: in review mode the branch stays current; load its tree, not
          // main's, so the sidebar keeps showing branch contents.
          void loadTree(mode === "direct" ? undefined : currentBranchName ?? undefined);
        } catch (err) {
          setStatus(err instanceof ApiError ? err.message : "Open pull request failed");
        } finally {
          setBusy(false);
        }
      })();
    },
    [workspace.slug, currentBranchName, refreshPulls],
  );

  // Submit a review decision (approve, request_changes, or comment-only) on
  // the PR currently being reviewed.
  const submitReview = useCallback(
    async (decision: Decision, body: string) => {
      const n = reviewingPullNumber;
      if (!n) return;
      const comment = body.trim() || undefined;
      const pendingId = reviewState.pendingReviewId;
      setReviewState((s) => ({ ...s, busy: true }));
      try {
        if (pendingId) {
          await api.submitPendingReview(workspace.slug, n, pendingId, {
            event: decision,
            body: comment,
          });
          setStatus(`submitted ${decision}`);
        } else {
          const eventMap = {
            approve: "APPROVE",
            request_changes: "REQUEST_CHANGES",
            comment: "COMMENT",
          } as const;
          await api.submitReview(workspace.slug, n, eventMap[decision], comment);
          setStatus(decision === "approve" ? "approved" : decision === "request_changes" ? "changes requested" : "commented");
        }
        loadApprovals(n);
        refreshPulls();
        const pr = await api.getPull(workspace.slug, n).catch(() => null);
        if (pr) {
          setReviewState((s) => ({ ...s, pr, pendingReviewId: null }));
          if (pr.merged || pr.state === "closed") {
            setReviewingPullNumber(null);
            setReviewBranchName(null);
            void loadTree();
          }
        }
      } catch (err) {
        setStatus(err instanceof ApiError ? err.message : `${decision} failed`);
      } finally {
        setReviewState((s) => ({ ...s, busy: false }));
      }
    },
    [reviewingPullNumber, workspace.slug, reviewState.pendingReviewId, loadApprovals, refreshPulls],
  );

  const closeReviewedPull = useCallback(async () => {
    const n = reviewingPullNumber;
    if (!n) return;
    setReviewState((s) => ({ ...s, busy: true }));
    try {
      await api.closePull(workspace.slug, n);
      setStatus("Pull request closed");
      setReviewingPullNumber(null);
      setReviewBranchName(null);
      refreshPulls();
      void loadTree();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "close failed");
    } finally {
      setReviewState((s) => ({ ...s, busy: false }));
    }
  }, [reviewingPullNumber, workspace.slug, refreshPulls]);

  // When entering review, fetch PR meta + per-file diff. Clear on exit.
  // Each transition (enter, switch PR, exit) clears selectedPath + reviewBranchName
  // first so a stale file or branch from the previous PR can't leak through.
  useEffect(() => {
    setReviewBranchName(null);
    setReviewState({ pr: null, diff: null, comments: [], selectedPath: null, busy: false, pendingReviewId: null });
    if (!reviewingPullNumber) return;
    let cancelled = false;
    Promise.all([
      api.getPull(workspace.slug, reviewingPullNumber),
      api.listPrFiles(workspace.slug, reviewingPullNumber),
      api.listComments(workspace.slug, reviewingPullNumber).catch(() => []),
    ])
      .then(([pr, diff, comments]) => {
        if (cancelled) return;
        setReviewBranchName(pr.head_ref);
        setReviewState((s) => ({
          ...s,
          pr,
          diff,
          comments,
          selectedPath: diff.files[0]?.path ?? null,
        }));
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus(err instanceof ApiError ? err.message : "Failed to load PR");
      });
    return () => {
      cancelled = true;
    };
  }, [reviewingPullNumber, workspace.slug]);

  const loadReviewFileContent = useCallback(
    async (path: string, side: "base" | "head") => {
      const n = reviewingPullNumber;
      if (!n) throw new Error("no active review");
      return api.pullFile(workspace.slug, n, path, side);
    },
    [reviewingPullNumber, workspace.slug],
  );

  const setReviewComments = useCallback(
    (comments: LineComment[]) => setReviewState((s) => ({ ...s, comments })),
    [],
  );
  const {
    add: addReviewComment,
    edit: editReviewComment,
    remove: deleteReviewComment,
  } = useReviewComments({
    slug: workspace.slug,
    pullNumber: reviewingPullNumber,
    pendingReviewId: reviewState.pendingReviewId,
    setComments: setReviewComments,
  });

  const togglePendingReview = useCallback(async () => {
    const n = reviewingPullNumber;
    if (!n) return;
    if (reviewState.pendingReviewId) {
      // Cancel local batch — Forgejo keeps the PENDING review server-side
      // for reuse; we just stop sending into it.
      setReviewState((s) => ({ ...s, pendingReviewId: null }));
      return;
    }
    setReviewState((s) => ({ ...s, busy: true }));
    try {
      const { review_id } = await api.startPendingReview(workspace.slug, n);
      setReviewState((s) => ({ ...s, pendingReviewId: review_id }));
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "could not start a pending review");
    } finally {
      setReviewState((s) => ({ ...s, busy: false }));
    }
  }, [reviewingPullNumber, workspace.slug, reviewState.pendingReviewId]);

  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (openPath && dirty) save();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (!busy) openPullRequest();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openPath, dirty, save, busy, openPullRequest]);

  const create = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    let path = newPath.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";
    setBusy(true);
    const branch =
      (currentBranchName && currentBranchName !== "main" ? currentBranchName : null) ??
      `${userBranchPrefix(user.username)}wip-${shortId()}`;
    api
      .putFile(workspace.slug, path, `# ${path.replace(/\.md$/, "")}\n`, branch)
      .then((r) => {
        setOpenPath(path);
        setContent(r.content ?? `# ${path.replace(/\.md$/, "")}\n`);
        setOpenDoc(r.meta);
        setCurrentBranchName(r.branch);
        openFileBranchRef.current = r.branch;
        setStatus(`saved on ${r.branch}`);
        setDirty(false);
        setNewPath("");
        setCreating(false);
        navigate({ kind: "workspace", slug: workspace.slug, filePath: path });
        void loadTree(r.branch);
      })
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Create failed"),
      )
      .finally(() => setBusy(false));
  };

  const workspaceContextValue = useMemo(
    () => ({ slug: workspace.slug, formatId: activeFormatId, documentContext: workspaceCtx }),
    [workspace.slug, activeFormatId, workspaceCtx],
  );

  return (
    <WorkspaceProvider value={workspaceContextValue}>
    <Screen
      className={cn(
        "cf-theme-scope",
        documentTheme === "blueprint-book" && "cf-theme-blueprint-book",
      )}
    >
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex w-60 shrink-0 flex-col border-r min-h-0",
            borderColor,
            !sidebarOpen && "hidden",
          )}
        >
          <div className={cn("flex items-center gap-1 border-b px-2 py-1", borderColor)}>
            <Button variant="ghost" size="sm" onClick={onBack} title="Back to workspaces">
              ←
            </Button>
            <strong className="truncate flex-1">{workspace.name}</strong>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(false)}
              title="Collapse sidebar (⌘B)"
              aria-label="Collapse sidebar"
            >
              ☰
            </Button>
          </div>
          <div className={cn("flex flex-wrap items-center gap-0.5 border-b px-1 py-0.5 text-xs", borderColor)}>
            <SidebarTab
              active={sidebarView === "pages"}
              onClick={() => selectSidebarView("pages")}
              testId="sidebar-tab-pages"
            >
              Files
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "inbox"}
              onClick={() => {
                selectSidebarView("inbox");
                refreshPulls();
              }}
              testId="sidebar-tab-inbox"
            >
              Inbox
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "issues"}
              onClick={() => selectSidebarView("issues")}
              testId="sidebar-tab-issues"
            >
              Issues
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "activity"}
              onClick={() => selectSidebarView("activity")}
              testId="sidebar-tab-activity"
            >
              Activity
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "outline"}
              onClick={() => selectSidebarView("outline")}
              disabled={!openPath}
            >
              Outline
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "linter"}
              onClick={() => selectSidebarView("linter")}
              testId="sidebar-tab-linter"
            >
              Linter
            </SidebarTab>
            {workspace.role === "admin" && (
              <SidebarTab
                active={sidebarView === "settings"}
                onClick={() => selectSidebarView("settings")}
                testId="sidebar-tab-settings"
              >
                ⚙
              </SidebarTab>
            )}
          </div>
          {sidebarView === "settings" ? (
            <div className={cn("px-3 py-2 text-xs", muted)}>
              Settings open in main pane →
            </div>
          ) : sidebarView === "outline" ? (
            <OutlinePanel
              entries={outline}
              onPick={(line) => editorRef.current?.scrollToLine(line, { center: true })}
            />
          ) : sidebarView === "linter" ? (
            <LinterPanel
              result={validation}
              onRefresh={refreshValidation}
              onOpenPath={(path, line) => {
                setViewingIssue(null);
                setNewIssueOpen(false);
                if (line && path === openPath) {
                  editorRef.current?.scrollToLine(line, { center: true });
                } else if (line) {
                  setPendingScroll({ path, line });
                }
                openPathFromSource(path);
              }}
            />
          ) : sidebarView === "inbox" || sidebarView === "issues" || sidebarView === "activity" ? (
            <InboxOrActivity
              kind={sidebarView}
              reviewPulls={reviewPulls ?? []}
              issues={issues ?? []}
              pinned={pinnedIssues}
              activities={activities}
              scope={issuesScope}
              setScope={setIssuesScope}
              query={inboxQuery}
              setQuery={setInboxQuery}
              onRefresh={() => {
                refreshPulls();
                refreshPinned();
                if (sidebarView === "inbox") refreshNotifs();
                if (sidebarView === "inbox" || sidebarView === "issues" || sidebarView === "activity") {
                  // refresh issues too
                  api
                    .listIssues(workspace.slug, {
                      state: "open",
                      ...((sidebarView === "inbox" || sidebarView === "issues") && issuesScope === "mine"
                        ? { filter: "mine" as const }
                        : {}),
                    })
                    .then((r) => setIssues(r.issues))
                    .catch(() => undefined);
                }
              }}
              openPrs={openPrs ?? []}
              notifications={notifs}
              onOpenPullReview={openPullReview}
              onOpenIssue={(n) => {
                showIssue(n);
              }}
              onOpenPr={(prNumber) => {
                const row = (openPrs ?? []).find((r) => r.number === prNumber);
                if (row) openPullReview({ ...row, approvals: 0, rejections: 0 });
              }}
              onMarkNotifRead={(id) => {
                setNotifs((prev) => prev.filter((x) => x.id !== id));
                api.markNotificationRead(workspace.slug, id).catch(() => refreshNotifs());
              }}
              onMarkAllNotifsRead={() => {
                setNotifs([]);
                api.markAllNotificationsRead(workspace.slug).catch(() => refreshNotifs());
              }}
              onNewIssue={() => {
                showNewIssue();
              }}
              canWrite={workspace.role !== "read"}
            />
          ) : reviewingPullNumber && reviewState.diff ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-3 px-2 py-1">
                <strong>Changed files</strong>
                <button
                  type="button"
                  data-testid="review-exit"
                  onClick={() => { setReviewingPullNumber(null); setReviewBranchName(null); }}
                  className={cn("text-xs hover:underline", muted)}
                >
                  Exit review
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                <FileList
                  files={reviewState.diff.files}
                  selectedPath={reviewState.selectedPath}
                  onSelect={(path) => setReviewState((s) => ({ ...s, selectedPath: path }))}
                  comments={reviewState.comments}
                />
              </div>
            </div>
          ) : (
            <>
              <div className={cn("border-b p-2", borderColor)}>
                <Input
                  placeholder="Search…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      api
                        .search(workspace.slug, searchQuery)
                        .then(setSearchResults)
                        .catch(() => setSearchResults([]));
                    }
                    if (e.key === "Escape") {
                      setSearchQuery("");
                      setSearchResults(null);
                    }
                  }}
                />
              </div>
              {searchResults !== null ? (
                <div className={cn("flex min-h-0 flex-col border-b", borderColor)}>
                  <div className="flex items-center justify-between gap-3 px-2 py-1">
                    <span className={cn("text-xs", muted)}>
                      {searchResults.length} results
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSearchQuery("");
                        setSearchResults(null);
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                  <ul className="m-0 max-h-[50vh] overflow-y-auto p-0">
                    {searchResults.map((r) => (
                      <li key={r.doc_id}>
                        <FileRow
                          onClick={() => {
                            const entry = files?.find((f) => f.path === r.path);
                            if (entry) open(entry);
                            else openPathFromSource(r.path);
                          }}
                        >
                          <strong>{r.title ?? r.path}</strong>
                          <span className={cn("text-xs", muted)}>
                            {" "}
                            {r.snippet.map((part, idx) => {
                              // Snippet parts are emitted in fixed order by the
                              // server FTS path and never reorder/filter on the
                              // client; index+match flag is a stable identity.
                              const k = `${idx}-${part.match ? "m" : "t"}`;
                              return part.match ? (
                                <mark key={k} className="bg-yellow-300/40 text-inherit">
                                  {part.text}
                                </mark>
                              ) : (
                                <span key={k}>{part.text}</span>
                              );
                            })}
                          </span>
                        </FileRow>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3 px-2 py-1">
                    <strong>Files</strong>
                    {workspace.role !== "read" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid="new-file-toggle"
                        onClick={() => setCreating((v) => !v)}
                        aria-label={creating ? "Cancel" : "New file"}
                      >
                        {creating ? "−" : "+"}
                      </Button>
                    )}
                  </div>
                  {workspace.role !== "read" && creating && (
                    <form onSubmit={create} className="flex gap-2 px-2 pb-2">
                      <NewFilePathInput value={newPath} onChange={setNewPath} />
                      <Button type="submit" size="sm">
                        Add
                      </Button>
                    </form>
                  )}
                  {files && files.length === 0 && (
                    <div className={cn("px-3 py-2", muted)}>No files yet.</div>
                  )}
                  <ul className="m-0 flex-1 overflow-y-auto p-0">
                    {files?.map((f) => (
                      <li key={f.path}>
                        <FileRow
                          active={f.path === openPath}
                          title={f.doc?.id ? `id: ${f.doc.id}` : "unindexed"}
                          onClick={() => open(f)}
                          testId={`file-${f.path}`}
                        >
                          {f.doc?.title ?? f.path}
                        </FileRow>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <UserMenu user={user} onLogout={onLogout} />
        </aside>
        <main
          className={cn(
            "relative flex min-w-0 flex-1 flex-col",
            reviewingPullNumber && "overflow-auto",
          )}
        >
          {!sidebarOpen && (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              title="Open sidebar (⌘B)"
              aria-label="Open sidebar"
              className={cn(
                "absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded border bg-[var(--cf-bg)] text-xs",
                borderColor,
                "hover:bg-[var(--cf-hover)]",
              )}
            >
              ☰
            </button>
          )}
          {!reviewingPullNumber && !openPath && viewingIssue !== null && (
            <IssueView
              number={viewingIssue}
              currentForgejoUsername={user.username}
              canManageLabels={workspace.role === "admin"}
              canPin={workspace.role === "admin"}
              isPinned={pinnedIssues.some((p) => p.number === viewingIssue)}
              onPinChanged={refreshPinned}
              onClose={() => {
                setViewingIssue(null);
                navigate({
                  kind: "workspace",
                  slug: workspace.slug,
                  filePath: null,
                  sidebarView,
                });
              }}
              onOpenPageById={(id) => {
                const match = filesRef.current?.find((f) => f.doc?.id === id);
                if (match) {
                  setViewingIssue(null);
                  openPathFromSource(match.path);
                }
              }}
              onOpenPath={(p) => {
                setViewingIssue(null);
                openPathFromSource(p);
              }}
              onOpenNumber={(n) => {
                // PR and issue numbers share a single sequence in Forgejo.
                // If we already know about a PR with this number, open it
                // as a review; otherwise treat the number as an issue.
                const pr = (openPrs ?? []).find((c) => c.number === n) ?? (reviewPulls ?? []).find((c) => c.number === n);
                if (pr) {
                  setViewingIssue(null);
                  openPullReview({ ...pr, approvals: 0, rejections: 0 });
                } else {
                  showIssue(n);
                }
              }}
            />
          )}
          {!reviewingPullNumber && !openPath && viewingIssue === null && newIssueOpen && (
            <div className="flex flex-1 flex-col p-4 gap-3 max-w-2xl mx-auto w-full">
              <h2 className="text-lg font-semibold">New issue</h2>
              <Input
                placeholder="Title"
                value={newIssueTitle}
                onChange={(e) => setNewIssueTitle(e.target.value)}
                data-testid="new-issue-title"
              />
              <textarea
                placeholder="Describe the question, problem, or idea…"
                value={newIssueBody}
                onChange={(e) => setNewIssueBody(e.target.value)}
                rows={10}
                data-testid="new-issue-body"
                className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setNewIssueOpen(false);
                    setNewIssueTitle("");
                    setNewIssueBody("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  data-testid="new-issue-submit"
                  disabled={newIssueBusy || newIssueTitle.trim().length === 0}
                  onClick={async () => {
                    setNewIssueBusy(true);
                    try {
                      const created = await api.createIssue(workspace.slug, {
                        title: newIssueTitle.trim(),
                        body: newIssueBody,
                      });
                      setNewIssueOpen(false);
                      setNewIssueTitle("");
                      setNewIssueBody("");
                      showIssue(created.number);
                      // Refresh the sidebar list so the new issue is in
                      // the inbox immediately, not only after a manual refresh.
                      refreshIssues(issuesScope, "inbox", inboxQuery);
                    } finally {
                      setNewIssueBusy(false);
                    }
                  }}
                >
                  Create issue
                </Button>
              </div>
            </div>
          )}
          {!reviewingPullNumber && !openPath && viewingIssue === null && !newIssueOpen && sidebarView === "settings" && (
            <div className="flex-1 overflow-auto">
              <SettingsPanel
                workspaceSlug={workspace.slug}
                initialFormatId={activeFormatId}
                onFormatChanged={setActiveFormatId}
              />
            </div>
          )}
          {!reviewingPullNumber && !openPath && viewingIssue === null && !newIssueOpen && sidebarView !== "settings" && (
            <div className={cn("flex flex-1 items-center justify-center", muted)}>
              Select a file from the sidebar, or create one.
            </div>
          )}
          {!reviewingPullNumber && openPath && (
            <>
              <Suspense fallback={<div className="flex-1" />}>
                <ActiveMarkdownEditor
                  key={openPath}
                  value={content}
                  mode={editorMode}
                  from={openPath ?? undefined}
                  testId="editor"
                  onReady={(editor) => {
                    editorRef.current = editor;
                    setOutline(editor.outline.get());
                    editor.outline.subscribe(setOutline);
                    if (pendingScroll && pendingScroll.path === openPath) {
                      editor.scrollToLine(pendingScroll.line, { center: true });
                      setPendingScroll(null);
                    }
                  }}
                  onChange={(next) => {
                    // Just mirror content for save payload. Dirty tracking
                    // is owned by the editor's statusEvents.onDirtyChange.
                    setContent(next);
                    setStatus(null);
                  }}
                  saveHandler={editorSaveHandler}
                  statusEvents={editorStatusEvents}
                  assetUploader={editorAssetUploader}
                  autocompleteSources={editorAutocompleteSources}
                />
              </Suspense>
              {openDoc?.id && backlinks.length > 0 && (
                <BacklinksPanel
                  links={backlinks}
                  onPick={(srcPath) => {
                    const entry = files?.find((f) => f.path === srcPath);
                    if (entry) open(entry);
                    else openPathFromSource(srcPath);
                  }}
                />
              )}
              {activeBranchName && (
                <ApprovalsPanel approvals={approvals} />
              )}
            </>
          )}
          {reviewingPullNumber && (
            <>
              {reviewState.pr && <PrHeader pr={reviewState.pr} />}
              <div className="min-h-0 shrink-0">
                <DiffArea
                  file={
                    reviewState.diff?.files.find((f) => f.path === reviewState.selectedPath) ??
                    reviewState.diff?.files[0] ??
                    null
                  }
                  loadContent={loadReviewFileContent}
                  comments={reviewState.comments}
                  currentForgejoUsername={user.username}
                  onAddComment={
                    // Hide the inline composer for the author of the PR — even
                    // admins/writers can't review their own changes, so the
                    // affordance would be misleading.
                    reviewState.pr?.author_username === user.username
                      ? undefined
                      : workspace.role === "admin" || workspace.role === "write"
                        ? addReviewComment
                        : undefined
                  }
                  onEditComment={editReviewComment}
                  onDeleteComment={deleteReviewComment}
                />
              </div>
              <ApprovalsPanel
                approvals={approvals}
                lineCommentCount={reviewState.comments.length}
              />
              {reviewState.pr && (
                <ReviewActions
                  state={reviewState.pr.state}
                  merged={reviewState.pr.merged}
                  role={workspace.role}
                  isAuthor={reviewState.pr.author_username === user.username}
                  onSubmit={submitReview}
                  onClose={closeReviewedPull}
                  busy={reviewState.busy}
                  pendingReviewActive={reviewState.pendingReviewId !== null}
                  onTogglePendingReview={togglePendingReview}
                />
              )}
            </>
          )}
          {activeBranchName && (
            <span data-testid="active-branch" hidden>{activeBranchName}</span>
          )}
          <WorkspaceStatusBar
            activeFormatId={activeFormatId}
            busy={busy}
            currentBranchName={currentBranchName}
            dirty={dirty}
            documentTheme={documentTheme}
            editorMode={editorMode}
            openPath={openPath}
            reviewingPullNumber={reviewingPullNumber}
            role={workspace.role}
            status={status}
            onDocumentThemeChange={setDocumentTheme}
            onOpenPullRequest={openPullRequest}
            onSave={save}
            onToggleEditorMode={() => setEditorMode((m) => (m === "rich" ? "source" : "rich"))}
          />
        </main>
      </div>
    </Screen>
    </WorkspaceProvider>
  );
}
