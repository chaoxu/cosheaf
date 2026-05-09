PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'verifier', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);

CREATE TABLE IF NOT EXISTS documents (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('page', 'review', 'proposal')),
  status TEXT NOT NULL CHECK (status IN ('golden', 'unreviewed', 'rejected', 'draft', 'archived')),
  target_id TEXT,
  title TEXT,
  mtime INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, path)
);

CREATE INDEX IF NOT EXISTS documents_status ON documents(workspace_id, status);
CREATE INDEX IF NOT EXISTS documents_target ON documents(workspace_id, target_id);

CREATE TABLE IF NOT EXISTS links (
  workspace_id INTEGER NOT NULL,
  src_id TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT NOT NULL,
  FOREIGN KEY (workspace_id, src_id)
    REFERENCES documents(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS links_target ON links(workspace_id, target_id);
CREATE INDEX IF NOT EXISTS links_src ON links(workspace_id, src_id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  workspace_id UNINDEXED,
  doc_id UNINDEXED,
  path UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  min_approvals INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS approvals (
  workspace_id INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  verifier_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, document_id, verifier_user_id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS approvals_doc ON approvals(workspace_id, document_id);
