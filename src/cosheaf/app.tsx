import type { ReactElement } from "react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

type OutlineEntry = {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
  readonly line: number;
  readonly key: string;
  readonly number?: string;
};
import {
  ApiError,
  api,
  type ActivityRow,
  type ApprovalRecord,
  type Backlink,
  type ChangeDiff,
  type Decision,
  type FileEntry,
  type IssueRow,
  type LineComment,
  type NotificationRow,
  type OpenBranchRow,
  type PrMeta,
  type ReviewQueueEntry,
  type SearchResult,
  type TokenInfo,
  type User,
  type Workspace,
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

const MarkdownEditor = lazy(() =>
  import("./document-format/coflat-editor").then((m) => ({ default: m.MarkdownEditor })),
);

type View =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "workspaces"; user: User }
  | { kind: "tokens"; user: User }
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
              api.logout().then(onLogout);
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

// URL ↔ view kind mapping. File-open state lives inside WorkspaceView for now;
// workspace switching, tokens, and workspaces list participate in browser history.
type RoutePath =
  | { kind: "workspaces" }
  | { kind: "tokens" }
  | { kind: "workspace"; slug: string; filePath: string | null };

function parseRoute(): RoutePath {
  const path = window.location.pathname;
  if (path === "/tokens") return { kind: "tokens" };
  const m = /^\/w\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (m) {
    const filePath = m[2] ? decodeURIComponent(m[2]) : null;
    return { kind: "workspace", slug: m[1], filePath };
  }
  return { kind: "workspaces" };
}

function routeUrl(r: RoutePath): string {
  if (r.kind === "tokens") return "/tokens";
  if (r.kind === "workspaces") return "/";
  if (r.filePath) return `/w/${r.slug}/${r.filePath.split("/").map(encodeURIComponent).join("/")}`;
  return `/w/${r.slug}`;
}

function navigate(r: RoutePath, mode: "push" | "replace" = "push"): void {
  const url = routeUrl(r);
  if (window.location.pathname + window.location.search === url) return;
  if (mode === "replace") window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

export function CosheafApp(): ReactElement {
  const [view, setView] = useState<View>({ kind: "loading" });

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
        if (r.kind === "tokens") {
          setView({ kind: "tokens", user });
        } else if (r.kind === "workspace") {
          api.listWorkspaces().then((wss) => {
            const ws = wss.find((w) => w.slug === r.slug);
            if (ws) setView({ kind: "workspace", user, workspace: ws });
            else {
              navigate({ kind: "workspaces" }, "replace");
              setView({ kind: "workspaces", user });
            }
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
      if (r.kind === "tokens") setView({ kind: "tokens", user: view.user });
      else if (r.kind === "workspaces") setView({ kind: "workspaces", user: view.user });
      else if (r.kind === "workspace") {
        if (view.kind === "workspace" && view.workspace.slug === r.slug) return;
        api.listWorkspaces().then((wss) => {
          const ws = wss.find((w) => w.slug === r.slug);
          if (ws) setView({ kind: "workspace", user: view.user, workspace: ws });
          else setView({ kind: "workspaces", user: view.user });
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
        onTokens={() => {
          navigate({ kind: "tokens" });
          setView({ kind: "tokens", user: view.user });
        }}
        onLogout={() => {
          navigate({ kind: "workspaces" }, "replace");
          setView({ kind: "login" });
        }}
      />
    );
  }
  if (view.kind === "tokens") {
    return (
      <TokensScreen
        user={view.user}
        onBack={() => {
          navigate({ kind: "workspaces" });
          setView({ kind: "workspaces", user: view.user });
        }}
        onLogout={() => {
          navigate({ kind: "workspaces" }, "replace");
          setView({ kind: "login" });
        }}
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
      onLogout={() => {
        navigate({ kind: "workspaces" }, "replace");
        setView({ kind: "login" });
      }}
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

function Screen({ children }: { children: React.ReactNode }): ReactElement {
  return <div className="flex h-full flex-col">{children}</div>;
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
    setBusy(true);
    setError(null);
    api
      .login(username, password)
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
        <Button type="submit" disabled={busy || !username || !password}>
          {busy ? "..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function WorkspaceList({
  user,
  onPick,
  onTokens,
  onLogout,
}: {
  user: User;
  onPick: (workspace: Workspace) => void;
  onTokens: () => void;
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
        <Button variant="ghost" size="sm" onClick={onTokens}>
          Tokens
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => api.logout().then(onLogout)}
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
              <li key={ws.id}>
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

function TokensScreen({
  user,
  onBack,
  onLogout,
}: {
  user: User;
  onBack: () => void;
  onLogout: () => void;
}): ReactElement {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ id: number; name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listTokens()
      .then(setTokens)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Failed to load"),
      );
  }, []);
  useEffect(reload, [reload]);

  const create = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    api
      .createToken(name.trim())
      .then((t) => {
        setCreated(t);
        setName("");
        reload();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Create failed"),
      );
  };

  const revoke = (id: number) => {
    api
      .revokeToken(id)
      .then(reload)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Revoke failed"),
      );
  };

  return (
    <Screen>
      <Topbar>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Workspaces
        </Button>
        <strong>Tokens</strong>
        <span className="flex-1" />
        <span className={muted}>{user.username}</span>
        <Button variant="ghost" size="sm" onClick={() => api.logout().then(onLogout)}>
          Sign out
        </Button>
      </Topbar>
      <ContentPane>
        <p className={cn("text-xs", muted)}>
          Personal access tokens authenticate as you (humans or agents) via{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>. The token value is shown once at
          creation; copy it now.
        </p>
        <form onSubmit={create} className="mt-3 flex gap-2">
          <Input
            placeholder="token name (e.g., 'my-agent')"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!name.trim()}>
            Create token
          </Button>
        </form>

        {created && (
          <div
            className={cn(
              "my-3 flex flex-col gap-2 rounded-md border border-[var(--cf-fg)] p-3",
            )}
          >
            <div className={cn("text-xs", muted)}>
              {created.name}: copy this now, it won't be shown again:
            </div>
            <code className="select-all break-all rounded border border-[var(--cf-border)] p-2 font-mono">
              {created.token}
            </code>
            <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
        )}

        {error && <div className="py-2 text-red-600">{error}</div>}
        {tokens && tokens.length === 0 && <div className={muted}>No tokens yet.</div>}
        {tokens && tokens.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {tokens.map((t) => (
              <li key={t.id}>
                <div className="flex w-full items-center gap-2.5 rounded-md px-4 py-3">
                  <strong>{t.name}</strong>
                  <span className={cn("text-xs", muted)}>
                    created {new Date(t.created_at).toISOString().slice(0, 10)}
                  </span>
                  <span className="flex-1" />
                  <Button variant="outline" size="sm" onClick={() => revoke(t.id)}>
                    Revoke
                  </Button>
                </div>
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


function InboxOrActivity({
  kind,
  queue,
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
  onReviewChange,
  onOpenIssue,
  onOpenPr,
  onMarkNotifRead,
  onMarkAllNotifsRead,
  onNewIssue,
}: {
  kind: "inbox" | "activity";
  queue: readonly ReviewQueueEntry[];
  openPrs: readonly OpenBranchRow[];
  issues: readonly IssueRow[];
  pinned: readonly IssueRow[];
  activities: readonly ActivityRow[];
  notifications: readonly NotificationRow[];
  scope: "mine" | "all";
  setScope: (s: "mine" | "all") => void;
  query: string;
  setQuery: (q: string) => void;
  onRefresh: () => void;
  onReviewChange: (entry: ReviewQueueEntry) => void;
  onOpenIssue: (number: number) => void;
  onOpenPr: (number: number) => void;
  onMarkNotifRead: (id: number) => void;
  onMarkAllNotifsRead: () => void;
  onNewIssue: () => void;
}): ReactElement {
  const isInbox = kind === "inbox";
  // In Inbox+Mine: only PRs awaiting your review (queue).
  // In Inbox+All or Activity: every open PR in the workspace.
  const useOpenList = !isInbox || scope === "all";
  const q = query.trim().toLowerCase();
  const sourceQueue: ReviewQueueEntry[] = useOpenList
    ? openPrs.map((p) => ({ ...p, approvals: 0, rejections: 0 }))
    : [...queue];
  const visibleQueue = q
    ? sourceQueue.filter((qe) => qe.title.toLowerCase().includes(q))
    : sourceQueue;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 px-2 py-1">
        <strong>{isInbox ? "Inbox" : "Activity"}</strong>
        <div className="flex items-center gap-1">
          {isInbox && (
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
          <Button
            variant="outline"
            size="sm"
            onClick={onNewIssue}
            data-testid="new-issue"
            aria-label="New issue"
          >
            + Issue
          </Button>
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
      {visibleQueue.length === 0 && issues.length === 0 && notifications.length === 0 && (
        <div className={cn("px-3 py-2 text-xs", muted)}>
          {isInbox ? "Nothing waiting on you." : "No open activity."}
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
      {visibleQueue.length > 0 && (
        <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide opacity-70">
          {useOpenList ? "Open pull requests" : "Pull requests awaiting your review"}
        </div>
      )}
      <ul className="m-0 p-0">
        {visibleQueue.map((entry) => (
          <li key={`pr-${entry.number}`}>
            <FileRow onClick={() => onReviewChange(entry)} testId={`review-queue-pull-${entry.number}`}>
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
      {!isInbox && activities.length > 0 && (
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
          {isInbox ? (scope === "mine" ? "Your issues" : "Issues") : "Open issues"}
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
      <strong className="text-[var(--cf-fg)]">@{row.actor ?? "?"}</strong>
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
                  <div className="text-xs pl-4 whitespace-pre-wrap break-words">{a.comment}</div>
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
  const [queue, setQueue] = useState<ReviewQueueEntry[] | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);
  const [sidebarView, setSidebarView] = useState<"pages" | "inbox" | "activity" | "outline" | "settings">("pages");
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [issuesScope, setIssuesScope] = useState<"mine" | "all">("mine");
  const [inboxQuery, setInboxQuery] = useState("");
  const [openBranches, setOpenBranches] = useState<OpenBranchRow[] | null>(null);
  const [pinnedIssues, setPinnedIssues] = useState<IssueRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [notifs, setNotifs] = useState<NotificationRow[]>([]);
  const [viewingIssue, setViewingIssue] = useState<number | null>(null);
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueBody, setNewIssueBody] = useState("");
  const [newIssueBusy, setNewIssueBusy] = useState(false);
  const editorRef = useRef<MountedEditor | null>(null);
  const [editorMode, setEditorMode] = useState<"rich" | "source">("rich");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [reviewingPullNumber, setReviewingPullNumber] = useState<number | null>(null);
  const [reviewState, setReviewState] = useState<{
    pr: PrMeta | null;
    diff: ChangeDiff | null;
    comments: LineComment[];
    selectedPath: string | null;
    busy: boolean;
    draftReviewId: number | null;
  }>({ pr: null, diff: null, comments: [], selectedPath: null, busy: false, draftReviewId: null });
  // The active writable change id; set synchronously from each save response.
  // We track only the id to avoid a stale-state race between setHasPending
  // and a separate listChanges round-trip.
  const [currentBranchName, setCurrentBranchName] = useState<string | null>(null);
  const [reviewBranchName, setReviewBranchName] = useState<string | null>(null);
  const [changesReady, setChangesReady] = useState(false);
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
    if (markReady) setChangesReady(false);
    api
      .myBranches(workspace.slug)
      .then((branches) => {
        setCurrentBranchName((current) => {
          // If the user has an explicit branch selected, keep it. Forgejo's
          // branch listing is eventually consistent — a branch we just
          // created via PUT /file may take a beat to appear in /branches/mine,
          // and clearing the selection in the interim wipes the publish
          // affordance and the post-save tree refresh.
          if (current) return current;
          return branches.length === 1 ? (branches[0]?.name ?? null) : null;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (markReady) setChangesReady(true);
      });
  }, [workspace.slug]);

  useEffect(() => {
    reloadBranches(true);
  }, [reloadBranches]);

  const openPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const reviewingPullNumberRef = useRef<number | null>(null);
  // Tracks the branchId the currently-open file was last fetched against, so
  // background refetches (e.g. SSE-driven refreshes) keep hitting the same
  // branch even after currentBranchName is nulled by publish.
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
  const openQueueRef = useRef<() => void>(() => {});
  useEffect(() => {
    reloadTreeRef.current = reloadTree;
    reloadBranchesRef.current = reloadBranches;
  }, [reloadTree, reloadBranches]);

  useEffect(() => {
    const url = `/api/v1/w/${encodeURIComponent(workspace.slug)}/events`;
    const es = new EventSource(url, { withCredentials: true });
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
            api
              .getFile(workspace.slug, event.path, openFileBranchRef.current ?? undefined)
              .then((r) => setContent(r.content))
              .catch(() => undefined);
          }
        }
      } else if (event.type === "pull" || event.type === "pull_reviewed") {
        openQueueRef.current();
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

  // Open whatever file is in the URL on workspace entry. Intentionally
  // omits openPathFromSource from the deps: its identity changes whenever
  // activeBranchName updates, and re-running it after a save would refetch
  // the file and wipe `dirty=true` from any local edits in flight.
  const initialOpenRef = useRef(false);
  useEffect(() => {
    if (!changesReady || initialOpenRef.current) return;
    const r = parseRoute();
    if (r.kind === "workspace" && r.slug === workspace.slug && r.filePath) {
      initialOpenRef.current = true;
      openPathFromSource(r.filePath, { push: false, force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional, see comment above
  }, [changesReady, workspace.slug]);

  useEffect(() => {
    const handler = (): void => {
      const r = parseRoute();
      if (r.kind !== "workspace" || r.slug !== workspace.slug) return;
      if (!r.filePath) {
        if (dirtyRef.current && !confirm("Discard unsaved changes?")) {
          navigate({ kind: "workspace", slug: workspace.slug, filePath: openPathRef.current }, "replace");
          return;
        }
        setOpenPath(null);
        setOpenDoc(undefined);
        setContent("");
        setDirty(false);
        return;
      }
      const opened = openPathFromSource(r.filePath, { push: false });
      if (!opened) navigate({ kind: "workspace", slug: workspace.slug, filePath: openPathRef.current }, "replace");
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [workspace.slug, openPathFromSource]);

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
      currentBranchNameRef.current ??
      `${userBranchPrefix(user.forgejo_username ?? user.username)}wip-${shortId()}`,
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

  const openQueue = useCallback(() => {
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
            return { ...p, approvals: r.approvals, rejections: r.rejections } as ReviewQueueEntry;
          }),
        ),
      )
      .then(setQueue)
      .catch(() => setQueue([]));
  }, [workspace.slug]);
  useEffect(() => {
    openQueueRef.current = openQueue;
  }, [openQueue]);

  const refreshIssues = useCallback(
    (scope: "mine" | "all", panel: "inbox" | "activity", q: string) => {
      const filter = panel === "inbox" && scope === "mine" ? "mine" : undefined;
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

  // Fetch issues whenever the user opens Inbox/Activity, switches scope, or
  // changes the search query. Server-side LIKE filter on title.
  useEffect(() => {
    if (sidebarView === "inbox" || sidebarView === "activity") {
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
      .then(setOpenBranches)
      .catch(() => setOpenBranches([]));
  }, [workspace.slug]);

  const refreshPinned = useCallback(async () => {
    try {
      const r = await api.listPinnedIssues(workspace.slug);
      setPinnedIssues(r.issues);
    } catch (_err) {
      setPinnedIssues([]);
    }
  }, [workspace.slug]);

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

  const reviewChange = useCallback(
    (entry: ReviewQueueEntry) => {
      setReviewingPullNumber(entry.number);
      setReviewBranchName(entry.head_ref);
      setCurrentBranchName(null);
      setSidebarView("pages");
      setStatus(null);
      loadApprovals(entry.number);
    },
    [loadApprovals],
  );

  const publish = useCallback(
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
          } else {
            setStatus(`pull request #${pr.number} opened`);
          }
          setCurrentBranchName(null);
          openQueue();
          void loadTree();
        } catch (err) {
          setStatus(err instanceof ApiError ? err.message : "Open pull request failed");
        } finally {
          setBusy(false);
        }
      })();
    },
    [workspace.slug, currentBranchName, openQueue],
  );

  // Submit a review decision (approve, request_changes, or comment-only) on
  // the PR currently being reviewed.
  const submitReview = useCallback(
    async (decision: Decision, body: string) => {
      const n = reviewingPullNumber;
      if (!n) return;
      const comment = body.trim() || undefined;
      const draftId = reviewState.draftReviewId;
      setReviewState((s) => ({ ...s, busy: true }));
      try {
        if (draftId) {
          await api.submitDraftReview(workspace.slug, n, draftId, {
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
        openQueue();
        const pr = await api.getPull(workspace.slug, n).catch(() => null);
        if (pr) {
          setReviewState((s) => ({ ...s, pr, draftReviewId: null }));
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
    [reviewingPullNumber, workspace.slug, reviewState.draftReviewId, loadApprovals, openQueue],
  );

  const closeReviewedChange = useCallback(async () => {
    const n = reviewingPullNumber;
    if (!n) return;
    setReviewState((s) => ({ ...s, busy: true }));
    try {
      await api.closePull(workspace.slug, n);
      setStatus("Pull request closed");
      setReviewingPullNumber(null);
      setReviewBranchName(null);
      openQueue();
      void loadTree();
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "close failed");
    } finally {
      setReviewState((s) => ({ ...s, busy: false }));
    }
  }, [reviewingPullNumber, workspace.slug, openQueue]);

  // When entering review, fetch PR meta + per-file diff. Clear on exit.
  // Each transition (enter, switch PR, exit) clears selectedPath + reviewBranchName
  // first so a stale file or branch from the previous PR can't leak through.
  useEffect(() => {
    setReviewBranchName(null);
    setReviewState({ pr: null, diff: null, comments: [], selectedPath: null, busy: false, draftReviewId: null });
    if (!reviewingPullNumber) return;
    let cancelled = false;
    Promise.all([
      api.getPull(workspace.slug, reviewingPullNumber),
      api.listPullFiles(workspace.slug, reviewingPullNumber),
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

  const refreshReviewComments = useCallback(() => {
    const n = reviewingPullNumber;
    if (!n) return;
    api
      .listComments(workspace.slug, n)
      .then((comments) => setReviewState((s) => ({ ...s, comments })))
      .catch(() => undefined);
  }, [reviewingPullNumber, workspace.slug]);

  const addReviewComment = useCallback(
    async (target: { path: string; line: number; side: "new" | "old" }, body: string) => {
      const n = reviewingPullNumber;
      if (!n) return;
      const draftId = reviewState.draftReviewId;
      if (draftId) {
        await api.addDraftReviewComment(workspace.slug, n, draftId, { ...target, body });
      } else {
        await api.addComment(workspace.slug, n, { ...target, body });
      }
      refreshReviewComments();
    },
    [reviewingPullNumber, workspace.slug, reviewState.draftReviewId, refreshReviewComments],
  );

  const editReviewComment = useCallback(
    async (commentId: number, body: string) => {
      const n = reviewingPullNumber;
      if (!n) return;
      await api.editComment(workspace.slug, n, commentId, body);
      refreshReviewComments();
    },
    [reviewingPullNumber, workspace.slug, refreshReviewComments],
  );

  const deleteReviewComment = useCallback(
    async (commentId: number, reviewId: number) => {
      const n = reviewingPullNumber;
      if (!n) return;
      await api.deleteComment(workspace.slug, n, commentId, reviewId);
      refreshReviewComments();
    },
    [reviewingPullNumber, workspace.slug, refreshReviewComments],
  );

  const toggleDraftReview = useCallback(async () => {
    const n = reviewingPullNumber;
    if (!n) return;
    if (reviewState.draftReviewId) {
      // Cancel local batch — Forgejo keeps the PENDING review server-side
      // for reuse; we just stop sending into it.
      setReviewState((s) => ({ ...s, draftReviewId: null }));
      return;
    }
    setReviewState((s) => ({ ...s, busy: true }));
    try {
      const { review_id } = await api.startDraftReview(workspace.slug, n);
      setReviewState((s) => ({ ...s, draftReviewId: review_id }));
    } catch (err) {
      setStatus(err instanceof ApiError ? err.message : "could not start a pending review");
    } finally {
      setReviewState((s) => ({ ...s, busy: false }));
    }
  }, [reviewingPullNumber, workspace.slug, reviewState.draftReviewId]);

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
        if (!busy) publish();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openPath, dirty, save, busy, publish]);

  const create = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    let path = newPath.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";
    setBusy(true);
    const branch =
      currentBranchName ??
      `${userBranchPrefix(user.forgejo_username ?? user.username)}wip-${shortId()}`;
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

  return (
    <Screen>
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
          <div className={cn("flex items-center gap-0.5 border-b px-1 py-0.5 text-xs", borderColor)}>
            <SidebarTab
              active={sidebarView === "pages"}
              onClick={() => setSidebarView("pages")}
              testId="sidebar-tab-pages"
            >
              Pages
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "inbox"}
              onClick={() => {
                setSidebarView("inbox");
                openQueue();
              }}
              testId="sidebar-tab-inbox"
            >
              Inbox
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "activity"}
              onClick={() => setSidebarView("activity")}
              testId="sidebar-tab-activity"
            >
              Activity
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "outline"}
              onClick={() => setSidebarView("outline")}
              disabled={!openPath}
            >
              Outline
            </SidebarTab>
            {workspace.role === "admin" && (
              <SidebarTab
                active={sidebarView === "settings"}
                onClick={() => setSidebarView("settings")}
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
          ) : sidebarView === "inbox" || sidebarView === "activity" ? (
            <InboxOrActivity
              kind={sidebarView}
              queue={queue ?? []}
              issues={issues ?? []}
              pinned={pinnedIssues}
              activities={activities}
              scope={issuesScope}
              setScope={setIssuesScope}
              query={inboxQuery}
              setQuery={setInboxQuery}
              onRefresh={() => {
                openQueue();
                refreshPinned();
                if (sidebarView === "inbox") refreshNotifs();
                if (sidebarView === "inbox" || sidebarView === "activity") {
                  // refresh issues too
                  api
                    .listIssues(workspace.slug, {
                      state: "open",
                      ...(sidebarView === "inbox" && issuesScope === "mine"
                        ? { filter: "mine" as const }
                        : {}),
                    })
                    .then((r) => setIssues(r.issues))
                    .catch(() => undefined);
                }
              }}
              openPrs={openBranches ?? []}
              notifications={notifs}
              onReviewChange={reviewChange}
              onOpenIssue={(n) => {
                setNewIssueOpen(false);
                setViewingIssue(n);
              }}
              onOpenPr={(prNumber) => {
                const row = (openBranches ?? []).find((r) => r.number === prNumber);
                if (row) reviewChange({ ...row, approvals: 0, rejections: 0 });
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
                setViewingIssue(null);
                setNewIssueOpen(true);
              }}
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
                    <Button
                      variant="ghost"
                      size="icon"
                      data-testid="new-file-toggle"
                      onClick={() => setCreating((v) => !v)}
                      aria-label={creating ? "Cancel" : "New file"}
                    >
                      {creating ? "−" : "+"}
                    </Button>
                  </div>
                  {creating && (
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
              workspaceSlug={workspace.slug}
              number={viewingIssue}
              documentContext={workspaceCtx}
              currentForgejoUsername={user.forgejo_username}
              canManageLabels={workspace.role === "admin"}
              canPin={workspace.role === "admin"}
              isPinned={pinnedIssues.some((p) => p.number === viewingIssue)}
              onPinChanged={refreshPinned}
              onClose={() => setViewingIssue(null)}
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
                const pr = (openBranches ?? []).find((c) => c.number === n) ?? (queue ?? []).find((c) => c.number === n);
                if (pr) {
                  setViewingIssue(null);
                  reviewChange({ ...pr, approvals: 0, rejections: 0 });
                } else {
                  setViewingIssue(n);
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
                placeholder="Describe the question, problem, or proposal…"
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
                      setViewingIssue(created.number);
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
              <SettingsPanel workspaceSlug={workspace.slug} />
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
                <MarkdownEditor
                  key={openPath}
                  value={content}
                  mode={editorMode}
                  from={openPath ?? undefined}
                  testId="editor"
                  onReady={(editor) => {
                    editorRef.current = editor;
                    setOutline(editor.outline.get());
                    editor.outline.subscribe(setOutline);
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
                  workspaceSlug={workspace.slug}
                  file={
                    reviewState.diff?.files.find((f) => f.path === reviewState.selectedPath) ??
                    reviewState.diff?.files[0] ??
                    null
                  }
                  loadContent={loadReviewFileContent}
                  comments={reviewState.comments}
                  currentForgejoUsername={user.forgejo_username}
                  onAddComment={
                    // Hide the inline composer for the author of the PR — even
                    // admins/writers can't review their own changes, so the
                    // affordance would be misleading.
                    reviewState.pr?.author_username === user.forgejo_username
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
                  isAuthor={reviewState.pr.author_username === user.forgejo_username}
                  onSubmit={submitReview}
                  onClose={closeReviewedChange}
                  busy={reviewState.busy}
                  draftReviewActive={reviewState.draftReviewId !== null}
                  onToggleDraftReview={toggleDraftReview}
                />
              )}
            </>
          )}
          {activeBranchName && (
            <span data-testid="active-branch-id" hidden>{activeBranchName}</span>
          )}
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
              {openPath && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditorMode((m) => (m === "rich" ? "source" : "rich"))}
                    title={editorMode === "rich" ? "Switch to source mode" : "Switch to rich mode"}
                    className="px-1.5 rounded hover:bg-[var(--cf-hover)]"
                  >
                    {editorMode === "rich" ? "Source" : "Rich"}
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || busy || !!reviewingPullNumber}
                    className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                  >
                    Save
                  </button>
                  {currentBranchName && (
                    <>
                      <span data-testid="active-branch-name" className="hidden">
                        {currentBranchName}
                      </span>
                      {workspace.role === "admin" && (
                        <button
                          type="button"
                          data-testid="publish-direct"
                          onClick={() => publish("direct")}
                          disabled={busy}
                          title="Squash-merge this branch into main (⇧⌘P)"
                          className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                        >
                          Merge to main
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="publish-review"
                        onClick={() => publish("review")}
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
        </main>
      </div>
    </Screen>
  );
}
