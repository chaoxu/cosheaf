-- Cosheaf sidecar schema (Forgejo backend).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  forgejo_username TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  forgejo_repo TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'verifier', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS doc_map (
  cosheaf_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  forgejo_kind TEXT NOT NULL,
  forgejo_id TEXT NOT NULL,
  target_id TEXT,
  title TEXT,
  author_user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, cosheaf_id),
  UNIQUE (workspace_id, forgejo_kind, forgejo_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_map_target ON doc_map (workspace_id, target_id);
CREATE INDEX IF NOT EXISTS idx_doc_map_type ON doc_map (workspace_id, doc_type);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  workspace_id UNINDEXED,
  cosheaf_id UNINDEXED,
  doc_type UNINDEXED,
  path,
  title,
  body,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS backlinks (
  workspace_id INTEGER NOT NULL,
  src_id TEXT NOT NULL,
  src_path TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT NOT NULL,
  PRIMARY KEY (workspace_id, src_id, target_label)
);
CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (workspace_id, target_id);

CREATE TABLE IF NOT EXISTS page_tags (
  workspace_id INTEGER NOT NULL,
  cosheaf_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (workspace_id, cosheaf_id, tag)
);

CREATE TABLE IF NOT EXISTS webhook_log (
  delivery_id TEXT PRIMARY KEY,
  delivered_at INTEGER NOT NULL,
  event_type TEXT NOT NULL
);

-- Unified change primitive: replaces working/<user> branches and revision/<id>
-- branches with a single change/<id> namespace. Lifecycle: draft → review →
-- changes_requested → review → merged, or closed terminal state.
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_user_id INTEGER NOT NULL REFERENCES users(id),
  branch_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'review', 'changes_requested', 'merged', 'closed')),
  pr_number INTEGER,
  base_sha TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_workspace_state ON changes (workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_changes_author_state ON changes (workspace_id, author_user_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_changes_branch ON changes (workspace_id, branch_name);
CREATE INDEX IF NOT EXISTS idx_changes_pr ON changes (workspace_id, pr_number);
