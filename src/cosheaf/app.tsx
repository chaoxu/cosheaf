import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { lineDiff, stripFrontmatter } from "./diff";
import { MarkdownEditor } from "./editor";

type View =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "workspaces"; user: User }
  | { kind: "tokens"; user: User }
  | { kind: "workspace"; user: User; workspace: Workspace };

export function CosheafApp(): ReactElement {
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setView(user ? { kind: "workspaces", user } : { kind: "login" }))
      .catch(() => setView({ kind: "login" }));
  }, []);

  if (view.kind === "loading") return <div className="status-page">Loading...</div>;
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
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>cosheaf</h1>
        <label>
          <span>username</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          <span>password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "..." : "Sign in"}
        </button>
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

  const handleLogout = () => {
    api.logout().then(onLogout);
  };

  return (
    <div className="screen">
      <header className="topbar">
        <strong>cosheaf</strong>
        <span className="spacer" />
        <span className="muted">{user.username}</span>
        <button className="link-btn" onClick={onTokens}>
          Tokens
        </button>
        <button className="link-btn" onClick={handleLogout}>
          Sign out
        </button>
      </header>
      <main className="content">
        <div className="header-row">
          <h2>Workspaces</h2>
          <button onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New"}</button>
        </div>

        {creating && (
          <form className="inline-form" onSubmit={handleCreate}>
            <input
              placeholder="slug (lowercase, dashes)"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              autoFocus
            />
            <input
              placeholder="display name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" disabled={!newSlug || !newName}>
              Create
            </button>
          </form>
        )}

        {error && <div className="error">{error}</div>}
        {workspaces === null && <div className="muted">Loading...</div>}
        {workspaces && workspaces.length === 0 && (
          <div className="muted">No workspaces yet. Create one to get started.</div>
        )}
        {workspaces && workspaces.length > 0 && (
          <ul className="ws-list">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <button className="ws-row" onClick={() => onPick(ws)}>
                  <strong>{ws.name}</strong>
                  <span className="muted">/{ws.slug}</span>
                  <span className="role">{ws.role}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
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
    <div className="screen">
      <header className="topbar">
        <button className="link-btn" onClick={onBack}>
          ← Workspaces
        </button>
        <strong>Tokens</strong>
        <span className="spacer" />
        <span className="muted">{user.username}</span>
        <button className="link-btn" onClick={() => api.logout().then(onLogout)}>
          Sign out
        </button>
      </header>
      <main className="content">
        <p className="muted small">
          Personal access tokens authenticate as you (humans or agents) via{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>. The token value is shown once at
          creation; copy it now.
        </p>
        <form className="inline-form" onSubmit={create}>
          <input
            placeholder="token name (e.g., 'my-agent')"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={!name.trim()}>
            Create token
          </button>
        </form>

        {created && (
          <div className="token-card">
            <div className="muted small">{created.name} — copy this now, it won't be shown again:</div>
            <code className="token-value">{created.token}</code>
            <button className="link-btn" onClick={() => setCreated(null)}>
              Dismiss
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}
        {tokens === null && <div className="muted">Loading...</div>}
        {tokens && tokens.length === 0 && <div className="muted">No tokens yet.</div>}
        {tokens && tokens.length > 0 && (
          <ul className="ws-list">
            {tokens.map((t) => (
              <li key={t.id}>
                <div className="ws-row" style={{ pointerEvents: "auto", cursor: "default" }}>
                  <strong>{t.name}</strong>
                  <span className="muted small">
                    created {new Date(t.created_at).toISOString().slice(0, 10)}
                  </span>
                  <span className="spacer" />
                  <button onClick={() => revoke(t.id)}>Revoke</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
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
    <div className="backlinks">
      <div className="backlinks-header">Backlinks {links.length > 0 && `(${links.length})`}</div>
      {links.length === 0 && <div className="muted small padded">None.</div>}
      {links.length > 0 && (
        <ul>
          {links.map((bl) => (
            <li key={`${bl.src_id}-${bl.target_label}`}>
              <button className="link-btn" onClick={() => onPick(bl.src_path)}>
                <strong>{bl.src_title ?? bl.src_path}</strong>
                <span className="muted small"> {bl.target_label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  const header = (
    <div className="backlinks-header">
      Diff vs{" "}
      <button className="link-btn" onClick={() => onOpenTarget(target.target_path)}>
        {target.target_title ?? target.target_path}
      </button>{" "}
      <span className="muted small">
        +{adds} −{dels}
      </span>
    </div>
  );
  if (adds === 0 && dels === 0) {
    return (
      <div className="backlinks">
        {header}
        <div className="muted small padded">No changes.</div>
      </div>
    );
  }
  return (
    <div className="backlinks">
      {header}
      <div className="diff-block">
        {diff.map((line, idx) => (
          <div key={idx} className={`diff-line diff-${line.kind}`}>
            <span className="diff-marker">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            {line.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApprovalsPanel({ approvals }: { approvals: ApprovalRecord[] }): ReactElement {
  return (
    <div className="backlinks">
      <div className="backlinks-header">
        Reviews {approvals.length > 0 && `(${approvals.length})`}
      </div>
      {approvals.length === 0 && <div className="muted small padded">No reviews yet.</div>}
      {approvals.length > 0 && (
        <ul>
          {approvals.map((a) => (
            <li key={a.verifier_user_id}>
              <span className={`badge badge-${a.decision === "approve" ? "golden" : "rejected"}`}>
                {a.decision}
              </span>{" "}
              <strong>{a.username}</strong>
              {a.comment && <div className="muted small">{a.comment}</div>}
            </li>
          ))}
        </ul>
      )}
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
  }, [openPath, content, mtime, workspace.slug, reloadTree]);

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
      fn(workspace.slug, docId, comment)
        .then((r) => {
          setStatus(`${decision}d (status: ${r.doc_status})`);
          setOpenDoc((d) => (d ? { ...d, status: r.doc_status } : d));
          setReviewComment("");
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
    [openDoc, workspace.slug, files, open, reloadTree, reviewComment, loadApprovals],
  );

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

  // Cmd/Ctrl+S to save.
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

  const handleLogout = () => {
    api.logout().then(onLogout);
  };

  return (
    <div className="screen">
      <header className="topbar">
        <button className="link-btn" onClick={onBack}>
          ← Workspaces
        </button>
        <strong>{workspace.name}</strong>
        <span className="muted">/{workspace.slug}</span>
        <span className="spacer" />
        <button className="link-btn" onClick={() => (queue === null ? openQueue() : setQueue(null))}>
          {queue === null ? "Queue" : "Files"}
        </button>
        <span className="muted">{user.username}</span>
        <button className="link-btn" onClick={handleLogout}>
          Sign out
        </button>
      </header>
      <div className="ws-layout">
        <aside className="ws-sidebar">
          {queue !== null && (
            <div className="queue-panel">
              <div className="header-row tight">
                <strong>Review queue</strong>
                <button className="link-btn" onClick={openQueue}>
                  ↻
                </button>
              </div>
              {queue.length === 0 && <div className="muted padded small">Nothing to review.</div>}
              <ul className="ws-files">
                {queue.map((entry) => (
                  <li key={entry.id}>
                    <button
                      className="ws-file-row"
                      onClick={() => {
                        const f = files?.find((x) => x.path === entry.path);
                        if (f) {
                          setQueue(null);
                          open(f);
                        }
                      }}
                    >
                      <span className="file-label">
                        <strong>{entry.title ?? entry.path}</strong>
                        <span className="muted small">
                          {" "}
                          {entry.type}
                          {entry.target_id && ` → ${entry.target_id}`}
                          {entry.approvals > 0 && ` ✓${entry.approvals}`}
                          {entry.rejections > 0 && ` ✗${entry.rejections}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {queue === null && (
          <>
          <div className="search-row">
            <input
              className="search-input"
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
          {searchResults !== null && (
            <div className="search-results">
              <div className="header-row tight">
                <strong className="small muted">{searchResults.length} results</strong>
                <button
                  className="link-btn"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults(null);
                  }}
                >
                  Clear
                </button>
              </div>
              <ul className="ws-files">
                {searchResults.map((r) => (
                  <li key={r.doc_id}>
                    <button
                      className="ws-file-row"
                      onClick={() => {
                        const entry = files?.find((f) => f.path === r.path);
                        if (entry) open(entry);
                      }}
                    >
                      <span className="file-label">
                        <strong>{r.title ?? r.path}</strong>
                        <span
                          className="muted small"
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: snippet from FTS5 — server-emitted, safe markup
                          dangerouslySetInnerHTML={{ __html: ` ${r.snippet}` }}
                        />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {searchResults === null && (
          <>
          <div className="header-row tight">
            <strong>Files</strong>
            <button onClick={() => setCreating((v) => !v)}>{creating ? "−" : "+"}</button>
          </div>
          {creating && (
            <form className="inline-form tight" onSubmit={create}>
              <input
                placeholder="path/to/note.md"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                autoFocus
              />
              <button type="submit">Add</button>
            </form>
          )}
          {files === null && <div className="muted padded">Loading...</div>}
          {files && files.length === 0 && <div className="muted padded">No files yet.</div>}
          <ul className="ws-files">
            {files?.map((f) => (
              <li key={f.path}>
                <button
                  className={`ws-file-row ${f.path === openPath ? "active" : ""}`}
                  onClick={() => open(f)}
                  title={f.doc?.id ? `id: ${f.doc.id}` : "unindexed"}
                >
                  <span className="file-label">{f.doc?.title ?? f.path}</span>
                  {f.doc && (
                    <span className={`badge badge-${f.doc.status}`}>{f.doc.status}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          </>
          )}
          </>
          )}
        </aside>
        <main className="ws-main">
          {!openPath && (
            <div className="empty-state muted">Select a file from the sidebar, or create one.</div>
          )}
          {openPath && (
            <>
              <div className="editor-bar">
                <strong>{openPath}</strong>
                {openDoc && <span className={`badge badge-${openDoc.status}`}>{openDoc.status}</span>}
                {dirty && <span className="dirty">●</span>}
                <span className="spacer" />
                <span className="muted small">{status ?? ""}</span>
                <button
                  onClick={() => setEditorMode((m) => (m === "rich" ? "source" : "rich"))}
                  title={editorMode === "rich" ? "Switch to source mode" : "Switch to rich mode"}
                >
                  {editorMode === "rich" ? "Source" : "Rich"}
                </button>
                {openDoc?.status === "draft" && (
                  <button onClick={submitDoc} disabled={dirty || busy}>
                    Submit
                  </button>
                )}
                {openDoc?.status === "unreviewed" &&
                  (workspace.role === "owner" || workspace.role === "verifier") && (
                    <>
                      <input
                        className="text-input"
                        placeholder="Comment (optional)"
                        value={reviewComment}
                        onChange={(e) => setReviewComment(e.target.value)}
                      />
                      <button onClick={() => decideDoc("approve")} disabled={busy}>
                        Approve
                      </button>
                      <button onClick={() => decideDoc("reject")} disabled={busy}>
                        Reject
                      </button>
                    </>
                  )}
                {openDoc?.status === "golden" && openDoc.type === "page" && (
                  <button onClick={() => setProposeOpen((v) => !v)}>
                    {proposeOpen ? "Cancel proposal" : "Propose update"}
                  </button>
                )}
                <button onClick={save} disabled={!dirty || busy}>
                  Save
                </button>
              </div>
              {proposeOpen && (
                <div className="propose-form">
                  <div className="muted small">
                    Propose a replacement body for <strong>{openDoc?.title ?? openPath}</strong>.
                    Don't include frontmatter — only the body.
                  </div>
                  <textarea
                    value={proposalBody}
                    onChange={(e) => setProposalBody(e.target.value)}
                    placeholder="# Updated title\n\nNew content..."
                  />
                  <div className="header-row tight">
                    <button onClick={submitProposal} disabled={!proposalBody.trim()}>
                      Create proposal
                    </button>
                  </div>
                </div>
              )}
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
                <ApprovalsPanel approvals={approvals} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
