-- Cosheaf sidecar schema (Forgejo backend).

-- #63: cosheaf no longer stores any auth state. The SPA holds the user's
-- Forgejo PAT in localStorage and sends it as `Authorization: Bearer <pat>`
-- on every request; agents do the same. There is no users table, no
-- sessions table, no cosheaf-issued token table — the PAT is the credential.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tokens;

-- Workspaces table removed (#62). The workspace slug IS the Forgejo
-- repository name (#60), display name comes from the Forgejo repo
-- description (#61), and the workspace's default markdown format lives in
-- a Forgejo repo topic (`cosheaf-format-coflat` present → coflat,
-- otherwise → forgejo-passthrough). Sidecar tables key off the slug
-- directly (`workspace_slug TEXT`); legacy `workspace_id INTEGER` columns
-- are migrated in db.ts before this schema runs.

-- Memberships: removed. Role and access are sourced from Forgejo's
-- collaborator-permission API; middleware queries Forgejo and caches.

-- Page identity. Pages are the only document kind cosheaf indexes today;
-- additional kinds (if ever) get their own tables, not a polymorphic column.
CREATE TABLE IF NOT EXISTS doc_map (
  cosheaf_id TEXT NOT NULL,
  workspace_slug TEXT NOT NULL,
  forgejo_id TEXT NOT NULL,  -- repo-relative path of the markdown file
  title TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_slug, cosheaf_id),
  UNIQUE (workspace_slug, forgejo_id)
);

-- Pre-existing DBs may have legacy target_id / author_user_id columns and
-- idx_doc_map_target / idx_doc_map_type; both unused since the page-only refactor.
DROP INDEX IF EXISTS idx_doc_map_target;
DROP INDEX IF EXISTS idx_doc_map_type;

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  workspace_slug UNINDEXED,
  cosheaf_id UNINDEXED,
  path,
  title,
  body,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS backlinks (
  workspace_slug TEXT NOT NULL,
  src_id TEXT NOT NULL,
  src_path TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (workspace_slug, src_id, target_label)
);
CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks (workspace_slug, target_id);

CREATE TABLE IF NOT EXISTS page_tags (
  workspace_slug TEXT NOT NULL,
  cosheaf_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (workspace_slug, cosheaf_id, tag)
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

-- forgejo_passthrough_log audit table was dropped in #59. Forgejo's own
-- access logging covers passthrough calls; the cosheaf-side mirror was
-- duplicate state with no SPA consumer.
