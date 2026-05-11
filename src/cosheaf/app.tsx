import type { ReactElement } from "react";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { MountedEditor } from "@chaoxu/coflat-editor";

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
  type ApprovalRecord,
  type Backlink,
  type FileEntry,
  type QueueEntry,
  type SearchResult,
  type TokenInfo,
  type User,
  type Workspace,
} from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";

const MarkdownEditor = lazy(() =>
  import("./editor").then((m) => ({ default: m.MarkdownEditor })),
);

type View =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "workspaces"; user: User }
  | { kind: "tokens"; user: User }
  | { kind: "workspace"; user: User; workspace: Workspace };

type DocStatus = NonNullable<FileEntry["doc"]>["status"];

function SidebarTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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

  const submit = (e: React.FormEvent) => {
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
        <label className={cn("flex flex-col gap-1 text-xs", muted)}>
          <span>username</span>
          <Input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className={cn("flex flex-col gap-1 text-xs", muted)}>
          <span>password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
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

  const handleCreate = (e: React.FormEvent) => {
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
            <Input
              placeholder="slug (lowercase, dashes)"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              autoFocus
            />
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

  const create = (e: React.FormEvent) => {
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
              {created.name} — copy this now, it won't be shown again:
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


function ApprovalsPanel({
  approvals,
}: {
  approvals: ApprovalRecord[];
}): ReactElement {
  return (
    <SidePanel title={`Reviews${approvals.length > 0 ? ` (${approvals.length})` : ""}`}>
      {approvals.length === 0 && (
        <div className={cn("px-2 py-1 text-xs", muted)}>No reviews yet.</div>
      )}
      {approvals.length > 0 && (
        <ul className="flex flex-col gap-1">
          {approvals.map((a) => (
            <li key={a.verifier_user_id}>
              <Badge variant={a.decision === "approve" ? "golden" : "rejected"}>
                {a.decision}
              </Badge>{" "}
              <strong>{a.username}</strong>
              {a.comment && <div className={cn("text-xs", muted)}>{a.comment}</div>}
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}

function statusBadge(status: DocStatus): ReactElement {
  return <Badge variant={status}>{status}</Badge>;
}

function FileRow({
  active,
  title,
  doc,
  onClick,
  children,
  testId,
}: {
  active?: boolean;
  title?: string;
  doc?: FileEntry["doc"];
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
      {doc && doc.type !== "page" && statusBadge(doc.status)}
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
  // Initial openPath comes from the URL so deep links work.
  const [openPath, setOpenPath] = useState<string | null>(() => {
    const r = parseRoute();
    return r.kind === "workspace" && r.slug === workspace.slug ? r.filePath : null;
  });
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
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);

  // Mirror openPath into the URL (push on user-driven change; replaceState-no-op
  // when popstate already updated the URL because `navigate` short-circuits when
  // the target URL matches window.location).
  useEffect(() => {
    navigate({ kind: "workspace", slug: workspace.slug, filePath: openPath });
  }, [openPath, workspace.slug]);

  // popstate within the workspace view: re-derive openPath from the URL.
  useEffect(() => {
    const handler = (): void => {
      const r = parseRoute();
      if (r.kind === "workspace" && r.slug === workspace.slug) {
        setOpenPath(r.filePath);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [workspace.slug]);
  const [sidebarView, setSidebarView] = useState<"files" | "queue" | "outline">("files");
  const editorRef = useRef<MountedEditor | null>(null);
  const [editorMode, setEditorMode] = useState<"rich" | "source">("rich");
  const [reviewComment, setReviewComment] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  // The active draft change id; set synchronously from each save response.
  // We track only the id to avoid a stale-state race between setHasPending
  // and a separate listChanges round-trip.
  const [currentChangeId, setCurrentChangeId] = useState<string | null>(null);

  const reloadTree = useCallback(() => {
    api
      .tree(workspace.slug)
      .then(setFiles)
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Failed to load tree"),
      );
  }, [workspace.slug]);

  useEffect(reloadTree, [reloadTree]);

  const openPathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    openPathRef.current = openPath;
  }, [openPath]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

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
        reloadTree();
        if (event.path && event.path === openPathRef.current) {
          if (event.type === "remove") {
            setOpenPath(null);
            setOpenDoc(undefined);
            setContent("");
            setDirty(false);
            setStatus("file deleted on server");
          } else if (!dirtyRef.current) {
            api
              .getFile(workspace.slug, event.path)
              .then((r) => setContent(r.content))
              .catch(() => undefined);
          }
        }
      } else if (event.type === "queue") {
        // PR opened/merged/closed/reviewed: refresh the queue list so any
        // open queue tab updates without a manual click.
        api
          .queue(workspace.slug)
          .then(setQueue)
          .catch(() => undefined);
      }
    };
    return () => es.close();
  }, [workspace.slug, reloadTree]);

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

  const loadApprovals = useCallback(
    (id: string | undefined) => {
      if (!id) {
        setApprovals([]);
        return;
      }
      api
        .approvals(workspace.slug, id)
        .then(setApprovals)
        .catch(() => setApprovals([]));
    },
    [workspace.slug],
  );

  const open = useCallback(
    (entry: FileEntry) => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setBusy(true);
      setStatus(null);
      api
        .getFile(workspace.slug, entry.path)
        .then((r) => {
          setOpenPath(entry.path);
          setOpenDoc(entry.doc);
          setContent(r.content);
          setDirty(false);
          loadBacklinks(entry.doc?.id);
          loadApprovals(entry.doc?.id);
          setReviewComment("");
        })
        .catch((err: unknown) =>
          setStatus(err instanceof ApiError ? err.message : "Failed to open"),
        )
        .finally(() => setBusy(false));
    },
    [dirty, workspace.slug, loadBacklinks, loadApprovals],
  );

  const save = useCallback(() => {
    if (!openPath) return;
    setBusy(true);
    setStatus(null);
    api
      .putFile(workspace.slug, openPath, content)
      .then((r) => {
        if (r.content !== undefined) setContent(r.content);
        setDirty(false);
        setStatus("saved (unpublished)");
        setOpenDoc(r.meta);
        setCurrentChangeId(r.change_id);
        loadBacklinks(r.meta.id);
        reloadTree();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 409) {
          setStatus("conflict — file changed on server. Reload to discard.");
        } else {
          setStatus(err instanceof ApiError ? err.message : "Save failed");
        }
      })
      .finally(() => setBusy(false));
  }, [openPath, content, workspace.slug, reloadTree, loadBacklinks]);

  const openQueue = useCallback(() => {
    api
      .queue(workspace.slug)
      .then(setQueue)
      .catch(() => setQueue([]));
  }, [workspace.slug]);

  const publish = useCallback(
    (mode?: "direct" | "review") => {
      if (!currentChangeId) {
        setStatus("nothing to publish");
        return;
      }
      setBusy(true);
      setStatus(null);
      api
        .publish(workspace.slug, currentChangeId, mode)
        .then((r) => {
          setStatus(r.message ?? (r.mode === "review" ? "sent for review" : "published"));
          setCurrentChangeId(null);
          reloadTree();
        })
        .catch((err: unknown) =>
          setStatus(err instanceof ApiError ? err.message : "Publish failed"),
        )
        .finally(() => setBusy(false));
    },
    [workspace.slug, currentChangeId, reloadTree],
  );

  // Decide on the queue's currently-open change. Approvals UI only shows when
  // the user is viewing a change in `review` state, looked up by the queue.
  const [reviewingChangeId, setReviewingChangeId] = useState<string | null>(null);
  const decideChange = useCallback(
    (decision: "approve" | "reject") => {
      const id = reviewingChangeId;
      if (!id) return;
      const fn = decision === "approve" ? api.approve : api.reject;
      const comment = reviewComment.trim() || undefined;
      fn(workspace.slug, id, comment)
        .then((r) => {
          setStatus(`${decision}d (state: ${r.state})`);
          setReviewComment("");
          loadApprovals(id);
          reloadTree();
          if (r.state === "merged" || r.state === "rejected") setReviewingChangeId(null);
        })
        .catch((err: unknown) =>
          setStatus(err instanceof ApiError ? err.message : `${decision} failed`),
        );
    },
    [reviewingChangeId, workspace.slug, reloadTree, reviewComment, loadApprovals],
  );

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

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    let path = newPath.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";
    setBusy(true);
    api
      .putFile(workspace.slug, path, `# ${path.replace(/\.md$/, "")}\n`)
      .then((r) => {
        setOpenPath(path);
        setContent(r.content ?? `# ${path.replace(/\.md$/, "")}\n`);
        setDirty(false);
        setNewPath("");
        setCreating(false);
        reloadTree();
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
            <SidebarTab active={sidebarView === "files"} onClick={() => setSidebarView("files")}>
              Files
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "queue"}
              onClick={() => {
                setSidebarView("queue");
                openQueue();
              }}
            >
              Queue
            </SidebarTab>
            <SidebarTab
              active={sidebarView === "outline"}
              onClick={() => setSidebarView("outline")}
              disabled={!openPath}
            >
              Outline
            </SidebarTab>
          </div>
          {sidebarView === "outline" ? (
            <OutlinePanel
              entries={outline}
              onPick={(line) => editorRef.current?.scrollToLine(line, { center: true })}
            />
          ) : sidebarView === "queue" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-3 px-2 py-1">
                <strong>Review queue</strong>
                <Button variant="ghost" size="icon" onClick={openQueue} aria-label="Refresh">
                  ↻
                </Button>
              </div>
              {(queue ?? []).length === 0 && (
                <div className={cn("px-3 py-2 text-xs", muted)}>Nothing to review.</div>
              )}
              <ul className="m-0 flex-1 overflow-y-auto p-0">
                {(queue ?? []).map((entry) => (
                  <li key={entry.id}>
                    <FileRow
                      onClick={() => setReviewingChangeId(entry.id)}
                    >
                      <strong>{entry.title}</strong>
                      <span className={cn("text-xs", muted)}>
                        {entry.approvals > 0 && ` ✓${entry.approvals}`}
                        {entry.rejections > 0 && ` ✗${entry.rejections}`}
                        {entry.pr_number && ` #${entry.pr_number}`}
                      </span>
                    </FileRow>
                  </li>
                ))}
              </ul>
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
                          }}
                        >
                          <strong>{r.title ?? r.path}</strong>
                          <span className={cn("text-xs", muted)}>
                            {" "}
                            {r.snippet.map((part, idx) =>
                              part.match ? (
                                <mark key={idx} className="bg-yellow-300/40 text-inherit">
                                  {part.text}
                                </mark>
                              ) : (
                                <span key={idx}>{part.text}</span>
                              ),
                            )}
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
                      onClick={() => setCreating((v) => !v)}
                      aria-label={creating ? "Cancel" : "New file"}
                    >
                      {creating ? "−" : "+"}
                    </Button>
                  </div>
                  {creating && (
                    <form onSubmit={create} className="flex gap-2 px-2 pb-2">
                      <Input
                        placeholder="path/to/note.md"
                        value={newPath}
                        onChange={(e) => setNewPath(e.target.value)}
                        autoFocus
                      />
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
                          doc={f.doc}
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
        <main className="relative flex min-w-0 flex-1 flex-col">
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
          {!openPath && (
            <div className={cn("flex flex-1 items-center justify-center", muted)}>
              Select a file from the sidebar, or create one.
            </div>
          )}
          {openPath && (
            <>
              <Suspense fallback={<div className="flex-1" />}>
                <MarkdownEditor
                  value={content}
                  mode={editorMode}
                  testId="editor"
                  onReady={(editor) => {
                    editorRef.current = editor;
                    setOutline(editor.outline.get());
                    editor.outline.subscribe(setOutline);
                  }}
                  onChange={(next) => {
                    setContent(next);
                    setDirty(true);
                    setStatus(null);
                  }}
                />
              </Suspense>
              {openDoc?.id && backlinks.length > 0 && (
                <BacklinksPanel
                  links={backlinks}
                  onPick={(srcPath) => {
                    const entry = files?.find((f) => f.path === srcPath);
                    if (entry) open(entry);
                  }}
                />
              )}
              {reviewingChangeId && approvals.length > 0 && (
                <ApprovalsPanel approvals={approvals} />
              )}
            </>
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
                  {openDoc && openDoc.type !== "page" && statusBadge(openDoc.status)}
                  {dirty && <span className="text-[var(--cf-accent)]">●</span>}
                </>
              ) : (
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
                  {reviewingChangeId && (workspace.role === "owner" || workspace.role === "verifier") && (
                    <>
                      <Input
                        placeholder="comment"
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                        className="h-5 text-xs max-w-[10rem]"
                      />
                      <button
                        type="button"
                        onClick={() => decideChange("approve")}
                        disabled={busy}
                        className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decideChange("reject")}
                        disabled={busy}
                        className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={save}
                    disabled={!dirty || busy}
                    className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                  >
                    Save
                  </button>
                  {currentChangeId && (
                    <>
                      {workspace.role === "owner" && (
                        <button
                          type="button"
                          onClick={() => publish("direct")}
                          disabled={busy}
                          title="Squash-merge your draft into main (⇧⌘P)"
                          className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                        >
                          Publish ●
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => publish("review")}
                        disabled={busy}
                        title="Open a PR for review"
                        className="px-1.5 rounded hover:bg-[var(--cf-hover)] disabled:opacity-50"
                      >
                        Send for review
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
