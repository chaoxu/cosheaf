import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type FileEntry, type User, type Workspace } from "./api";
import { MarkdownEditor } from "./editor";

type View =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "workspaces"; user: User }
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
  const [content, setContent] = useState("");
  const [mtime, setMtime] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");

  const reloadTree = useCallback(() => {
    api
      .tree(workspace.slug)
      .then(setFiles)
      .catch((err: unknown) =>
        setStatus(err instanceof ApiError ? err.message : "Failed to load tree"),
      );
  }, [workspace.slug]);

  useEffect(reloadTree, [reloadTree]);

  const open = useCallback(
    (path: string) => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setBusy(true);
      setStatus(null);
      api
        .getNote(workspace.slug, path)
        .then((r) => {
          setOpenPath(path);
          setContent(r.content);
          setMtime(r.mtime);
          setDirty(false);
        })
        .catch((err: unknown) =>
          setStatus(err instanceof ApiError ? err.message : "Failed to open"),
        )
        .finally(() => setBusy(false));
    },
    [dirty, workspace.slug],
  );

  const save = useCallback(() => {
    if (!openPath) return;
    setBusy(true);
    setStatus(null);
    api
      .putNote(workspace.slug, openPath, content, mtime ?? undefined)
      .then((r) => {
        setMtime(r.mtime);
        setDirty(false);
        setStatus("saved");
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
        setContent(`# ${path.replace(/\.md$/, "")}\n`);
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
        <span className="muted">{user.username}</span>
        <button className="link-btn" onClick={handleLogout}>
          Sign out
        </button>
      </header>
      <div className="ws-layout">
        <aside className="ws-sidebar">
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
                  onClick={() => open(f.path)}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="ws-main">
          {!openPath && (
            <div className="empty-state muted">Select a file from the sidebar, or create one.</div>
          )}
          {openPath && (
            <>
              <div className="editor-bar">
                <strong>{openPath}</strong>
                {dirty && <span className="dirty">●</span>}
                <span className="spacer" />
                <span className="muted small">{status ?? ""}</span>
                <button onClick={save} disabled={!dirty || busy}>
                  Save
                </button>
              </div>
              <MarkdownEditor
                value={content}
                onChange={(next) => {
                  setContent(next);
                  setDirty(true);
                  setStatus(null);
                }}
                onSave={() => {
                  if (dirty && !busy) save();
                }}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
