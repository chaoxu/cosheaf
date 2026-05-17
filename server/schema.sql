-- Cosheaf sidecar schema (Forgejo backend).

-- Cosheaf usernames are identical to Forgejo usernames; there's no separate
-- cosheaf password. Login validates against Forgejo by exchanging the user's
-- Forgejo credentials for a per-user PAT, which is then encrypted at rest.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  forgejo_token_ciphertext BLOB,  -- AES-256-GCM(SESSION_SECRET) over the PAT
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Cosheaf-side API tokens were removed. API clients should use Forgejo PATs
-- directly as `Authorization: Bearer <token>`.
DROP TABLE IF EXISTS tokens;

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  forgejo_repo TEXT NOT NULL,
  default_md_format TEXT NOT NULL DEFAULT 'forgejo-passthrough',
  created_at INTEGER NOT NULL
);

-- Memberships: removed. Role and access are sourced from Forgejo's
-- collaborator-permission API; middleware queries Forgejo and caches.

-- Page identity. Pages are the only document kind cosheaf indexes today;
-- additional kinds (if ever) get their own tables, not a polymorphic column.
CREATE TABLE IF NOT EXISTS doc_map (
  cosheaf_id TEXT NOT NULL,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  forgejo_id TEXT NOT NULL,  -- repo-relative path of the markdown file
  title TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, cosheaf_id),
  UNIQUE (workspace_id, forgejo_id)
);

-- Pre-existing DBs may have legacy target_id / author_user_id columns and
-- idx_doc_map_target / idx_doc_map_type; both unused since the page-only refactor.
DROP INDEX IF EXISTS idx_doc_map_target;
DROP INDEX IF EXISTS idx_doc_map_type;

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  workspace_id UNINDEXED,
  cosheaf_id UNINDEXED,
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
  line INTEGER,
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

-- Issues were previously mirrored in `issues` / `issue_assignees`; removed
-- because Forgejo's repo-scoped /issues already supports the same filters
-- and the mirror kept drifting on partial webhook deliveries.

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
