import type { ReactElement } from "react";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ApprovalRecord,
  type Backlink,
  type FileEntry,
  type ProposalTarget,
  type QueueEntry,
  type SearchResult,
  type TokenInfo,
  type User,
  type Workspace,
} from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { lineDiff, stripFrontmatter } from "./diff";
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

const muted = "text-[var(--cf-muted)]";
const borderColor = "border-[var(--cf-border)]";

export function CosheafApp(): ReactElement {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setView(user ? { kind: "workspaces", user } : { kind: "login" }))
      .catch(() => setView({ kind: "login" }));
  }, []);

  if (view.kind === "loading") {
    return <div className="h-full" />;
  }
  if (view.kind === "login") {
    return <LoginScreen onLoggedIn={(user) => setView({ kind: "workspaces", user })} />;
  }
  if (view.kind === "workspaces") {
    return (
      <WorkspaceList
        user={view.user}
        onPick={(workspace) => setView({ kind: "workspace", user: view.user, workspace })}
        onTokens={() => setView({ kind: "tokens", user: view.user })}
        onLogout={() => setView({ kind: "login" })}
      />
    );
  }
  if (view.kind === "tokens") {
    return (
      <TokensScreen
        user={view.user}
        onBack={() => setView({ kind: "workspaces", user: view.user })}
        onLogout={() => setView({ kind: "login" })}
      />
    );
  }
  return (
    <WorkspaceView
      user={view.user}
      workspace={view.workspace}
      onBack={() => setView({ kind: "workspaces", user: view.user })}
      onLogout={() => setView({ kind: "login" })}
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

function ProposalDiffPanel({
  proposalBody,
  target,
  onOpenTarget,
}: {
  proposalBody: string;
  target: ProposalTarget;
  onOpenTarget: (path: string) => void;
}): ReactElement {
  const targetBody = stripFrontmatter(target.target_content);
  const diff = lineDiff(targetBody, stripFrontmatter(proposalBody));
  let adds = 0;
  let dels = 0;
  for (const d of diff) {
    if (d.kind === "add") adds++;
    else if (d.kind === "del") dels++;
  }
  const title = (
    <>
      Diff vs{" "}
      <button
        type="button"
        onClick={() => onOpenTarget(target.target_path)}
        className="underline-offset-2 hover:underline"
      >
        {target.target_title ?? target.target_path}
      </button>{" "}
      <span className={cn("text-xs normal-case tracking-normal", muted)}>
        +{adds} −{dels}
      </span>
    </>
  );
  if (adds === 0 && dels === 0) {
    return (
      <SidePanel title={title}>
        <div className={cn("px-2 py-1 text-xs", muted)}>No changes.</div>
      </SidePanel>
    );
  }
  return (
    <SidePanel title={title}>
      <div className="whitespace-pre-wrap break-words font-mono text-xs leading-snug">
        {diff.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              "px-1.5",
              line.kind === "eq" && muted,
              line.kind === "add" && "bg-green-500/15",
              line.kind === "del" && "bg-red-500/15",
            )}
          >
            <span className="inline-block w-5 select-none opacity-60">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            {line.text || " "}
          </div>
        ))}
      </div>
    </SidePanel>
  );
}

function ApprovalsPanel({
  approvals,
  onOpenReview,
}: {
  approvals: ApprovalRecord[];
  onOpenReview: (path: string) => void;
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
              {a.review_path && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => a.review_path && onOpenReview(a.review_path)}
                    className="underline-offset-2 hover:underline"
                  >
                    {a.review_title ?? a.review_path}
                  </button>
                </>
              )}
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
}: {
  active?: boolean;
  title?: string;
  doc?: FileEntry["doc"];
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center gap-1.5 px-3 py-1 text-left text-[13px] text-[var(--cf-fg)] hover:bg-[var(--cf-hover)]",
        active && "bg-[var(--cf-active)] font-medium",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {doc && statusBadge(doc.status)}
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
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<FileEntry["doc"] | undefined>(undefined);
  const [content, setContent] = useState("");
  const [mtime, setMtime] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposalBody, setProposalBody] = useState("");
  const [editorMode, setEditorMode] = useState<"rich" | "source">("rich");
  const [reviewComment, setReviewComment] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [proposalTarget, setProposalTarget] = useState<ProposalTarget | null>(null);
  const [pendingReview, setPendingReview] = useState<{
    targetId: string;
    reviewId: string;
  } | null>(null);

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
    const url = `/api/w/${encodeURIComponent(workspace.slug)}/events`;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (msg) => {
      let event: { type: string; path?: string };
      try {
        event = JSON.parse(msg.data);
      } catch (_err) {
        return;
      }
      if (event.type !== "change" && event.type !== "remove") return;
      reloadTree();
      if (
        event.type === "change" &&
        event.path &&
        event.path === openPathRef.current &&
        !dirtyRef.current
      ) {
        api
          .getNote(workspace.slug, event.path)
          .then((r) => {
            setContent(r.content);
            setMtime(r.mtime);
          })
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
        .getNote(workspace.slug, entry.path)
        .then((r) => {
          setOpenPath(entry.path);
          setOpenDoc(entry.doc);
          setContent(r.content);
          setMtime(r.mtime);
          setDirty(false);
          loadBacklinks(entry.doc?.id);
          loadApprovals(entry.doc?.id);
          setReviewComment("");
          if (entry.doc?.type === "proposal" && entry.doc?.id) {
            api
              .proposalTarget(workspace.slug, entry.doc.id)
              .then(setProposalTarget)
              .catch(() => setProposalTarget(null));
          } else {
            setProposalTarget(null);
          }
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
      .putNote(workspace.slug, openPath, content, mtime ?? undefined)
      .then((r) => {
        setMtime(r.mtime);
        if (r.content !== undefined) setContent(r.content);
        setDirty(false);
        setStatus("saved");
        setOpenDoc(r.meta);
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
  }, [openPath, content, mtime, workspace.slug, reloadTree, loadBacklinks]);

  const openQueue = useCallback(() => {
    api
      .queue(workspace.slug)
      .then(setQueue)
      .catch(() => setQueue([]));
  }, [workspace.slug]);

  const submitDoc = useCallback(() => {
    if (!openDoc?.id) return;
    api
      .submit(workspace.slug, openDoc.id)
      .then((r) => {
        setStatus("submitted");
        setOpenDoc((d) => (d ? { ...d, status: r.status as typeof d.status } : d));
        reloadTree();
      })
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Submit failed"),
      );
  }, [openDoc, workspace.slug, reloadTree]);

  const decideDoc = useCallback(
    (decision: "approve" | "reject") => {
      if (!openDoc?.id) return;
      const fn = decision === "approve" ? api.approve : api.reject;
      const comment = reviewComment.trim() || undefined;
      const docId = openDoc.id;
      const reviewId =
        pendingReview && pendingReview.targetId === docId ? pendingReview.reviewId : undefined;
      fn(workspace.slug, docId, comment, reviewId)
        .then((r) => {
          setStatus(`${decision}d (status: ${r.doc_status})`);
          setOpenDoc((d) => (d ? { ...d, status: r.doc_status } : d));
          setReviewComment("");
          if (reviewId) setPendingReview(null);
          loadApprovals(docId);
          reloadTree();
          if (r.promoted_meta && r.promoted_meta.id !== docId) {
            const targetEntry = files?.find((f) => f.doc?.id === r.promoted_meta?.id);
            if (targetEntry) open(targetEntry);
          }
        })
        .catch((err: unknown) =>
          setStatus(err instanceof ApiError ? err.message : `${decision} failed`),
        );
    },
    [openDoc, workspace.slug, files, open, reloadTree, reviewComment, loadApprovals, pendingReview],
  );

  const writeReview = useCallback(() => {
    if (!openDoc?.id) return;
    const targetId = openDoc.id;
    api
      .createReview(workspace.slug, targetId, "")
      .then((r) => {
        setPendingReview({ targetId, reviewId: r.meta.id });
        reloadTree();
        const newPath = r.path;
        api
          .tree(workspace.slug)
          .then((files) => {
            const entry = files.find((f) => f.path === newPath);
            if (entry) open(entry);
            setFiles(files);
          })
          .catch(() => undefined);
      })
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Failed to create review"),
      );
  }, [openDoc, workspace.slug, open, reloadTree]);

  const submitProposal = useCallback(() => {
    if (!openDoc?.id || !proposalBody.trim()) return;
    api
      .createProposal(workspace.slug, openDoc.id, proposalBody.trim())
      .then(() => {
        setProposeOpen(false);
        setProposalBody("");
        setStatus("proposal created");
        reloadTree();
      })
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Proposal failed"),
      );
  }, [openDoc, proposalBody, workspace.slug, reloadTree]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (openPath && dirty) save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openPath, dirty, save]);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    let path = newPath.trim();
    if (!path) return;
    if (!path.endsWith(".md")) path += ".md";
    setBusy(true);
    api
      .putNote(workspace.slug, path, `# ${path.replace(/\.md$/, "")}\n`)
      .then((r) => {
        setOpenPath(path);
        setContent(r.content ?? `# ${path.replace(/\.md$/, "")}\n`);
        setMtime(r.mtime);
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
      <Topbar>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Workspaces
        </Button>
        <strong>{workspace.name}</strong>
        <span className={muted}>/{workspace.slug}</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (queue === null ? openQueue() : setQueue(null))}
        >
          {queue === null ? "Queue" : "Files"}
        </Button>
        <span className={muted}>{user.username}</span>
        <Button variant="ghost" size="sm" onClick={() => api.logout().then(onLogout)}>
          Sign out
        </Button>
      </Topbar>
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex w-60 shrink-0 flex-col border-r min-h-0",
            borderColor,
          )}
        >
          {queue !== null ? (
            <div className="flex min-h-0 flex-col">
              <div className="flex items-center justify-between gap-3 px-2 py-1">
                <strong>Review queue</strong>
                <Button variant="ghost" size="icon" onClick={openQueue} aria-label="Refresh">
                  ↻
                </Button>
              </div>
              {queue.length === 0 && (
                <div className={cn("px-3 py-2 text-xs", muted)}>Nothing to review.</div>
              )}
              <ul className="m-0 flex-1 overflow-y-auto p-0">
                {queue.map((entry) => (
                  <li key={entry.id}>
                    <FileRow
                      onClick={() => {
                        const f = files?.find((x) => x.path === entry.path);
                        if (f) {
                          setQueue(null);
                          open(f);
                        }
                      }}
                    >
                      <strong>{entry.title ?? entry.path}</strong>
                      <span className={cn("text-xs", muted)}>
                        {" "}
                        {entry.type}
                        {entry.target_id && ` → ${entry.target_id}`}
                        {entry.approvals > 0 && ` ✓${entry.approvals}`}
                        {entry.rejections > 0 && ` ✗${entry.rejections}`}
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
                          <span
                            className={cn(
                              "text-xs [&_mark]:bg-yellow-300/40 [&_mark]:text-inherit",
                              muted,
                            )}
                            dangerouslySetInnerHTML={{ __html: ` ${r.snippet}` }}
                          />
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
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {!openPath && (
            <div className={cn("flex flex-1 items-center justify-center", muted)}>
              Select a file from the sidebar, or create one.
            </div>
          )}
          {openPath && (
            <>
              <div
                className={cn(
                  "flex items-center gap-2.5 border-b px-4 py-1.5",
                  borderColor,
                )}
              >
                <strong>{openPath}</strong>
                {openDoc && statusBadge(openDoc.status)}
                {dirty && <span className="text-[var(--cf-accent)]">●</span>}
                <span className="flex-1" />
                <span className={cn("text-xs", muted)}>{status ?? ""}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditorMode((m) => (m === "rich" ? "source" : "rich"))}
                  title={editorMode === "rich" ? "Switch to source mode" : "Switch to rich mode"}
                >
                  {editorMode === "rich" ? "Source" : "Rich"}
                </Button>
                {openDoc?.status === "draft" && (
                  <Button size="sm" onClick={submitDoc} disabled={dirty || busy}>
                    Submit
                  </Button>
                )}
                {openDoc?.status === "unreviewed" &&
                  (workspace.role === "owner" || workspace.role === "verifier") && (
                    <>
                      <Input
                        placeholder="Comment (optional)"
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                        className="h-8 max-w-[16rem]"
                      />
                      <Button variant="outline" size="sm" onClick={writeReview} disabled={busy}>
                        Write review
                      </Button>
                      {pendingReview?.targetId === openDoc?.id && (
                        <span className={cn("text-xs", muted)}>review attached</span>
                      )}
                      <Button size="sm" onClick={() => decideDoc("approve")} disabled={busy}>
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => decideDoc("reject")}
                        disabled={busy}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                {openDoc?.status === "golden" && openDoc.type === "page" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setProposeOpen((v) => !v)}
                  >
                    {proposeOpen ? "Cancel proposal" : "Propose update"}
                  </Button>
                )}
                <Button size="sm" onClick={save} disabled={!dirty || busy}>
                  Save
                </Button>
              </div>
              {proposeOpen && (
                <div
                  className={cn(
                    "flex flex-col gap-1.5 border-t px-4 py-2",
                    borderColor,
                  )}
                >
                  <div className={cn("text-xs", muted)}>
                    Propose a replacement body for{" "}
                    <strong>{openDoc?.title ?? openPath}</strong>. Don't include frontmatter —
                    only the body.
                  </div>
                  <Textarea
                    value={proposalBody}
                    onChange={(e) => setProposalBody(e.target.value)}
                    placeholder="# Updated title\n\nNew content..."
                    className="min-h-[120px] resize-y font-mono"
                  />
                  <div>
                    <Button size="sm" onClick={submitProposal} disabled={!proposalBody.trim()}>
                      Create proposal
                    </Button>
                  </div>
                </div>
              )}
              <Suspense fallback={<div className="flex-1" />}>
                <MarkdownEditor
                  value={content}
                  mode={editorMode}
                  onChange={(next) => {
                    setContent(next);
                    setDirty(true);
                    setStatus(null);
                  }}
                  onSave={() => {
                    if (dirty && !busy) save();
                  }}
                />
              </Suspense>
              {openDoc?.id && (
                <BacklinksPanel
                  links={backlinks}
                  onPick={(srcPath) => {
                    const entry = files?.find((f) => f.path === srcPath);
                    if (entry) open(entry);
                  }}
                />
              )}
              {openDoc?.type === "proposal" && proposalTarget && (
                <ProposalDiffPanel
                  proposalBody={content}
                  target={proposalTarget}
                  onOpenTarget={(targetPath) => {
                    const entry = files?.find((f) => f.path === targetPath);
                    if (entry) open(entry);
                  }}
                />
              )}
              {openDoc?.id && approvals.length > 0 && (
                <ApprovalsPanel
                  approvals={approvals}
                  onOpenReview={(reviewPath) => {
                    const entry = files?.find((f) => f.path === reviewPath);
                    if (entry) open(entry);
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>
    </Screen>
  );
}
