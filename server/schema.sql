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

-- Memberships: removed. Role and access are sourced from Forgejo's
-- collaborator-permission API; middleware queries Forgejo and caches.

CREATE TABLE IF NOT EXISTS doc_map (
  cosheaf_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  forgejo_kind TEXT NOT NULL,
  forgejo_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, cosheaf_id),
  UNIQUE (workspace_id, forgejo_kind, forgejo_id)
);

-- Pre-existing DBs may have legacy target_id / author_user_id columns and
-- idx_doc_map_target; both unused since pre-changes refactor.
DROP INDEX IF EXISTS idx_doc_map_target;
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

-- Branches and pull requests: removed. They live on Forgejo as their natural
-- representation. The server reads them on demand via the Forgejo client and
-- relies on push/PR/review webhooks only for cache invalidation (page
-- reindex on push; issue mirror on issue events). No SQLite workflow state.

-- Issues mirror Forgejo issues. They live alongside branches in the same
-- Forgejo repo; here we cache the metadata for fast listing + author/assignee
-- lookups. Bodies and comments are fetched on demand from Forgejo.
CREATE TABLE IF NOT EXISTS issues (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  forgejo_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  author_user_id INTEGER REFERENCES users(id),
  author_login TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]', -- JSON array of label names
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_state ON issues (workspace_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_author ON issues (workspace_id, author_user_id, state);

CREATE TABLE IF NOT EXISTS issue_assignees (
  workspace_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, number, user_id)
);
CREATE INDEX IF NOT EXISTS idx_issue_assignees_user ON issue_assignees (user_id, workspace_id);

-- Audit log for the Forgejo passthrough escape hatch. One row per
-- /api/v1/w/{slug}/forgejo/... call. We log the request shape and outcome
-- only; bodies are intentionally omitted (size + cross-agent privacy).
CREATE TABLE IF NOT EXISTS forgejo_passthrough_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query TEXT,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passthrough_log_workspace ON forgejo_passthrough_log (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_passthrough_log_user ON forgejo_passthrough_log (user_id, created_at DESC);
